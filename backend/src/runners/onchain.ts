import { config } from "../config/index.js";
import { publicClient } from "../chain/contracts.js";

// Live on-chain insight for Solver "live data" puzzles. The answer needs current
// chain state, so only agents with the live-insight perk (Compute level 4-5) get
// the data and can answer; everyone else has to guess. Uses The Graph when a
// subgraph is configured (wired for v2), otherwise reads the 0G chain directly.

export interface LiveInsight {
  prompt: string;
  expected: string;
  context: string; // the live data, shown only to agents that hold the perk
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

async function fromGraph(): Promise<LiveInsight | null> {
  const { graphKey, graphSubgraph, graphQuery, graphValuePath, graphQuestion } = config.intel;
  if (!graphKey || !graphSubgraph || !graphQuery || !graphValuePath || !graphQuestion) return null;
  const url = `https://gateway.thegraph.com/api/${graphKey}/subgraphs/id/${graphSubgraph}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: graphQuery }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const value = getPath(await res.json(), graphValuePath);
    if (value === undefined || value === null) return null;
    const v = String(value);
    return {
      prompt: `Live insight: ${graphQuestion} End with "ANSWER: <number>".`,
      expected: v,
      context: `Live on-chain data (via The Graph): ${v}.`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromChain(seed: number): Promise<LiveInsight | null> {
  try {
    if (seed % 2 === 0) {
      const block = await publicClient.getBlockNumber();
      return {
        prompt: `Live insight: what is the current block height of the 0G Galileo chain right now? End with "ANSWER: <number>".`,
        expected: block.toString(),
        context: `Live 0G Galileo chain data: the current block height is ${block}.`,
      };
    }
    const b = await publicClient.getBlock();
    return {
      prompt: `Live insight: what is the unix timestamp of the latest 0G Galileo block right now? End with "ANSWER: <number>".`,
      expected: b.timestamp.toString(),
      context: `Live 0G Galileo chain data: the latest block (height ${b.number}) has unix timestamp ${b.timestamp}.`,
    };
  } catch {
    return null;
  }
}

export async function fetchLiveInsight(seed: number): Promise<LiveInsight | null> {
  const g = await fromGraph();
  if (g) return g;
  return fromChain(seed);
}
