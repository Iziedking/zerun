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

/** What one voter receives. A boost costs a fraction of this; the rest is slack for gas spikes. */
const AMOUNT_OG = process.env.VOTE_GAS_AMOUNT_OG ?? "0.003";

/** The whole campaign's ceiling. At 0.003 0G a claim, 3 0G funds a thousand voters. */
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
}

export function voteGasConfigured(): boolean {
  return ENABLED && Boolean(RPC && SIGNER_KEY);
}

const amountWei = () => ethers.parseEther(AMOUNT_OG);
const budgetWei = () => ethers.parseEther(BUDGET_OG);

/** Total real 0G this campaign has committed, in flight or settled. */
async function spentWei(): Promise<bigint> {
  const { rows } = await query<{ sum: string }>(
    "select coalesce(sum(amount_wei), 0)::text as sum from vote_gas_claims",
  );
  return BigInt(rows[0]?.sum ?? "0");
}

async function claimOf(address: string): Promise<{ tx_hash: string | null } | null> {
  const { rows } = await query<{ tx_hash: string | null }>(
    "select tx_hash from vote_gas_claims where address = $1",
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
  return {
    enabled: voteGasConfigured(),
    amountOg: AMOUNT_OG,
    claimed: Boolean(claim),
    txHash: claim?.tx_hash ?? null,
    remainingClaims: left > 0n ? Number(left / per) : 0,
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
    const existing = await claimOf(address);
    if (existing) {
      return { ok: false, status: 409, error: "this wallet has already claimed. One claim per wallet." };
    }
    const per = amountWei();
    if ((await spentWei()) + per > budgetWei()) {
      return { ok: false, status: 503, error: "the gas faucet has run dry. Thanks for voting anyway." };
    }

    // Reserve first. If the send throws we delete this row, so a failure never costs the voter
    // their one claim, and a slow send can never be paid twice.
    await query("insert into vote_gas_claims (address, amount_wei) values ($1, $2)", [address, per.toString()]);

    // Broadcasting and confirming are two different things, and confusing them here would cost
    // real money. Once `sendTransaction` returns a hash the 0G has left our wallet, so the hash
    // is written IMMEDIATELY. Only a failure to broadcast rolls the reservation back.
    let tx: ethers.TransactionResponse;
    try {
      const provider = new ethers.JsonRpcProvider(RPC);
      const wallet = new ethers.Wallet(SIGNER_KEY, provider);
      tx = await wallet.sendTransaction({ to: address, value: per });
    } catch (err) {
      // Nothing was sent: give the voter their claim back.
      await query("delete from vote_gas_claims where address = $1 and tx_hash is null", [address]).catch(() => {});
      console.error(`vote gas: transfer to ${address} failed to broadcast:`, (err as Error).message);
      return { ok: false, status: 502, error: "the transfer did not go through. Try again in a moment." };
    }
    await query("update vote_gas_claims set tx_hash = $2 where address = $1", [address, tx.hash]).catch(() => {});

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
