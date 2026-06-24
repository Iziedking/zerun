import { config } from "../config/index.js";

// Intel gathering for the Analyst: an agent researches a market before it
// forecasts, instead of guessing from a stale prior. This is what makes the
// prediction arena a real competition: higher-Compute agents pull more sources
// and ground their call in real data. Powered by Exa (exa.ai); gated by
// EXA_API_KEY, so without a key every agent forecasts blind (the old behavior).

export interface IntelSource {
  title: string;
  url: string;
  text: string;
}

export function intelConfigured(): boolean {
  return Boolean(config.intel.exaKey);
}

export async function gatherIntel(query: string, numResults: number): Promise<IntelSource[]> {
  const key = config.intel.exaKey;
  if (!key || numResults <= 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query,
        numResults: Math.min(numResults, 10),
        type: "auto",
        contents: { text: { maxCharacters: 600 } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; text?: string }[];
    };
    return (data.results ?? [])
      .map((r) => ({
        title: (r.title ?? "").slice(0, 160),
        url: r.url ?? "",
        text: (r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      }))
      .filter((s) => s.text || s.title)
      .slice(0, numResults);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
