import { parseFEN, legalMoves, applyMove, START_FEN, type Position } from "../runners/chess/engine.js";
import { bestCandidates } from "../runners/chess/search.js";

// Perft: count leaf nodes of the legal-move tree to a depth. Matching the known
// reference counts proves the move generator (incl. castling, en passant, promotion,
// and check evasion) is correct. Run: npx tsx src/scripts/chessPerft.ts

function perft(p: Position, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(p)) n += perft(applyMove(p, m), depth - 1);
  return n;
}

let failures = 0;
function check(name: string, got: number, want: number) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
  if (!ok) failures++;
}

// Starting position — the canonical perft numbers.
const start = parseFEN(START_FEN);
check("start d1", perft(start, 1), 20);
check("start d2", perft(start, 2), 400);
check("start d3", perft(start, 3), 8902);
check("start d4", perft(start, 4), 197281);

// "Kiwipete": dense with castling, en passant, pins, and promotions — the standard
// stress test for a move generator.
const kiwi = parseFEN("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
check("kiwipete d1", perft(kiwi, 1), 48);
check("kiwipete d2", perft(kiwi, 2), 2039);
check("kiwipete d3", perft(kiwi, 3), 97862);

// A promotion-heavy endgame position.
const promo = parseFEN("n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1");
check("promotions d1", perft(promo, 1), 24);
check("promotions d2", perft(promo, 2), 496);

// --- search / brain tactics: the engine must find the obvious best move ---
function checkStr(name: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
  if (!ok) failures++;
}

// Back-rank mate in one: Ra1-a8# (king boxed in by its own pawns).
const mate = parseFEN("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
const mateBest = bestCandidates(mate, 2, 4)[0]!;
checkStr("finds mate in 1", mateBest.uci, "a1a8");
check("mate scores as winning", mateBest.score > 100000 ? 1 : 0, 1);

// A free queen hangs: Rd2xd5 wins it outright.
const hang = parseFEN("4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1");
const hangBest = bestCandidates(hang, 2, 4)[0]!;
checkStr("takes the hanging queen", hangBest.uci, "d2d5");

console.log(failures === 0 ? "\nall chess checks passed — engine rules-correct and brain finds tactics" : `\n${failures} chess checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
