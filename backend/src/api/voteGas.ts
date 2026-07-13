import { ethers } from "ethers";
import { query } from "../db/pool.js";
import { config } from "../config/index.js";

// The Zero Cup vote-gas faucet.
//
// Boosting a vote on 0G's own site costs mainnet gas, and almost nobody arriving from a tweet
// has any. So Zerun sends each voter a whisper of real 0G, once, and eats the cost. That makes
// this the only endpoint in the app that gives away real money to an unauthenticated caller,
// and every guard below exists because of that sentence.
//
//   - ONE claim per wallet, forever. `address` is the primary key of vote_gas_claims.
//   - A hard campaign budget. When the table's total reaches it, the faucet closes itself.
//   - An in-process lock, so two concurrent requests for one wallet cannot both pass the
//     "already claimed?" check before either has written its row.
//   - The row is written BEFORE the transfer and deleted if the transfer throws, so a failed
//     send never locks a voter out, and a slow one can never pay twice.
//   - Off by default. It needs VOTE_GAS=on and a funded mainnet key, or it is a no-op.
//
// The amount is deliberately tiny: enough for one boost transaction, worth nothing to a farmer.

const ENABLED = (process.env.VOTE_GAS ?? "off").toLowerCase() === "on";

// The Zero Cup vote contract on 0G mainnet, and the one call that matters.
//   castVote(bytes32 candidateId, uint256 weight)   selector 0xb4b0713e
// A wallet may vote exactly once: a second castVote reverts with an already-voted guard
// (custom error 0xb037ef51). We use that fact below as a fundability oracle — see canStillVote.
const CONTRACT = process.env.ZERO_CUP_CONTRACT ?? "0x46bB4fFd3F61d59126ca1814B7c57FFF1db0a65B";
const VOTE_SELECTOR = "0xb4b0713e";
const ZERUN_CANDIDATE = process.env.ZERO_CUP_ZERUN ?? "0xcca28a9fddc8ecbee7b1bb4b6b2ee4968e8d1b63182d1989ea2607d20d425f4c";

// Refuse to fund a wallet that has already voted. It literally cannot vote again, so the gas is
// wasted on it — that is the single biggest leak, since re-claimers and the opposition's own
// voters all land here. On by default; flip off if the RPC oracle ever misbehaves.
const SKIP_VOTED = (process.env.VOTE_GAS_SKIP_VOTED ?? "on").toLowerCase() === "on";

/** What one voter receives. A boost costs a fraction of this; the rest is slack for gas spikes.
 * When gas spikes, raise this so one claim still covers a boost. */
const AMOUNT_OG = process.env.VOTE_GAS_AMOUNT_OG ?? "0.003";

// The balance at or above which a wallet is treated as "already funded": it holds enough mainnet
// 0G to boost, so it needs no credit, the page sends it straight to the ballot and the faucet
// refuses it. Set well below AMOUNT_OG so a wallet we just funded reads as funded, and above a
// single boost's gas so a genuinely empty wallet does not. This is what lets a returning voter who
// still has last round's gas skip the claim, while one who spent it gets a fresh top-up.
const FUNDED_THRESHOLD_OG = process.env.VOTE_GAS_FUNDED_OG ?? "0.0008";

// Reopen switch. When gas spikes, the amount people claimed earlier can stop being enough for a
// boost, yet those wallets are refused because their old balance still clears the funded line above.
// Turn this ON to reopen top-ups for everyone: a wallet counts as funded only once it holds a FULL
// claim's worth (AMOUNT_OG), so anyone below that, including earlier claimers, can claim again and
// be topped up to the new amount. Turn it OFF to go back to the tight funded line. Pair it with a
// higher VOTE_GAS_AMOUNT_OG (to cover the spike) and VOTE_GAS_BUDGET_OG (the extra claims cost more).
const REOPEN = (process.env.VOTE_GAS_REOPEN ?? "off").toLowerCase() === "on";

/** The whole campaign's ceiling. At 0.003 0G a claim, 3 0G funds a thousand voters. Raise it when
 * you reopen top-ups, since re-claims spend from the same pool. */
const BUDGET_OG = process.env.VOTE_GAS_BUDGET_OG ?? "3";

/** Mainnet, because that is where the vote lives. Falls back to the compute mainnet RPC. */
const RPC = process.env.VOTE_GAS_RPC_URL || config.compute.mainnet.rpcUrl;
const SIGNER_KEY = process.env.VOTE_GAS_PRIVATE_KEY || config.compute.mainnet.signerKey;

const SEND_TIMEOUT_MS = Number(process.env.VOTE_GAS_TIMEOUT_MS ?? "60000");

