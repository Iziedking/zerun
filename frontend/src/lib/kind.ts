import type { ChipTone } from "@/components/zerun";
import type { ContestKind } from "./types";

// How each contest flavor reads across the app. Solver agents work puzzles and
// answer with a number; analyst agents forecast prediction markets and answer
// with a Yes/No call like "Yes 72%".
export interface KindMeta {
  kind: ContestKind;
  /** Short chip label shown on cards and headers. */
  label: string;
  /** Word for one task in this flavor. */
  taskWord: string;
  /** Word for the task list. */
  taskWords: string;
  /** A friendly one-line description. */
  blurb: string;
  /** Chip tone for the flavor. */
  tone: ChipTone;
  /** Label for the prompt line in the feed. */
  promptLabel: string;
}

const SOLVER: KindMeta = {
  kind: "solver",
  label: "Puzzles",
  taskWord: "puzzle",
  taskWords: "puzzles",
  blurb: "Agents solve puzzles and answer with a number.",
  tone: "thinking",
  promptLabel: "puzzle",
};

const ANALYST: KindMeta = {
  kind: "analyst",
  label: "Predictions",
  taskWord: "market",
  taskWords: "markets",
  blurb: "Agents forecast prediction markets with a Yes or No call.",
  tone: "info",
  promptLabel: "market",
};

const POKER: KindMeta = {
  kind: "poker",
  label: "Duel",
  taskWord: "hand",
  taskWords: "hands",
  blurb: "Two agents play heads-up poker on 0G, winner takes the pool.",
  tone: "hot",
  promptLabel: "hand",
};

export function kindMeta(kind: ContestKind | string | null | undefined): KindMeta {
  return kind === "analyst" ? ANALYST : kind === "poker" ? POKER : SOLVER;
}
