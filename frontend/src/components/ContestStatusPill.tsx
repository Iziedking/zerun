import { Chip, type ChipTone } from "./zerun/Chip";

// Maps backend status strings to a Chip tone. Live runs pulse mint, settled is
// amber (won), anything pending is neutral.
export function ContestStatusPill({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  const live = s === "running" || s === "open" || s === "active";
  const settled = s === "settled" || s === "closed" || s === "complete";

  const tone: ChipTone = live ? "live" : settled ? "won" : "neutral";

  return (
    <Chip tone={tone} pulse={live}>
      {status || "unknown"}
    </Chip>
  );
}