export interface VoteGasStatus {
  enabled: boolean;
  amountOg: string;
  claimed: boolean;
  txHash: string | null;
  /** Claims still fundable under the campaign budget. 0 means the faucet has closed. */
  remainingClaims: number;
  /** This wallet has already voted and can never vote again. The whole flow is moot for it. */
  alreadyVoted: boolean;
  /** This wallet already holds enough mainnet gas to boost, so it needs no credit — the page
   * blurs the claim and sends it straight to the ballot. */
  hasEnoughGas: boolean;
  /** The wallet's mainnet 0G balance, for the UI and for debugging the gate. "0" when unknown. */
  balanceOg: string;
}

export function voteGasConfigured(): boolean {
  return ENABLED && Boolean(RPC && SIGNER_KEY);
}

const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

// A short-lived cache so polling the page (or two endpoints on one request) does not fire an
// eth_call at 0G's RPC every time. Vote state only ever flips once, from "can" to "cannot".
const oracleCache = new Map<string, { canVote: boolean; at: number }>();
const ORACLE_TTL_MS = Number(process.env.VOTE_GAS_ORACLE_TTL_MS ?? "30000");

/**
 * Can this wallet still cast a vote? Simulate castVote(Zerun, boost) with eth_call — no gas, no
 * transaction, nothing sent.
 *   - success  -> the wallet has not voted and the poll is open: true (worth funding).
 *   - revert   -> the already-voted guard fired (or the poll closed): false (do not fund).
 *   - RPC/network error -> unknown: null. We FAIL OPEN, because blocking a real new voter over a
 *     flaky RPC costs a vote, while funding one extra dead wallet costs a fraction of a cent.
 */
async function canStillVote(address: string): Promise<boolean | null> {
  if (!RPC) return null;
  const key = address.toLowerCase();
  const hit = oracleCache.get(key);
  if (hit && Date.now() - hit.at < ORACLE_TTL_MS) return hit.canVote;

  const data = VOTE_SELECTOR + pad32(ZERUN_CANDIDATE) + pad32("0x2");
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    await provider.call({ from: address, to: CONTRACT, data });
    oracleCache.set(key, { canVote: true, at: Date.now() });
    return true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // A revert means the node executed the call and the contract rejected it — the definite
    // "cannot vote" signal. A transport failure is not a revert and must not lock anyone out.
    const isRevert = e?.code === "CALL_EXCEPTION" || /execution reverted|revert/i.test(e?.message ?? "");
    if (isRevert) {
      oracleCache.set(key, { canVote: false, at: Date.now() });
      return false;
    }
    return null;
  }
}

const amountWei = () => ethers.parseEther(AMOUNT_OG);
const budgetWei = () => ethers.parseEther(BUDGET_OG);
// The balance at or above which a wallet is "funded" and needs no credit. Normally the tight
// threshold; with the reopen switch on, a full claim's worth, so earlier claimers below it can top
// up after a gas spike. Both the status read and the claim gate use this, so the UI and the faucet
// always agree on who still needs gas.
const fundedFloorWei = () => (REOPEN ? amountWei() : ethers.parseEther(FUNDED_THRESHOLD_OG));

// The wallet's live mainnet balance, briefly cached. Read alongside the vote oracle so a returning
// voter with leftover gas is recognised and sent straight to the ballot instead of re-funded.
const balanceCache = new Map<string, { wei: bigint; at: number }>();
async function balanceOf(address: string): Promise<bigint | null> {
  if (!RPC) return null;
  const key = address.toLowerCase();
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < ORACLE_TTL_MS) return hit.wei;
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wei = await provider.getBalance(address);
    balanceCache.set(key, { wei, at: Date.now() });
    return wei;
  } catch {
    return null;
  }
}

/** Total real 0G this campaign has committed, in flight or settled. */
async function spentWei(): Promise<bigint> {
  const { rows } = await query<{ sum: string }>(
    "select coalesce(sum(amount_wei), 0)::text as sum from vote_gas_claims",
  );
  return BigInt(rows[0]?.sum ?? "0");
}

// The wallet's most recent claim, if any. Multi-row now (one per round), so take the latest.
async function claimOf(address: string): Promise<{ tx_hash: string | null } | null> {
  const { rows } = await query<{ tx_hash: string | null }>(
    "select tx_hash from vote_gas_claims where address = $1 order by id desc limit 1",
    [address],
  );
  return rows[0] ?? null;
}

export function isAddress(a: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(a);
}

