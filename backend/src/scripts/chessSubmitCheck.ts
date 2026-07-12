import { readFile } from "node:fs/promises";
import { smokeTest } from "../runners/chess/submissions.js";

// Does the entry gate actually gate? This runs the same smoke test a real submission runs — three
// positions, inside the sandbox — against a good agent and three broken ones, so you can see at a
// glance that a working file gets in and a broken one gets a reason why.
//
//   # protocol only (no isolation — DEV):
//   npx tsx src/scripts/chessSubmitCheck.ts
//
//   # with the real sandbox on the box (what production does):
//   CHESS_SANDBOX_CMD='bash /app/src/runners/chess/sandbox-run.sh' npx tsx src/scripts/chessSubmitCheck.ts
//
// Expected: the example agent passes with a legal move in each position; the illegal, hanging, and
// crashing agents are all rejected, each with the reason a player would be shown.

const ILLEGAL = 'def choose_move(state):\n    return "z9z9"\n';
const HANG = "import time\ndef choose_move(state):\n    time.sleep(30)\n    return ''\n";
const CRASH = "def choose_move(state):\n    raise ValueError('boom')\n";

async function main(): Promise<void> {
  const example = await readFile(new URL("../runners/chess/example-agent.py", import.meta.url), "utf8");

  const cases: { name: string; code: string; shouldPass: boolean }[] = [
    { name: "the example agent", code: example, shouldPass: true },
    { name: "illegal move", code: ILLEGAL, shouldPass: false },
    { name: "never answers", code: HANG, shouldPass: false },
    { name: "crashes", code: CRASH, shouldPass: false },
  ];

  console.log(`\nchess entry check (isolation: ${process.env.CHESS_SANDBOX_CMD ? "ON" : "OFF — dev"})\n`);
  let wrong = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const r = await smokeTest(c.code);
    const ms = Date.now() - t0;
    const verdict = r.ok ? "ACCEPTED" : "REJECTED";
    const right = r.ok === c.shouldPass;
    if (!right) wrong++;
    console.log(`  ${c.name.padEnd(18)} -> ${verdict.padEnd(8)} ${right ? "" : "  <-- WRONG"} (${ms}ms)`);
    if (r.ok) {
      for (const m of r.moves) console.log(`      ${m.position.padEnd(24)} ${m.uci}  (${m.ms}ms)`);
    } else {
      console.log(`      reason shown to the player: ${r.error}`);
    }
  }
  console.log(wrong === 0 ? "\nthe gate holds: good agents in, broken agents out.\n" : `\n${wrong} case(s) wrong.\n`);
  process.exit(wrong === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("entry check failed:", (e as Error).message);
  process.exit(1);
});
