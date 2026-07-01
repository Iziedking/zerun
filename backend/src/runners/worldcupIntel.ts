import { parseEventLogs } from "viem";
import { query } from "../db/pool.js";
import { gatherIntel } from "./intel.js";
import type { WorldCupMarket } from "./worldcup.js";
import {
  GAS_PRICE,
  coordinatorAccount,
  coordinatorAddress,
  coordinatorWallet,
  loadDeployment,
  publicClient,
  testUsdcAbi,
  waitReceipt,
} from "../chain/contracts.js";

// The World Cup intel pack: platform research an agent uses to forecast an event. It
// has two halves, a PRE-BUILT CACHE (history, stats, the pundit read on the subject,
// built once and reused) and a LIVE sentiment pull ("what people are saying now"),
// fetched fresh at forecast time. Access is tiered and paid over x402, mirroring the
// poker dossier market: tier 5 has unlimited research, tier 4 gets 3 free per mission,
// tier 3 one, and tiers 0-2 have no research capability at all. Beyond the free
// allotment each pull is a real testUSDC payment on 0G, coordinator-settled for the
// autonomous field and verifiable on the explorer.

const PRICE_USDC = process.env.X402_INTEL_PRICE_USDC ?? "0.25";
const PRICE_ATOMIC = BigInt(Math.max(0, Math.round(parseFloat(PRICE_USDC) * 1_000_000))); // testUSDC is 6dp
const CACHE_TTL_MS = Number(process.env.WORLDCUP_INTEL_TTL_HOURS ?? "24") * 3600 * 1000;

export function intelPriceUsdc(): string {
  return PRICE_USDC;
}

// Research is a tier-3-and-up capability; tiers 0-2 forecast blind.
export function canResearch(level: number): boolean {
  return level >= 3;
}

// Free intel pulls per mission by 0G investment: tier 5 unlimited, tier 4 three, tier
// 3 one, below that none. Infinity means a top-tier agent never pays.
export function freeAllotment(level: number): number {
  if (level >= 5) return Number.POSITIVE_INFINITY;
  if (level === 4) return 3;
  if (level === 3) return 1;
  return 0;
}

// How many live sentiment sources the tier pulls on top of the cached brief. Higher
// tiers get more current data.
function liveDepth(level: number): number {
  if (level >= 5) return 5;
  if (level === 4) return 3;
  if (level === 3) return 1;
  return 0;
}

// The cached brief for a market: reuse it if fresh, otherwise build it once (from web
// research on the subject) and cache it for every later agent and mission.
async function cachedBrief(market: WorldCupMarket): Promise<string> {
  const { rows } = await query<{ brief: string; age_ms: number }>(
    "select brief, extract(epoch from (now() - updated_at))::bigint * 1000 as age_ms from worldcup_intel where condition_id = $1",
    [market.conditionId],
  );
  if (rows[0] && Number(rows[0].age_ms) < CACHE_TTL_MS) return rows[0].brief;

  const subject = market.groupTitle || market.question;
  const sources = await gatherIntel(`${subject} World Cup history, form, squad, statistics, tournament outlook`, 4);
  const brief = sources
    .map((s, i) => `[${i + 1}] ${s.title}: ${s.text}`)
    .join("\n")
    .slice(0, 1800);
  if (brief) {
    await query(
      `insert into worldcup_intel (condition_id, brief, updated_at) values ($1,$2, now())
         on conflict (condition_id) do update set brief = excluded.brief, updated_at = now()`,
      [market.conditionId, brief],
    );
  }
  return brief;
}

export interface IntelPack {
  text: string;
  sources: number;
}

// Build the tiered intel pack for a market: the cached brief plus a live sentiment
// pull sized to the tier. Returns empty for tiers with no research capability.
export async function buildIntelPack(market: WorldCupMarket, level: number): Promise<IntelPack> {
  if (!canResearch(level)) return { text: "", sources: 0 };

  const brief = await cachedBrief(market);
  const depth = liveDepth(level);
  const live =
    depth > 0
      ? await gatherIntel(`${market.groupTitle || market.question} latest news and prediction`, depth)
      : [];
  const liveText = live
    .map((s, i) => `[live ${i + 1}] ${s.title}: ${s.text}`)
    .join("\n")
    .slice(0, 1600);

  const parts: string[] = [];
  if (brief) parts.push(`Background:\n${brief}`);
  if (liveText) parts.push(`Current sentiment:\n${liveText}`);
  const sources = (brief ? brief.split("\n").filter(Boolean).length : 0) + live.length;
  return { text: parts.join("\n\n"), sources };
}

// The coordinator settles an intel payment (the autonomous path): mint the price if
// short, transfer testUSDC to the treasury, and return the verified tx, or null.
async function coordinatorPay(): Promise<`0x${string}` | null> {
  const dep = loadDeployment();
  const me = coordinatorAddress();
  const to = payTo();
  try {
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
      args: [to, PRICE_ATOMIC],
      account: coordinatorAccount(),
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(hash);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    if (receipt.status !== "success") return null;
    const logs = parseEventLogs({ abi: testUsdcAbi, eventName: "Transfer", logs: receipt.logs });
    const paid = logs.some(
      (l) =>
        l.address.toLowerCase() === dep.testUSDC.toLowerCase() &&
        String(l.args.to).toLowerCase() === to &&
        (l.args.value as bigint) >= PRICE_ATOMIC,
    );
    return paid ? hash : null;
  } catch {
    return null;
  }
}

// Where intel payments go. Set X402_PAY_TO to a treasury; defaults to the coordinator
// (a self-transfer that still emits a verifiable Transfer for the demo).
function payTo(): `0x${string}` {
  const env = process.env.X402_PAY_TO;
  if (env && /^0x[0-9a-fA-F]{40}$/.test(env)) return env.toLowerCase() as `0x${string}`;
  return coordinatorAddress();
}

// Settle one paid intel pull over x402, returning the payment tx or null on failure.
export async function payForIntel(): Promise<{ txHash: string; priceUsdc: string } | null> {
  const hash = await coordinatorPay();
  if (!hash) return null;
  return { txHash: hash, priceUsdc: PRICE_USDC };
}
