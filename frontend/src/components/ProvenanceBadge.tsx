import { shortAddr, shortId, formatLatency } from "@/lib/format";
import { Chip } from "./zerun/Chip";
import { ExplorerLink } from "./ExplorerLink";
import { ModelChip } from "./ModelChip";
import { modelInfo } from "@/lib/model";

// A 20-byte hex account. Only these get an explorer link; strategy-engine labels
// like "deterministic" are not on-chain providers and render as plain text.
function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

// Not every answer is a 0G call, and the card must not pretend otherwise.
//
// A poker action is decided by the deterministic tier-scaled strategy engine (source
// "strategy", provider "deterministic", 0ms) unless POKER_0G_POLICY is on, and even then 0G
// only authors the tuning, not the action. A chess move falls back to the engine's own best
// when a 0G call fails (source "engine"). Both were rendering under a "thought on 0G Compute"
// header with an "On 0G Compute" chip, which is the one claim this product cannot afford to
// make loosely.
function isOnZeroG(source?: string): boolean {
  return source === "0g-compute" || source === "0g-router";
}

function headerFor(source?: string): string {
  switch (source) {
    case "0g-compute":
    case "0g-router":
      return "thought on 0G Compute";
    case "strategy":
      return "decided by the tier engine";
    case "engine":
      return "played by the chess engine";
    case "offline-dev":
      return "offline stub, not 0G";
    default:
      return "provenance";
  }
}

interface Props {
  provider: string;
  model: string;
  chatId: string;
  latencyMs: number;
  verified: boolean | null;
  source?: string;
  // Self-consistency passes: how many 0G inference calls this one answer took.
  // A higher-Compute agent runs more, so this is the visible "more compute" signal.
  samples?: number;
  // Analyst research: sources the agent gathered before forecasting (a top-tier
  // Compute perk). The clearest "this agent did the work" signal in a market.
  sources?: number;
}

// The 0G provenance for one answer, reframed for the cartoon look: a small inset
// panel that names the compute provider, model, request id, and latency, with a
// "Verified on 0G" chip. Rendered inside an agent's card under its ThoughtBubble.
export function ProvenanceBadge({
  provider,
  model,
  chatId,
  latencyMs,
  verified,
  source,
  samples,
  sources,
}: Props) {
  const isVerified = verified === true;

  return (
    <div className="rounded-chunk border-line border-ink bg-cloud-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
          {headerFor(source)}
        </span>
        <VerificationBadge verified={verified} source={source} />
      </div>

      {/* The 0G model, promoted to a glance-able chip: which model reasoned, on which network. */}
      {modelInfo(model) && (
        <div className="mt-2.5">
          <ModelChip model={model} />
        </div>
      )}

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="font-body text-[10px] font-extrabold uppercase tracking-[0.02em] text-ink-3">
            provider
          </dt>
          <dd className="truncate text-[12px]">
            {provider && isAddress(provider) ? (
              <ExplorerLink kind="address" value={provider} label={shortAddr(provider, 6, 4)} />
            ) : (
              // A non-address provider (e.g. the deterministic strategy engine) is not a
              // real on-chain account, so show it as plain text with no explorer link.
              <span className="truncate font-mono text-ink" title={provider}>
                {provider || "·"}
              </span>
            )}
          </dd>
        </div>
        {/* The model is the chip above now; keep the raw id here only when it is not a recognised
            0G model (so nothing is lost for the offline stub or an odd provider string). */}
        {!modelInfo(model) && <Field label="model" value={model || "·"} title={model} />}
        <Field label="request id" value={shortId(chatId, 7, 5)} title={chatId} />
        <Field label="latency" value={formatLatency(latencyMs)} />
        {samples != null && samples > 0 && (
          <Field label="0G passes" value={`${samples}`} accent />
        )}
        {sources != null && sources > 0 && (
          <Field label="researched" value={`${sources} sources`} accent />
        )}
      </dl>

      {source && (
        <div className="mt-2 border-t-line border-ink/15 pt-2">
          <span className="font-mono text-[11px] text-ink-3">source · {source}</span>
        </div>
      )}

      <span className="sr-only">
        {isVerified
          ? "This answer was verified on 0G Compute."
          : "This answer is not yet verified."}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  title,
  accent = false,
}: {
  label: string;
  value: string;
  title?: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="font-body text-[10px] font-extrabold uppercase tracking-[0.02em] text-ink-3">
        {label}
      </dt>
      <dd
        className={`truncate font-mono text-[12px] ${accent ? "font-bold text-violet" : "text-ink"}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

export function VerificationBadge({ verified, source }: { verified: boolean | null; source?: string }) {
  if (verified === true) {
    return (
      <Chip tone="live">
        <span className="inline-flex items-center gap-1">
          <CheckIcon /> Verified on 0G
        </span>
      </Chip>
    );
  }
  // Only a real 0G call may claim 0G. An engine decision is deterministic and off-chain, and
  // saying so is the difference between a provenance badge and a decoration.
  if (!isOnZeroG(source)) {
    return <Chip tone="neutral">{source === "offline-dev" ? "Offline" : "Deterministic"}</Chip>;
  }
  return <Chip tone="info">On 0G Compute</Chip>;
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 6.5L4.5 9L10 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
