import { formatEther, parseEther, parseEventLogs } from "viem";
import { query } from "../../db/pool.js";
import { chargeAgent, spendableWei } from "../memoryMarket.js";
import { decideBuyDossier } from "./scoutDecision.js";
import { coordinatorAddress, loadDeployment, publicClient, testUsdcAbi } from "../../chain/contracts.js";
import { buildDossier, dossierTierCap, revealDossier, type PokerStats } from "./dossier.js";

// The opponent dossier market.
//
// A dossier is sold in TIERS and is never the full picture: an agent can never learn as
// much about an opponent as that opponent knows about itself. How deep it may ever read one
// opponent is capped by its Compute level — 1 tier below level 4, 2 at level 4, 3 at level
// 5 — so 0G buys depth of information as well as depth of thought.
//
// Two ways to buy, and both are real payments:
//
//   In a contest, the agent decides FOR ITSELF on 0G whether the next tier is worth its
//   price, and pays for it out of its own MemoryEscrow balance. The payment unlocks the
//   read, which is x402 as it was always described.
//
//   Over HTTP, a caller gets a 402 with payment requirements and pays testUSDC on 0G. The
//   Coinbase-hosted facilitator does not support 0G Galileo, so this module is the
//   self-hosted facilitator that verifies the payment on chain before serving.
//
// The old free allotment survives only on the HTTP path, for an authenticated owner
// reading their own agent's first tiers.

const NETWORK = "0g-galileo";
const PRICE_USDC = process.env.X402_DOSSIER_PRICE_USDC ?? "0.5";
const PRICE_ATOMIC = BigInt(Math.max(0, Math.round(parseFloat(PRICE_USDC) * 1_000_000))); // testUSDC is 6dp

export function dossierPriceAtomic(): bigint {
  return PRICE_ATOMIC;
}

// Where dossier payments go. Set X402_PAY_TO to a treasury; defaults to the
// coordinator (a self-transfer that still emits a verifiable Transfer for the demo).
function payTo(): `0x${string}` {
  const env = process.env.X402_PAY_TO;
  if (env && /^0x[0-9a-fA-F]{40}$/.test(env)) return env.toLowerCase() as `0x${string}`;
  return coordinatorAddress();
}

export function freeAllotment(level: number): number {
  if (level >= 5) return 3;
  if (level === 4) return 2;
  if (level === 3) return 1;
  return 0;
}

export async function freeUsed(agentId: number): Promise<number> {
  const { rows } = await query<{ dossier_free_used: number }>(
    "select dossier_free_used from agents_meta where agent_id = $1",
    [agentId],
  );
  return rows[0]?.dossier_free_used ?? 0;
}

export async function consumeFree(agentId: number): Promise<void> {
  await query("update agents_meta set dossier_free_used = dossier_free_used + 1 where agent_id = $1", [agentId]);
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown> | null;
}

// The x402 402-response body: which token, how much, to whom, on which network.
export function buildRequirements(resource: string, description: string): {
  x402Version: number;
  accepts: PaymentRequirements[];
} {
  const dep = loadDeployment();
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: PRICE_ATOMIC.toString(),
        resource,
        description,
        mimeType: "application/json",
        payTo: payTo(),
        maxTimeoutSeconds: 120,
        asset: dep.testUSDC,
        extra: { name: "testUSDC", decimals: 6 },
      },
    ],
  };
}

// Decode the X-PAYMENT header (base64 JSON). For this scheme the payload carries the
// txHash of the testUSDC payment on 0G.
export function decodePaymentHeader(header: string): `0x${string}` | null {
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const txHash = json?.payload?.txHash ?? json?.txHash;
    return typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? (txHash as `0x${string}`) : null;
  } catch {
    return null;
  }
}

// Claim a verified payment tx as spent. Returns true only the first time a given
// txHash is presented, so one on-chain payment unlocks exactly one dossier read and
// a captured X-PAYMENT header cannot be replayed for unlimited reads.
export async function consumePaymentTx(
  txHash: `0x${string}`,
  forId: number,
  opponentId: number,
): Promise<boolean> {
  const res = await query<{ tx_hash: string }>(
    `insert into dossier_payments (tx_hash, for_agent, opponent_agent) values ($1,$2,$3)
       on conflict (tx_hash) do nothing returning tx_hash`,
    [txHash.toLowerCase(), forId, opponentId],
  );
  return res.rows.length > 0;
}

// Facilitator: confirm a payment settled on 0G. Reads the receipt and looks for a
// testUSDC Transfer to payTo of at least the price.
export async function verifyPaymentTx(txHash: `0x${string}`): Promise<boolean> {
  const dep = loadDeployment();
  const to = payTo();
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return false;
    const logs = parseEventLogs({ abi: testUsdcAbi, eventName: "Transfer", logs: receipt.logs });
    return logs.some(
      (l) =>
        l.address.toLowerCase() === dep.testUSDC.toLowerCase() &&
        String(l.args.to).toLowerCase() === to &&
        (l.args.value as bigint) >= PRICE_ATOMIC,
    );
  } catch {
    return false;
  }
}

