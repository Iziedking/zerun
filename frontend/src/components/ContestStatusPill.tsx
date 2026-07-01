import { Chip, type ChipTone } from "./zerun/Chip";

// Maps backend status strings to a Chip tone. Live runs pulse mint, settled is
// amber (won), anything pending is neutral.
export function ContestStatusPill({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  const live = s === "running" || s === "open" || s === "active";
  const settled = s === "settled" || s === "closed" || s === "complete";
  const awaiting = s === "awaiting_resolution";

  const tone: ChipTone = awaiting ? "info" : live ? "live" : settled ? "won" : "neutral";
  const label = awaiting ? "awaiting results" : status || "unknown";

  return (
    <Chip tone={tone} pulse={live}>
      {label}
    </Chip>
  );
}
