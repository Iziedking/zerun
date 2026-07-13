import { modelInfo } from "@/lib/model";
import { cx } from "./zerun/cx";

// The 0G model behind an answer, shown as a glance-able chip: the model name in mono, a dot colored
// by network, and a small mainnet/testnet tag. This is the "different models, on which network"
// signal the arena is built to show. Renders nothing for non-models (the offline stub, errors).
export function ModelChip({ model, className = "" }: { model: string | null | undefined; className?: string }) {
  const info = modelInfo(model);
  if (!info) return null;
  const dot =
    info.network === "mainnet" ? "bg-amber" : info.network === "testnet" ? "bg-ink-3" : "bg-violet";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-pill border-line border-ink bg-cloud px-2.5 py-1 shadow-pop-press",
        className,
      )}
      title={`0G model: ${model}${info.network ? ` (${info.network})` : ""}`}
    >
      <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="font-mono text-[12px] font-bold leading-none text-ink">{info.label}</span>
      {info.network && (
        <span className="font-body text-[10px] font-extrabold uppercase leading-none tracking-[0.04em] text-ink-3">
          {info.network}
        </span>
      )}
    </span>
  );
}
