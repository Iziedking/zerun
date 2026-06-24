import { shortAddr, shortId, formatLatency } from "@/lib/format";
import { Chip } from "./zerun/Chip";

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
}: Props) {
  const isVerified = verified === true;

  return (
    <div className="rounded-chunk border-line border-ink bg-cloud-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
          thought on 0G Compute
        </span>
        <VerificationBadge verified={verified} />
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label="provider" value={shortAddr(provider, 6, 4)} title={provider} />
        <Field label="model" value={model || "·"} title={model} />
        <Field label="request id" value={shortId(chatId, 7, 5)} title={chatId} />
        <Field label="latency" value={formatLatency(latencyMs)} />
        {samples != null && samples > 0 && (
          <Field label="0G passes" value={`${samples}`} accent />
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

export function VerificationBadge({ verified }: { verified: boolean | null }) {
  if (verified === true) {
    return (
      <Chip tone="live">
        <span className="inline-flex items-center gap-1">
          <CheckIcon /> Verified on 0G
        </span>
      </Chip>
    );
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
