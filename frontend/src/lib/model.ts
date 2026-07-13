// Turn a raw 0G model id into something a person reads at a glance, plus which network serves it.
//
// The network is inferred from the model name because the two catalogs share no names: the testnet
// band is qwen2.5-omni / gemma / gpt-oss, the mainnet band is qwen3-vl / deepseek / MiniMax and the
// other premium candidates. That split is exactly the "which model, on which network" the arena
// wants to show, so a name is enough to badge it without threading a network field through.

export interface ModelInfo {
  /** A short, readable label, e.g. "qwen3-vl", "deepseek-v4-flash", "MiniMax-M3". */
  label: string;
  /** Which 0G network serves this model, or null when it is not a recognised 0G model. */
  network: "mainnet" | "testnet" | null;
}

const MAINNET_HINTS = ["qwen3-vl", "deepseek", "minimax", "glm-", "gpt-5"];
const TESTNET_HINTS = ["qwen2.5", "qwen2-", "gemma", "gpt-oss"];

/** Parse a model id into a label and network, or null for non-models (offline stub, errors). */
export function modelInfo(model: string | null | undefined): ModelInfo | null {
  if (!model) return null;
  const m = model.trim();
  if (!m || m === "·" || m === "offline-dev" || m === "error") return null;

  // Drop the provider prefix ("qwen/…") and the size/variant tail ("-30b-a3b-instruct", "-7b").
  let label = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
  label = label.replace(/-\d+b.*$/i, "").replace(/-(instruct|it)$/i, "");
  label = label || m;

  const low = m.toLowerCase();
  const network = MAINNET_HINTS.some((h) => low.includes(h))
    ? "mainnet"
    : TESTNET_HINTS.some((h) => low.includes(h))
      ? "testnet"
      : null;

  return { label, network };
}
