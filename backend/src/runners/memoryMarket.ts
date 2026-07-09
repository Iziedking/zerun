import { parseEther, formatEther } from "viem";
import { query } from "../db/pool.js";
import {
  coordinatorWallet,
  coordinatorAccount,
  memoryEscrowAbi,
  memoryEscrowAddress,
  ogGalileo,
  publicClient,
  waitReceipt,
  GAS_PRICE,
} from "../chain/contracts.js";

// The memory market. Memory for poker and chess is not a free perk, it is intel the
// platform sells: an agent pays 0G for every 0G call that reasons with its memory.
//
// The rail, and why it is shaped this way:
//
//   An operator funds their agent in MemoryEscrow and grants a bounded, revocable
//   allowance. During a contest the agent's balance is decremented IN MEMORY, once per
//   call. A chess tournament makes hundreds of calls; a transaction each would take hours
//   and cost more gas than the memory. When the contest ends we post ONE charge() for the
//   whole run, which is the on-chain settlement of every debit in it.
//
//   Flushing every contest is not an optimization, it is the security bound. An owner can
//   withdraw at any moment without our permission (that is what non-custodial means), so
//   the platform's exposure to un-collected debits is exactly one contest of calls.
//
// Solver and Analyst memory stays free. Only poker and chess are paid.

export type MemoryKind = "general" | "poker" | "chess";

/** Which contest kinds pay for memory. Solver and Analyst are grandfathered free. */
export function isPaidMemoryKind(kind: string): kind is "poker" | "chess" {
  return kind === "poker" || kind === "chess";
}

/** The memory kind a contest kind reads and writes. Solver and Analyst share one record. */
export function memoryKindFor(contestKind: string): MemoryKind {
  if (contestKind === "poker") return "poker";
  if (contestKind === "chess") return "chess";
  return "general";
}

// What one memory-assisted 0G call costs the agent. Small on purpose: a chess tournament
// is a few hundred calls, so this has to be a fraction of a fraction of a 0G.
const PRICE_PER_CALL_WEI = parseEther(process.env.MEMORY_PRICE_PER_CALL_OG ?? "0.0002");

export function pricePerCallWei(): bigint {
  return PRICE_PER_CALL_WEI;
}

export function memoryMarketConfigured(): boolean {
  return memoryEscrowAddress() !== null;
}

/** What the coordinator may actually spend for this agent right now: min(balance, allowance). */
export async function spendableWei(agentId: number): Promise<bigint> {
  const address = memoryEscrowAddress();
  if (!address) return 0n;
  try {
    return await publicClient.readContract({
      address,
      abi: memoryEscrowAbi,
      functionName: "spendable",
      args: [BigInt(agentId)],
    });
  } catch (err) {
    console.warn(`memory market: spendable(${agentId}) read failed:`, (err as Error).message);
    return 0n;
  }
}

export interface MemoryAccount {
  balanceWei: bigint;
  allowanceWei: bigint;
  spentWei: bigint;
}

