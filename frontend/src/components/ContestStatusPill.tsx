import { Pill } from "./ui";

// Maps backend status strings to a tone. Unknown statuses fall back to neutral.
export function ContestStatusPill({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  const live = s === "running" || s === "open" || s === "active";
  const settled = s === "settled" || s === "closed" || s === "complete";

  return (
    <Pill tone={live ? "signal" : settled ? "neutral" : "amber"}>
      {live && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-signal" />
      )}
      {status || "unknown"}
    </Pill>
  );
}
