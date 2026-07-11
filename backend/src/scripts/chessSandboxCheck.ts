import { runAgentMove } from "../runners/chess/sandbox.js";
import { parseFEN, legalMoves, moveToUci, START_FEN } from "../runners/chess/engine.js";

// Does the agent sandbox actually run an uploaded agent, feed it the position, take its move, and
// contain a misbehaving one? This exercises the whole runner+harness protocol without needing 0G
// (the agents here do not call the model), so it is safe to run anywhere python3 is present.
//
//   # protocol only (no isolation — DEV; prints a warning):
//   npx tsx src/scripts/chessSandboxCheck.ts
//
//   # with the real sandbox on the box:
//   CHESS_SANDBOX_CMD=/opt/zerun/deploy/sandbox-run.sh npx tsx src/scripts/chessSandboxCheck.ts
//
// Expected: the simple agent returns a legal move; the busy and hanging agents are killed and come
// back as failures; the illegal-move agent returns a move the referee would rule a forfeit.

const SIMPLE = 'def choose_move(state):\n    legal = state.get("legal") or []\n    return legal[0] if legal else ""\n';
const BUSY = "def choose_move(state):\n    while True:\n        pass\n";
const HANG = "import time\ndef choose_move(state):\n    time.sleep(30)\n    return ''\n";
const ILLEGAL = 'def choose_move(state):\n    return "z9z9"\n';
const CRASH = "def choose_move(state):\n    raise ValueError('boom')\n";
// Tries to reach the internet. WITHOUT isolation it may succeed; WITH the sandbox it must fail
// (no network), proving the cut — the single most important thing to confirm on the box.
const NET =
  "import urllib.request\n" +
  "def choose_move(state):\n" +
  "    urllib.request.urlopen('http://1.1.1.1', timeout=2).read()\n" +
  "    return (state.get('legal') or [''])[0]\n";

async function main(): Promise<void> {
  const pos = parseFEN(START_FEN);
  const legal = legalMoves(pos).map(moveToUci);
  const state = { fen: START_FEN, legal, side: "w" as const, ply: 0 };

  const cases: { name: string; code: string; budgetMs: number }[] = [
    { name: "simple (first legal)", code: SIMPLE, budgetMs: 4000 },
    { name: "busy loop (CPU)", code: BUSY, budgetMs: 2000 },
    { name: "sleep 30s (wall clock)", code: HANG, budgetMs: 2000 },
    { name: "illegal move", code: ILLEGAL, budgetMs: 4000 },
    { name: "crashes", code: CRASH, budgetMs: 4000 },
    { name: "tries network", code: NET, budgetMs: 4000 },
  ];

  console.log(`\nchess sandbox check (isolation: ${process.env.CHESS_SANDBOX_CMD ? "ON" : "OFF — dev"})\n`);
  for (const [i, c] of cases.entries()) {
    const t0 = Date.now();
    const r = await runAgentMove(100 + i, c.code, state, { budgetMs: c.budgetMs });
    const ms = Date.now() - t0;
    const legalMove = r.ok && r.uci ? legal.includes(r.uci) : false;
    console.log(
      `  ${c.name.padEnd(24)} -> ${JSON.stringify(r)}  (${ms}ms${r.ok ? `, legal=${legalMove}` : ""})`,
    );
  }
  console.log("\ndone. simple should be ok+legal; busy/sleep/crash should be ok:false; illegal ok:true but not legal.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("sandbox check failed:", (e as Error).message);
  process.exit(1);
});
