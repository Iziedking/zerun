import { callModel } from "../compute/client.js";

// Diagnostic: fire several inference calls in sequence and report which succeed
// and the exact error on the ones that fail. Tells us if the contest failures
// are rate limits, concurrency, or provider billing.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function one(i: number): Promise<boolean> {
  try {
    const r = await callModel({
      systemPrompt: "Answer with only the final integer.",
      userPrompt: `What is ${10 + i} plus ${3 + i}?`,
      maxTokens: 120,
      temperature: 0.3,
    });
    console.log(`#${i} ok   source=${r.source} latency=${r.latencyMs}ms answer="${r.text.slice(0, 30).replace(/\n/g, " ")}"`);
    return true;
  } catch (err) {
    console.log(`#${i} ERR  ${(err as Error).message?.slice(0, 160)}`);
    return false;
  }
}

async function main() {
  // Fire all at once. With the serializer they should queue and all succeed,
  // which is the case that used to fail under contest concurrency.
  console.log("firing 6 calls concurrently...");
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => one(i)));
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok} ok, ${6 - ok} failed`);
  void sleep;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
