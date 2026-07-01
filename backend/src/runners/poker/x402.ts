import { parseEventLogs } from "viem";
import { query } from "../../db/pool.js";
import {
  GAS_PRICE,
  coordinatorAccount,
  coordinatorAddress,
  coordinatorWallet,
  loadDeployment,
  publicClient,
  testUsdcAbi,
  waitReceipt,
} from "../../chain/contracts.js";
import { buildDossier } from "./dossier.js";

// x402 micropayments for opponent dossiers, on 0G. The Coinbase-hosted facilitator
// does not support 0G Galileo, so this implements the x402 flow natively: a dossier
// request over the free allotment gets an HTTP 402 with payment requirements, the
// caller pays testUSDC on 0G, and this module acts as the self-hosted facilitator
// that verifies the on-chain payment before the dossier is served.
//
// Free allotment by compute level (the 0G investment): level 5 gets 3 free reads,
// level 4 two, level 3 one, below that none. Beyond that, each read is paid.

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

// The coordinator settles a payment on behalf of a house agent (the demo path). Mints
// the price to itself if short, then transfers it to payTo, returning the payment tx.
async function coordinatorPay(): Promise<`0x${string}`> {
  const dep = loadDeployment();
  const me = coordinatorAddress();
  const bal = (await publicClient.readContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "balanceOf",
    args: [me],
  })) as bigint;
  if (bal < PRICE_ATOMIC) {
    const mintHash = await coordinatorWallet().writeContract({
      address: dep.testUSDC,
      abi: testUsdcAbi,
      functionName: "mint",
      args: [me, PRICE_ATOMIC],
      account: coordinatorAccount(),
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(mintHash);
  }
  const hash = await coordinatorWallet().writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "transfer",
    args: [payTo(), PRICE_ATOMIC],
    account: coordinatorAccount(),
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await waitReceipt(hash);
  return hash;
}

export interface DossierAccess {
  text: string | null; // the scouting report, or null if the opponent has no history
  paid: boolean; // whether this read required an x402 payment
  txHash?: string; // the payment tx, when paid
  priceUsdc?: string; // the price paid, for the feed
}

// Acquire the opponent's dossier for an agent, honoring the free allotment and paying
// via x402 (coordinator-settled for house agents) when the allotment is used up. Used
// by the runner to prefetch before the clock starts.
export async function acquireDossier(
  requesterId: number,
  requesterLevel: number,
  opponentId: number,
): Promise<DossierAccess> {
  const d = await buildDossier(opponentId);
  if (!d) return { text: null, paid: false };

  const allot = freeAllotment(requesterLevel);
  const used = await freeUsed(requesterId);
  if (used < allot) {
    await consumeFree(requesterId);
    return { text: d.text, paid: false };
  }

  const txHash = await coordinatorPay();
  const ok = await verifyPaymentTx(txHash);
  if (!ok) return { text: null, paid: false }; // unverified payment: play without the edge
  return { text: d.text, paid: true, txHash, priceUsdc: PRICE_USDC };
}
