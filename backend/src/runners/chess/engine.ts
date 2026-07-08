// A self-contained, rules-complete chess engine: legal move generation (including
// castling, en passant, and promotion), check/checkmate/stalemate detection, draw
// rules, FEN import/export, and captured-material scoring. No dependency, so it is
// unit-tested offline with perft (see chessPerft.ts). Squares are 0..63 with a1=0,
// h1=7, a8=56; index = rank*8 + file. Pieces are FEN chars: white PNBRQK, black pnbrqk.

export type Color = "w" | "b";
export interface Move {
  from: number;
  to: number;
  promo?: "q" | "r" | "b" | "n"; // set only for a pawn reaching the last rank
}

export interface Position {
  board: string[]; // 64 entries, "" for empty
  turn: Color;
  castling: string; // subset of "KQkq"
  ep: number; // en-passant target square, or -1
  half: number; // halfmove clock (for the 50-move rule)
  full: number; // fullmove number
}

const rankOf = (sq: number) => sq >> 3;
const fileOf = (sq: number) => sq & 7;
const sq = (r: number, f: number) => r * 8 + f;
const onBoard = (r: number, f: number) => r >= 0 && r < 8 && f >= 0 && f < 8;
const isWhite = (p: string) => p !== "" && p === p.toUpperCase();
const colorOf = (p: string): Color => (isWhite(p) ? "w" : "b");

const KNIGHT: [number, number][] = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
const KING: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const BISHOP: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function parseFEN(fen: string): Position {
  const [placement, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
  const board = new Array<string>(64).fill("");
  const ranks = placement!.split("/"); // rank 8 first
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]!) {
      if (/\d/.test(ch)) f += Number(ch);
      else board[sq(7 - r, f++)] = ch;
    }
  }
  return {
    board,
    turn: turn === "b" ? "b" : "w",
    castling: castling === "-" ? "" : (castling ?? ""),
    ep: ep && ep !== "-" ? algebraicToSq(ep) : -1,
    half: Number(half ?? "0"),
    full: Number(full ?? "1"),
  };
}

export function toFEN(p: Position): string {
  let placement = "";
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const piece = p.board[sq(r, f)]!;
      if (piece === "") empty++;
      else {
        if (empty) placement += empty;
        placement += piece;
        empty = 0;
      }
    }
    if (empty) placement += empty;
    if (r > 0) placement += "/";
  }
  const ep = p.ep >= 0 ? sqToAlgebraic(p.ep) : "-";
  return `${placement} ${p.turn} ${p.castling || "-"} ${ep} ${p.half} ${p.full}`;
}

export function algebraicToSq(a: string): number {
  return sq(Number(a[1]) - 1, a.charCodeAt(0) - 97);
}
export function sqToAlgebraic(s: number): string {
  return String.fromCharCode(97 + fileOf(s)) + (rankOf(s) + 1);
}
// Long algebraic (e2e4, e7e8q) for the 0G prompts and the feed.
export function moveToUci(m: Move): string {
  return sqToAlgebraic(m.from) + sqToAlgebraic(m.to) + (m.promo ?? "");
}

// Is square `s` attacked by a piece of color `by` on this board?
function attacked(board: string[], s: number, by: Color): boolean {
  const r = rankOf(s);
  const f = fileOf(s);
  // Pawns: a `by` pawn attacks `s` from the rank behind it (white attacks from below).
  const pr = by === "w" ? r - 1 : r + 1;
  for (const df of [-1, 1]) {
    if (onBoard(pr, f + df)) {
      const p = board[sq(pr, f + df)]!;
      if (p !== "" && colorOf(p) === by && p.toLowerCase() === "p") return true;
    }
  }
  for (const [dr, df] of KNIGHT) {
    if (onBoard(r + dr, f + df)) {
      const p = board[sq(r + dr, f + df)]!;
      if (p !== "" && colorOf(p) === by && p.toLowerCase() === "n") return true;
    }
  }
  for (const [dr, df] of KING) {
    if (onBoard(r + dr, f + df)) {
      const p = board[sq(r + dr, f + df)]!;
      if (p !== "" && colorOf(p) === by && p.toLowerCase() === "k") return true;
    }
  }
  const rays: [[number, number][], string[]][] = [
    [BISHOP, ["b", "q"]],
    [ROOK, ["r", "q"]],
  ];
  for (const [dirs, kinds] of rays) {
    for (const [dr, df] of dirs) {
      let rr = r + dr;
      let ff = f + df;
      while (onBoard(rr, ff)) {
        const p = board[sq(rr, ff)]!;
        if (p !== "") {
          if (colorOf(p) === by && kinds.includes(p.toLowerCase())) return true;
          break;
        }
        rr += dr;
        ff += df;
      }
    }
  }
  return false;
}