export async function voteGasStatus(address: string): Promise<VoteGasStatus> {
  const left = budgetWei() - (await spentWei());
  const per = amountWei();
  const claim = isAddress(address) ? await claimOf(address) : null;
  // Only worth the RPC round-trips once there is a real wallet to ask about.
  const canVote = isAddress(address) ? await canStillVote(address) : null;
  const bal = isAddress(address) ? await balanceOf(address) : null;
  return {
    enabled: voteGasConfigured(),
    amountOg: AMOUNT_OG,
    claimed: Boolean(claim),
    txHash: claim?.tx_hash ?? null,
    remainingClaims: left > 0n ? Number(left / per) : 0,
    alreadyVoted: canVote === false,
    hasEnoughGas: bal !== null && bal >= fundedFloorWei(),
    balanceOg: bal !== null ? ethers.formatEther(bal) : "0",
  };
}

// One wallet cannot have two sends racing each other through the "already claimed?" gate.
const inFlight = new Set<string>();

export type ClaimResult = { ok: true; txHash: string; amountOg: string } | { ok: false; status: number; error: string };

export async function claimVoteGas(address: string): Promise<ClaimResult> {
  if (!voteGasConfigured()) return { ok: false, status: 503, error: "the gas faucet is closed right now" };
  if (!isAddress(address)) return { ok: false, status: 400, error: "a valid wallet address is required" };

  if (inFlight.has(address)) return { ok: false, status: 429, error: "a claim is already in progress for this wallet" };
  inFlight.add(address);
  try {
    // The anti-double-fund guard is the live balance, not the claim history: a wallet that already
    // holds enough gas to boost is refused (it needs nothing, and the page will send it to the
    // ballot), while a returning voter who spent last round's gas, or is short after a spike with
    // the reopen switch on, is allowed a fresh top-up.
    const bal = await balanceOf(address);
    if (bal !== null && bal >= fundedFloorWei()) {
      return {
        ok: false,
        status: 409,
        error: "this wallet already has enough gas to boost. Head to the ballot and boost Zerun.",
      };
    }

    // Do not fund a wallet that can no longer vote. A revert from the oracle is a certain "already
    // voted"; an unknown (RPC down) fails open, so a flaky node never blocks a genuine new voter.
    if (SKIP_VOTED && (await canStillVote(address)) === false) {
      return {
        ok: false,
        status: 409,
        error: "this wallet has already voted, so it cannot vote again. Please save the gas for a new voter.",
      };
    }

    const per = amountWei();
    if ((await spentWei()) + per > budgetWei()) {
      return { ok: false, status: 503, error: "the gas faucet has run dry. Thanks for voting anyway." };
    }

    // Reserve first, as its own row. If the send throws we delete THIS row (by id), so a failure
    // never costs the voter their claim, and a slow send can never be paid twice.
    const { rows: reserved } = await query<{ id: string }>(
      "insert into vote_gas_claims (address, amount_wei) values ($1, $2) returning id",
      [address, per.toString()],
    );
    const claimId = reserved[0]!.id;

    // Broadcasting and confirming are two different things, and confusing them here would cost
    // real money. Once `sendTransaction` returns a hash the 0G has left our wallet, so the hash
    // is written IMMEDIATELY. Only a failure to broadcast rolls the reservation back.
    let tx: ethers.TransactionResponse;
    try {
      const provider = new ethers.JsonRpcProvider(RPC);
      const wallet = new ethers.Wallet(SIGNER_KEY, provider);
      tx = await wallet.sendTransaction({ to: address, value: per });
    } catch (err) {
      // Nothing was sent: delete exactly this reservation, so the voter keeps any prior claim.
      await query("delete from vote_gas_claims where id = $1 and tx_hash is null", [claimId]).catch(() => {});
      console.error(`vote gas: transfer to ${address} failed to broadcast:`, (err as Error).message);
      return { ok: false, status: 502, error: "the transfer did not go through. Try again in a moment." };
    }
    await query("update vote_gas_claims set tx_hash = $2 where id = $1", [claimId, tx.hash]).catch(() => {});
    // The wallet is funded now; drop the cached balance so the next status read reflects it.
    balanceCache.delete(address.toLowerCase());

    // Confirmation is a nicety. If the RPC stalls we still succeeded: deleting the row here
    // would hand this wallet a second claim for gas it has already been paid.
    try {
      await Promise.race([
        tx.wait(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the transfer")), SEND_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn(`vote gas: ${tx.hash} sent to ${address} but not confirmed yet:`, (err as Error).message);
    }
    console.log(`vote gas: sent ${AMOUNT_OG} 0G to ${address} (${tx.hash})`);
    return { ok: true, txHash: tx.hash, amountOg: AMOUNT_OG };
  } finally {
    inFlight.delete(address);
  }
}
