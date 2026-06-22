import OpenAI from "openai";
import { config } from "../config/index.js";
import { computeChat, brokerConfigured } from "./zgCompute.js";

// The single seam every agent answer passes through. In Zerun an agent does not
// "think" anywhere except here, and here always resolves to 0G: a paid,
// TEE-verifiable call on the 0G Compute Network (broker), or the 0G Compute
// Router as a fast fallback. The offline stub exists only for local plumbing
// tests before the wallet is funded, and it labels itself as such so it can
// never be mistaken for a real 0G result in the UI.

export type ComputeSource = "0g-compute" | "0g-router" | "offline-dev";

export interface CallParams {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface CallResult {
  text: string;
  source: ComputeSource;
  provider: string;
  model: string;
  /// 0G request id, used to verify the TEE signature on chain.
  chatID: string | null;
  /// TEE verification verdict from the broker. null when not applicable.
  verified: boolean | null;
  latencyMs: number;
}

function resolveMode(): ComputeSource {
  const forced = (process.env.COMPUTE_MODE ?? "").toLowerCase();
  if (forced === "broker" || forced === "0g-compute") return "0g-compute";
  if (forced === "router" || forced === "0g-router") return "0g-router";
  if (forced === "stub" || forced === "offline-dev") return "offline-dev";
  if (brokerConfigured()) return "0g-compute";
  if (config.compute.routerBaseUrl && config.compute.routerApiKey) return "0g-router";
  return "offline-dev";
}

export function computeMode(): ComputeSource {
  return resolveMode();
}

export function computeConfigured(): boolean {
  return resolveMode() !== "offline-dev";
}

let routerClient: OpenAI | null = null;
function getRouterClient(): OpenAI {
  if (routerClient) return routerClient;
  routerClient = new OpenAI({
    baseURL: config.compute.routerBaseUrl,
    apiKey: config.compute.routerApiKey,
    timeout: config.compute.callTimeoutMs,
  });
  return routerClient;
}

export async function callModel(params: CallParams): Promise<CallResult> {
  const mode = resolveMode();

  if (mode === "0g-compute") {
    const a = await computeChat(params);
    return {
      text: a.text,
      source: "0g-compute",
      provider: a.provider,
      model: a.model,
      chatID: a.chatID,
      verified: a.verified,
      latencyMs: a.latencyMs,
    };
  }

  if (mode === "0g-router") {
    const client = getRouterClient();
    const model = process.env.COMPUTE_ROUTER_MODEL ?? "llama-3.3-70b-instruct";
    const t0 = Date.now();
    const completion = await client.chat.completions.create({
      model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    });
    return {
      text: (completion.choices[0]?.message?.content ?? "").trim(),
      source: "0g-router",
      provider: "0g-compute-router",
      model,
      chatID: completion.id ?? null,
      verified: null,
      latencyMs: Date.now() - t0,
    };
  }

  // offline-dev: deterministic, no network. Clearly labeled so it never reads
  // as a real 0G answer. Used only to exercise the pipeline before funding.
  const t0 = Date.now();
  const answer = offlineAnswer(params.userPrompt);
  return {
    text: answer,
    source: "offline-dev",
    provider: "offline-dev",
    model: "offline-dev",
    chatID: null,
    verified: null,
    latencyMs: Date.now() - t0,
  };
}

// A tiny deterministic solver for the offline stub. Handles the arithmetic
// puzzle shape the generator produces so the local flow can score sensibly.
function offlineAnswer(prompt: string): string {
  const expr = prompt.match(/-?\d+(?:\s*[+\-*]\s*-?\d+)+/);
  if (expr) {
    try {
      const cleaned = expr[0].replace(/\s+/g, "");
      if (/^-?\d+(?:[+\-*]-?\d+)+$/.test(cleaned)) {
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict";return (${cleaned})`)();
        if (typeof val === "number" && Number.isFinite(val)) return String(val);
      }
    } catch {
      // fall through
    }
  }
  return "offline-dev: no answer";
}