function kingSquare(board: string[], color: Color): number {
  const k = color === "w" ? "K" : "k";
  return board.indexOf(k);
}

export function inCheck(p: Position, color: Color = p.turn): boolean {
  const ks = kingSquare(p.board, color);
  if (ks < 0) return false;
  return attacked(p.board, ks, color === "w" ? "b" : "w");
}

// Pseudo-legal moves for the side to move (may leave own king in check).
function pseudoMoves(p: Position): Move[] {
  const moves: Move[] = [];
  const us = p.turn;
  const them: Color = us === "w" ? "b" : "w";
  const push = (from: number, to: number) => {
    const toR = rankOf(to);
    if (p.board[from]!.toLowerCase() === "p" && (toR === 0 || toR === 7)) {
      for (const promo of ["q", "r", "b", "n"] as const) moves.push({ from, to, promo });
    } else moves.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const piece = p.board[from]!;
    if (piece === "" || colorOf(piece) !== us) continue;
    const r = rankOf(from);
    const f = fileOf(from);
    const kind = piece.toLowerCase();
    if (kind === "p") {
      const dir = us === "w" ? 1 : -1;
      const startRank = us === "w" ? 1 : 6;
      // Single and double push
      if (onBoard(r + dir, f) && p.board[sq(r + dir, f)] === "") {
        push(from, sq(r + dir, f));
        if (r === startRank && p.board[sq(r + 2 * dir, f)] === "") push(from, sq(r + 2 * dir, f));
      }
      // Captures (incl. en passant)
      for (const df of [-1, 1]) {
        if (!onBoard(r + dir, f + df)) continue;
        const to = sq(r + dir, f + df);
        const target = p.board[to]!;
        if (target !== "" && colorOf(target) === them) push(from, to);
        else if (to === p.ep) moves.push({ from, to }); // ep capture, never a promotion
      }
    } else if (kind === "n" || kind === "k") {
      const dirs = kind === "n" ? KNIGHT : KING;
      for (const [dr, df] of dirs) {
        if (!onBoard(r + dr, f + df)) continue;
        const to = sq(r + dr, f + df);
        const t = p.board[to]!;
        if (t === "" || colorOf(t) === them) moves.push({ from, to });
      }
      if (kind === "k") castleMoves(p, from, moves);
    } else {
      const dirs = kind === "b" ? BISHOP : kind === "r" ? ROOK : [...BISHOP, ...ROOK];
      for (const [dr, df] of dirs) {
        let rr = r + dr;
        let ff = f + df;
        while (onBoard(rr, ff)) {
          const to = sq(rr, ff);
          const t = p.board[to]!;
          if (t === "") moves.push({ from, to });
          else {
            if (colorOf(t) === them) moves.push({ from, to });
            break;
          }
          rr += dr;
          ff += df;
        }
      }
    }
  }
  return moves;
}

function castleMoves(p: Position, from: number, moves: Move[]): void {
  const us = p.turn;
  const them: Color = us === "w" ? "b" : "w";
  const homeRank = us === "w" ? 0 : 7;
  if (from !== sq(homeRank, 4)) return; // king must be on its start square
  if (inCheck(p, us)) return; // cannot castle out of check
  const empty = (s: number) => p.board[s] === "";
  const safe = (s: number) => !attacked(p.board, s, them);
  const kSide = us === "w" ? "K" : "k";
  const qSide = us === "w" ? "Q" : "q";
  if (p.castling.includes(kSide) && empty(sq(homeRank, 5)) && empty(sq(homeRank, 6)) && safe(sq(homeRank, 5)) && safe(sq(homeRank, 6))) {
    moves.push({ from, to: sq(homeRank, 6) });
  }
  if (
    p.castling.includes(qSide) &&
    empty(sq(homeRank, 3)) &&
    empty(sq(homeRank, 2)) &&
    empty(sq(homeRank, 1)) &&
    safe(sq(homeRank, 3)) &&
    safe(sq(homeRank, 2))
  ) {
    moves.push({ from, to: sq(homeRank, 2) });
  }
}