// The 0G price of one dossier tier. Each tier costs more than the last, because each
// reveals more: tier N costs N x the base.
const DOSSIER_BASE_OG = process.env.DOSSIER_PRICE_OG ?? "0.001";
export function dossierPriceWei(tier: number): bigint {
  return parseEther(DOSSIER_BASE_OG) * BigInt(Math.max(1, tier));
}

/** The highest tier this buyer already owns on this opponent (0 = knows nothing). */
export async function purchasedTier(buyerId: number, opponentId: number): Promise<number> {
  const { rows } = await query<{ tier: number }>(
    "select coalesce(max(tier), 0) as tier from dossier_purchases where buyer_agent = $1 and opponent_agent = $2",
    [buyerId, opponentId],
  );
  return rows[0]?.tier ?? 0;
}

/** Record that a buyer now owns `tier` on this opponent. Permanent; idempotent. */
export async function recordDossierPurchase(
  buyerId: number,
  opponentId: number,
  tier: number,
  contestId: number | null,
  amountWei: bigint,
  txHash: string | null,
): Promise<void> {
  await query(
    `insert into dossier_purchases (buyer_agent, opponent_agent, tier, contest_id, amount_wei, charge_tx)
       values ($1,$2,$3,$4,$5,$6)
     on conflict (buyer_agent, opponent_agent, tier) do nothing`,
    [buyerId, opponentId, tier, contestId, amountWei.toString(), txHash],
  );
}

export interface DossierPurchase {
  tier: number;
  priceOg: string;
  txHash: string;
  reason: string;
}

export interface DossierAccess {
  text: string | null; // the scouting report at the tier the buyer owns, or null with no history
  tier: number; // 0 = knows nothing about this opponent
  cap: number; // the most tiers this agent's Compute level allows
  paid: boolean; // whether this contest bought anything
  purchases: DossierPurchase[]; // each tier bought here, with its on-chain payment
  // Structured tendencies, so the buyer can model the opponent mechanically. Withheld
  // below tier 2: a coarse read informs reasoning, it does not drive a policy tweak.
  stats?: PokerStats;
}

/**
 * Acquire an opponent's dossier for an agent, as far as it is willing and able to go.
 *
 * The agent's Compute level caps how many tiers it may ever hold on one opponent (1 below
 * level 4, 2 at level 4, 3 at level 5). Tiers it bought in past contests are kept. For each
 * tier it does not yet own, the agent decides on 0G whether the read is worth the price,
 * and pays for it out of its own MemoryEscrow balance. The payment is what unlocks the
 * read, so this is x402 as it was always described: pay, then receive.
 *
 * House agents are the platform's own, have no escrow, and are given the tier-1 read free.
 * An agent that cannot pay simply knows less, which is the whole point of the market.
 */
export async function acquireDossier(
  requesterId: number,
  requesterLevel: number,
  opponentId: number,
  opts: { contestId: number; isHouse: boolean; opponentName: string },
): Promise<DossierAccess> {
  const cap = dossierTierCap(requesterLevel);
  const d = await buildDossier(opponentId);
  if (!d) return { text: null, tier: 0, cap, paid: false, purchases: [] };

  let tier = await purchasedTier(requesterId, opponentId);

  // The house never buys. It scouts at tier 1 so an empty arena still plays a real game.
  if (opts.isHouse) {
    const t = Math.max(tier, 1);
    return { text: revealDossier(d.stats, t), tier: t, cap, paid: false, purchases: [], ...(t >= 2 ? { stats: d.stats } : {}) };
  }

  const purchases: DossierPurchase[] = [];
  while (tier < cap) {
    const next = tier + 1;
    const price = dossierPriceWei(next);
    const balance = await spendableWei(requesterId);
    if (balance < price) break; // cannot afford it: play with what it knows

    const decision = await decideBuyDossier({
      tier: next,
      cap,
      priceWei: price,
      balanceWei: balance,
      known: tier === 0 ? "nothing" : revealDossier(d.stats, tier),
      opponentName: opts.opponentName,
      tierModelLevel: requesterLevel,
    });
    if (!decision.buy) break;

    const charged = await chargeAgent(requesterId, opts.contestId, `dossier:${next}`, price);
    if (!charged) break; // could not pay: it does not get the read

    await recordDossierPurchase(requesterId, opponentId, next, opts.contestId, price, charged.txHash);
    purchases.push({
      tier: next,
      priceOg: formatEther(price),
      txHash: charged.txHash,
      reason: decision.reason,
    });
    tier = next;
  }

  return {
    text: revealDossier(d.stats, tier),
    tier,
    cap,
    paid: purchases.length > 0,
    purchases,
    // Below tier 2 the buyer has bands, not numbers, and cannot mechanically model anyone.
    ...(tier >= 2 ? { stats: d.stats } : {}),
  };
}
