import { shortAddr, shortId, formatLatency } from "@/lib/format";

interface Props {
  provider: string;
  model: string;
  chatId: string;
  latencyMs: number;
  verified: boolean | null;
  source?: string;
}

// The signature block of the product: makes 0G Compute provenance visible per
// answer. Provider, model, request id, latency, and the verification badge.
export function ProvenanceBadge({
  provider,
  model,
  chatId,
  latencyMs,
  verified,
  source,
}: Props) {
  const isVerified = verified === true;

  return (
    <div className="relative overflow-hidden rounded-md border border-signal/25 bg-ink-800/80 p-3">
      {/* signal edge */}
      <span
        className="absolute inset-x-0 top-0 h-px signal-line"
        aria-hidden
      />
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-600 uppercase tracking-[0.2em] text-signal">
          <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
          thought on 0G
        </span>
        <VerificationBadge verified={verified} />
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="provider" value={shortAddr(provider, 6, 4)} title={provider} />
        <Field label="model" value={model || "–"} title={model} />
        <Field label="request id" value={shortId(chatId, 7, 5)} title={chatId} />
        <Field label="latency" value={formatLatency(latencyMs)} />
      </dl>

      {source && (
        <div className="mt-2 border-t border-edge/40 pt-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-haze">
            source · {source}
          </span>
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
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-[0.18em] text-haze">{label}</dt>
      <dd className="truncate font-mono text-[12px] text-chalk" title={title}>
        {value}
      </dd>
    </div>
  );
}

export function VerificationBadge({ verified }: { verified: boolean | null }) {
  if (verified === true) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-signal/50 bg-signal/10 px-2.5 py-0.5 text-[11px] font-600 text-signal">
        <CheckIcon />
        Verified on 0G
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/45 bg-amber/10 px-2.5 py-0.5 text-[11px] font-600 text-amber">
      <DotIcon />
      Unverified
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 6.5L4.5 9L10 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
      <circle cx="4.5" cy="4.5" r="3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
