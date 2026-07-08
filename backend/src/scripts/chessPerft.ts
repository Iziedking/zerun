import { parseFEN, legalMoves, applyMove, START_FEN, type Position } from "../runners/chess/engine.js";

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

console.log(failures === 0 ? "\nall perft checks passed — engine is rules-correct" : `\n${failures} perft checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
