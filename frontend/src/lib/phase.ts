import type { ContestSummary } from "./types";

// The four phases a contest moves through, derived from its backend status and
// its join-window deadline (ends_at). The contest page renders each differently
// so the run never looks stuck.
export type ContestPhase = "joining" | "running" | "settled" | "cancelled";

// Decide the current phase. `now` is injected so a ticking clock can recompute
// it every second without re-reading Date.now() at the call site.
export function contestPhase(
  contest: Pick<ContestSummary, "status" | "ends_at" | "settled_at">,
  now: number = Date.now(),
): ContestPhase {
  const s = (contest.status || "").toLowerCase();

  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "settled" || Boolean(contest.settled_at)) return "settled";

  const endsAt = contest.ends_at ? Date.parse(contest.ends_at) : NaN;
  const windowOpen =
    (s === "open" || s === "pending") &&
    Number.isFinite(endsAt) &&
    now < endsAt;

  // Open/pending with time left on the clock is the joining window. A backend
  // with no ends_at but still flagged open is treated as joining too, so the
  // enter form does not vanish on contests that predate the deadline field.
  if (windowOpen) return "joining";
  if ((s === "open" || s === "pending") && !Number.isFinite(endsAt)) return "joining";

  // Anything else still in play (window closed, or status running) is running.
  return "running";
}

// Whether the join window is still open for entries. True only while joining.
export function joinOpen(
  contest: Pick<ContestSummary, "status" | "ends_at" | "settled_at">,
  now: number = Date.now(),
): boolean {
  return contestPhase(contest, now) === "joining";
}

// Whole seconds left until the join window closes, clamped at zero. Returns null
// when there is no deadline to count down to.
export function secondsUntilClose(
  endsAt: string | null,
  now: number = Date.now(),
): number | null {
  if (!endsAt) return null;
  const t = Date.parse(endsAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((t - now) / 1000));
}

// Format a seconds count as mm:ss (e.g. 272 -> "04:32").
export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