// Apply a move, returning a NEW position (immutable, so search and replay are clean).
export function applyMove(p: Position, m: Move): Position {
  const board = p.board.slice();
  const piece = board[m.from]!;
  const kind = piece.toLowerCase();
  const us = p.turn;
  const capture = board[m.to] !== "";
  let ep = -1;

  // En-passant capture: remove the pawn behind the target square.
  if (kind === "p" && m.to === p.ep && p.ep >= 0) {
    const behind = sq(rankOf(m.from), fileOf(m.to));
    board[behind] = "";
  }
  // Move the piece (promote if requested).
  board[m.to] = m.promo ? (us === "w" ? m.promo.toUpperCase() : m.promo) : piece;
  board[m.from] = "";
  // Double pawn push sets the en-passant target.
  if (kind === "p" && Math.abs(rankOf(m.to) - rankOf(m.from)) === 2) {
    ep = sq((rankOf(m.from) + rankOf(m.to)) / 2, fileOf(m.from));
  }
  // Castling: move the rook too.
  if (kind === "k" && Math.abs(fileOf(m.to) - fileOf(m.from)) === 2) {
    const homeRank = rankOf(m.from);
    if (fileOf(m.to) === 6) {
      board[sq(homeRank, 5)] = board[sq(homeRank, 7)]!;
      board[sq(homeRank, 7)] = "";
    } else {
      board[sq(homeRank, 3)] = board[sq(homeRank, 0)]!;
      board[sq(homeRank, 0)] = "";
    }
  }

  // Update castling rights: king move drops both; rook move/capture drops that side.
  let castling = p.castling;
  const drop = (c: string) => {
    castling = castling.replace(c, "");
  };
  if (kind === "k") {
    if (us === "w") {
      drop("K");
      drop("Q");
    } else {
      drop("k");
      drop("q");
    }
  }
  const rights: [number, string][] = [
    [sq(0, 0), "Q"],
    [sq(0, 7), "K"],
    [sq(7, 0), "q"],
    [sq(7, 7), "k"],
  ];
  for (const [square, c] of rights) if (m.from === square || m.to === square) drop(c);

  return {
    board,
    turn: us === "w" ? "b" : "w",
    castling,
    ep,
    half: kind === "p" || capture ? 0 : p.half + 1,
    full: us === "b" ? p.full + 1 : p.full,
  };
}

// Fully legal moves: pseudo-legal moves that do not leave our own king in check.
export function legalMoves(p: Position): Move[] {
  const us = p.turn;
  return pseudoMoves(p).filter((m) => !inCheck(applyMove(p, m), us));
}

// Standard piece values, used for the timeout tiebreak (most material captured wins).
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FULL_SIDE = 39; // 8*1 + 2*3 + 2*3 + 2*5 + 9

// Material each color has captured, by value (opponent's missing material). This is the
// score that decides a game that hits the 300s cap without a checkmate.
export function capturedValue(p: Position): { w: number; b: number } {
  let whiteOnBoard = 0;
  let blackOnBoard = 0;
  for (const piece of p.board) {
    if (piece === "" || piece.toLowerCase() === "k") continue;
    const v = VALUE[piece.toLowerCase()] ?? 0;
    if (isWhite(piece)) whiteOnBoard += v;
    else blackOnBoard += v;
  }
  return { w: FULL_SIDE - blackOnBoard, b: FULL_SIDE - whiteOnBoard };
}

// Only kings, or a lone king vs king + single minor, can never be mated: a dead draw.
function insufficientMaterial(board: string[]): boolean {
  const minors: string[] = [];
  for (const piece of board) {
    if (piece === "" || piece.toLowerCase() === "k") continue;
    const k = piece.toLowerCase();
    if (k === "n" || k === "b") minors.push(k);
    else return false; // a pawn, rook, or queen exists: mate is possible
  }
  return minors.length <= 1;
}

export type GameOutcome =
  | { over: false }
  | { over: true; result: "checkmate"; winner: Color }
  | { over: true; result: "stalemate" | "insufficient" | "fifty-move" | "threefold"; winner: null };

// The game state. `history` (FEN piece-placement+turn+castling+ep keys) enables the
// threefold check; the runner accumulates it.
export function outcome(p: Position, repeats = 0): GameOutcome {
  if (legalMoves(p).length === 0) {
    if (inCheck(p, p.turn)) return { over: true, result: "checkmate", winner: p.turn === "w" ? "b" : "w" };
    return { over: true, result: "stalemate", winner: null };
  }
  if (insufficientMaterial(p.board)) return { over: true, result: "insufficient", winner: null };
  if (p.half >= 100) return { over: true, result: "fifty-move", winner: null };
  if (repeats >= 3) return { over: true, result: "threefold", winner: null };
  return { over: false };
}

// The repetition key: everything that defines a position for threefold (not the clocks).
export function repetitionKey(p: Position): string {
  return `${p.board.join("")}|${p.turn}|${p.castling}|${p.ep}`;
}