export async function accountOf(agentId: number): Promise<MemoryAccount | null> {
  const address = memoryEscrowAddress();
  if (!address) return null;
  try {
    const [balance, allowance, spent] = await publicClient.readContract({
      address,
      abi: memoryEscrowAbi,
      functionName: "accountOf",
      args: [BigInt(agentId)],
    });
    return { balanceWei: balance, allowanceWei: allowance, spentWei: spent };
  } catch (err) {
    console.warn(`memory market: accountOf(${agentId}) read failed:`, (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The per-contest spend session.
// ---------------------------------------------------------------------------

/**
 * One agent's memory budget for one contest. `take()` is synchronous and cheap because it
 * spends a balance already read from chain: the game loop calls it once per move, and no
 * move waits on a transaction or a database write.
 */
export interface MemorySession {
  /** The agent's memory note, or "" when it cannot pay (or has none). */
  readonly hint: string;
  /** True when this agent could pay for at least one call. */
  readonly funded: boolean;
  /**
   * Spend for one memory-assisted call. Returns the hint when the agent can pay, and ""
   * the moment it runs dry, so an unfunded agent plays memoryless rather than failing.
   */
  take(): string;
  /**
   * Give the call back. An agent pays for memory it *used*, so when the 0G call it paid
   * for fails and the engine's fallback plays instead, the charge is reversed. Selling
   * something and not delivering it is theft, however small the amount.
   */
  refund(): void;
  /** Calls paid for so far. */
  readonly calls: number;
  /** Persist the debits and settle them on chain. Never throws. */
  settle(): Promise<void>;
}

/** A session that costs nothing: free kinds, house agents, and agents with no memory. */
export function freeSession(hint: string): MemorySession {
  let calls = 0;
  return {
    hint,
    funded: hint !== "",
    take: () => {
      if (hint) calls += 1;
      return hint;
    },
    refund: () => {
      if (calls > 0) calls -= 1;
    },
    get calls() {
      return calls;
    },
    settle: async () => {},
  };
}

/** A session that cannot spend at all: no hint, no debits. */
export const emptySession: MemorySession = freeSession("");

/**
 * Open a paid session. Reads the agent's spendable 0G once, converts it to a number of
 * calls, and hands the game loop a local budget.
 *
 * A house agent never gets here (it has no owner, no escrow, and no memory), and an agent
 * whose owner has not funded or has revoked gets an empty session and plays memoryless.
 */
export async function openPaidSession(
  agentId: number,
  contestId: number,
  kind: string,
  hint: string,
): Promise<MemorySession> {
  if (!hint || !memoryMarketConfigured()) return emptySession;

  const spendable = await spendableWei(agentId);
  const budgetCalls = Number(spendable / PRICE_PER_CALL_WEI);
  if (budgetCalls <= 0) return emptySession;

  let remaining = budgetCalls;
  let calls = 0;

  return {
    hint,
    funded: true,
    take() {
      if (remaining <= 0) return ""; // out of funds: play on, without memory
      remaining -= 1;
      calls += 1;
      return hint;
    },
    refund() {
      if (calls > 0) {
        calls -= 1;
        remaining += 1;
      }
    },
    get calls() {
      return calls;
    },
    async settle() {
      if (calls === 0) return;
      const amountWei = PRICE_PER_CALL_WEI * BigInt(calls);
      // Record the debt BEFORE trying to collect it. If the charge fails, the row stays
      // unsettled (charge_tx null) and the sweeper can retry; if we recorded after, a
      // crash between charge and insert would take payment we never accounted for.
      let debitId: number | null = null;
      try {
        const { rows } = await query<{ id: string }>(
          "insert into memory_debits (agent_id, contest_id, kind, calls, amount_wei) values ($1,$2,$3,$4,$5) returning id",
          [agentId, contestId, kind, calls, amountWei.toString()],
        );
        debitId = Number(rows[0]!.id);
      } catch (err) {
        console.error(`memory market: could not record debit for agent ${agentId}:`, (err as Error).message);
        return;
      }
      await chargeDebit(debitId, agentId, amountWei);
    },
  };
}

// Settle one recorded debit on chain. Bounded by what the owner still authorizes: if they
// withdrew or revoked mid-contest the charge reverts, and we leave the row unsettled and
// move on. That is the cost of letting an owner leave whenever they want, and it is capped
// at one contest of calls.
async function chargeDebit(debitId: number, agentId: number, amountWei: bigint): Promise<void> {
  const address = memoryEscrowAddress();
  if (!address) return;

  const spendable = await spendableWei(agentId);
  if (spendable < amountWei) {
    console.warn(
      `memory market: agent ${agentId} owes ${formatEther(amountWei)} 0G but only ${formatEther(spendable)} is spendable; leaving the debit open`,
    );
    return;
  }

  try {
    const hash = await coordinatorWallet().writeContract({
      address,
      abi: memoryEscrowAbi,
      functionName: "charge",
      args: [BigInt(agentId), amountWei],
      account: coordinatorAccount(),
      chain: ogGalileo,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(hash);
    await query("update memory_debits set charge_tx = $2 where id = $1", [debitId, hash]);
    console.log(`memory market: charged agent ${agentId} ${formatEther(amountWei)} 0G (${hash.slice(0, 10)}…)`);
  } catch (err) {
    console.error(`memory market: charge for agent ${agentId} failed, debit stays open:`, (err as Error).message);
  }
}

/**
 * Charge an agent once, now, for one thing it is about to receive.
 *
 * Memory batches its debits because a chess tournament makes hundreds of calls. A dossier
 * does not: an agent buys at most three in a contest, before the clock starts, and the
 * payment is what unlocks the read. So this settles immediately and returns the tx, which
 * is the x402 semantic the dossier market always claimed and never had.
 *
 * Returns null when the agent cannot pay, which is not an error: it just does not get the
 * thing. Never throws.
 */
export async function chargeAgent(
  agentId: number,
  contestId: number,
  item: string,
  amountWei: bigint,
): Promise<{ txHash: string; amountWei: bigint } | null> {
  const address = memoryEscrowAddress();
  if (!address || amountWei <= 0n) return null;

  const spendable = await spendableWei(agentId);
  if (spendable < amountWei) return null;

  // Record the debt before collecting it, so a crash between charge and insert can never
  // take payment we did not account for.
  let debitId: number;
  try {
    const { rows } = await query<{ id: string }>(
      "insert into memory_debits (agent_id, contest_id, kind, item, calls, amount_wei) values ($1,$2,$3,$4,1,$5) returning id",
      [agentId, contestId, "poker", item, amountWei.toString()],
    );
    debitId = Number(rows[0]!.id);
  } catch (err) {
    console.error(`memory market: could not record ${item} debit for agent ${agentId}:`, (err as Error).message);
    return null;
  }

  try {
    const hash = await coordinatorWallet().writeContract({
      address,
      abi: memoryEscrowAbi,
      functionName: "charge",
      args: [BigInt(agentId), amountWei],
      account: coordinatorAccount(),
      chain: ogGalileo,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(hash);
    await query("update memory_debits set charge_tx = $2 where id = $1", [debitId, hash]);
    console.log(`memory market: agent ${agentId} bought ${item} for ${formatEther(amountWei)} 0G (${hash.slice(0, 10)}…)`);
    return { txHash: hash, amountWei };
  } catch (err) {
    // The charge failed, so the agent never paid and must not receive the goods. Drop the
    // debit row rather than leaving a phantom debt against them.
    await query("delete from memory_debits where id = $1", [debitId]).catch(() => {});
    console.error(`memory market: ${item} charge for agent ${agentId} failed:`, (err as Error).message);
    return null;
  }
}

/** Total 0G an agent still owes for memory it already used. */
export async function unsettledWei(agentId: number): Promise<bigint> {
  const { rows } = await query<{ total: string | null }>(
    "select sum(amount_wei)::text as total from memory_debits where agent_id = $1 and charge_tx is null",
    [agentId],
  );
  return BigInt(rows[0]?.total ?? "0");
}
