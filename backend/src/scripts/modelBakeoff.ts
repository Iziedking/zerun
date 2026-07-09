import { computeChat } from "../compute/zgCompute.js";
import { parseFEN, START_FEN } from "../runners/chess/engine.js";
import { bestCandidates } from "../runners/chess/search.js";
import { CHESS_SYSTEM, buildChessPrompt, parseChessChoice } from "../runners/chess/decide.js";
import { extractAnswer } from "../runners/puzzles.js";
import { extractProbability } from "../runners/markets.js";

// Head-to-head across candidate models on the three shapes of work Zerun actually does.
//
// Price alone does not decide cost. Every runner parses a STRUCTURED answer out of free
// text: a number for a solver, a legal UCI move chosen from three candidates for chess, a
// trailing `PROB: <0-100>` for a forecast. A model that rambles fails the parse, the runner
// retries, and three failed passes at a cheap model cost more than one clean pass at a dear
// one — and they surface as `error` in the live feed. So the metric here is not "is the
// answer good", it is "does the answer parse", which is what actually bills.
//
//   MODELS="a,b,c" npx tsx src/scripts/modelBakeoff.ts
//
// Each task is a real, paid 0G inference. Calls are serialized by the compute layer's
// global throttle, so a 3x3 run takes roughly a minute.

const MODELS = (process.env.MODELS ?? "qwen/qwen3-vl-30b-a3b-instruct,0GM-1.0-35B-A3B,openai/gpt-oss-20b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// The token budgets the real inference plans use, because a budget that truncates a model
// mid-thought turns a format question into a truncation artefact. L0 solver = 280,
// chessGame = 64, worldcupForecast at L1 = 440.
const TOK_SOLVER = 280;
const TOK_CHESS = 64;
const TOK_FORECAST = 440;

// Which tier to bill this as, because the tier is what selects the NETWORK. A mainnet model
// probed at a testnet tier is never reached: the name matches nothing on testnet and the run
// reports a failure that belongs to the router, not the model. Default to the top tier, which
// reaches mainnet under any COMPUTE_MAINNET_MIN_TIER setting.
const TIER = Number(process.env.BAKEOFF_TIER ?? "5");

const SOLVER_SYSTEM = "You are a precise solver. Answer with only the final result, no words.";
const SOLVER_PROMPT = "Compute: 17 * 23 - 148 + 9";
const SOLVER_EXPECTED = "252";

const FORECAST_SYSTEM =
  "You are a football analyst forecasting an UPCOMING event that has NOT happened yet. " +
  "Estimate a calibrated probability. End with a line in exactly this form: PROB: <0-100>, " +
  "the percent chance the event resolves Yes.";
const FORECAST_PROMPT = "Upcoming World Cup event: Brazil reach the semi-final. Give the percent chance it resolves Yes.";

interface Row {
  model: string;
  task: string;
  ok: boolean;
  detail: string;
  latencyMs: number;
  servedBy: string;
  verified: boolean | null;
}

async function run(model: string, task: string, call: () => Promise<Row>): Promise<Row> {
  try {
    return await call();
  } catch (err) {
    return { model, task, ok: false, detail: `THREW: ${(err as Error).message.slice(0, 60)}`, latencyMs: 0, servedBy: "-", verified: null };
  }
}

async function main() {
  // The real chess prompt: engine candidates from the opening position, at tier-5 depth.
  const pos = parseFEN(START_FEN);
  const candidates = bestCandidates(pos, 3, 3);
  const chessPrompt = buildChessPrompt(pos, candidates, "white");

  const rows: Row[] = [];

  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);

    rows.push(
      await run(model, "solver", async () => {
        const a = await computeChat({ systemPrompt: SOLVER_SYSTEM, userPrompt: SOLVER_PROMPT, maxTokens: TOK_SOLVER, temperature: 0.2, models: [model], tier: TIER });
        const parsed = extractAnswer(a.text);
        const ok = parsed === SOLVER_EXPECTED;
        console.log(`  solver   ${ok ? "PASS" : "FAIL"}  ${String(a.latencyMs).padStart(5)}ms  ${String(a.text.length).padStart(4)} chars  parsed=${parsed ?? "(none)"}`);
        return { model, task: "solver", ok, detail: parsed ?? "(unparseable)", latencyMs: a.latencyMs, servedBy: a.model, verified: a.verified };
      }),
    );

    rows.push(
      await run(model, "chess", async () => {
        const a = await computeChat({ systemPrompt: CHESS_SYSTEM, userPrompt: chessPrompt, maxTokens: TOK_CHESS, temperature: 0.3, models: [model], tier: TIER });
        const { pick, matched } = parseChessChoice(a.text, candidates);
        console.log(`  chess    ${matched ? "PASS" : "FAIL"}  ${String(a.latencyMs).padStart(5)}ms  ${String(a.text.length).padStart(4)} chars  pick=${pick.uci}`);
        return { model, task: "chess", ok: matched, detail: pick.uci, latencyMs: a.latencyMs, servedBy: a.model, verified: a.verified };
      }),
    );

    rows.push(
      await run(model, "forecast", async () => {
        const a = await computeChat({ systemPrompt: FORECAST_SYSTEM, userPrompt: FORECAST_PROMPT, maxTokens: TOK_FORECAST, temperature: 0.4, models: [model], tier: TIER });
        const p = extractProbability(a.text);
        const ok = p !== null;
        console.log(`  forecast ${ok ? "PASS" : "FAIL"}  ${String(a.latencyMs).padStart(5)}ms  ${String(a.text.length).padStart(4)} chars  prob=${p ?? "(none)"}`);
        return { model, task: "forecast", ok, detail: p === null ? "(no PROB:)" : `${Math.round(p * 100)}%`, latencyMs: a.latencyMs, servedBy: a.model, verified: a.verified };
      }),
    );
  }

  console.log("\n\n=== summary ===");
  console.log("model                          solver  chess  forecast  avg latency  served by");
  for (const model of MODELS) {
    const mine = rows.filter((r) => r.model === model);
    const cell = (t: string) => {
      const r = mine.find((x) => x.task === t);
      return (r?.ok ? "PASS" : "FAIL").padEnd(7);
    };
    const lat = Math.round(mine.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, mine.length));
    // A candidate whose provider failed falls through to the tier's next model, so the
    // model that actually served is not always the one requested. Say so.
    const served = [...new Set(mine.map((r) => r.servedBy))].join(", ");
    console.log(`${model.padEnd(30)} ${cell("solver")} ${cell("chess")} ${cell("forecast")}  ${String(lat + "ms").padEnd(12)} ${served}`);
  }

  const anyVerified = rows.some((r) => r.verified === true);
  console.log(`\nTEE-verified answers: ${rows.filter((r) => r.verified === true).length}/${rows.length}` + (anyVerified ? "" : "   <-- processResponse never returned true"));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("bakeoff failed:", (e as Error).message);
    process.exit(1);
  });
