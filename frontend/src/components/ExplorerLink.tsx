import { txUrl, addressUrl } from "@/lib/explorer";
import { shortAddr, shortId } from "@/lib/format";
import { cx } from "./zerun/cx";

// A clickable proof: a tx hash or an address that opens on the 0G explorer in a
// new tab. Use anywhere on-chain provenance is shown so it can be verified live.
export function ExplorerLink({
  kind,
  value,
  label,
  className = "",
  underline = true,
}: {
  kind: "tx" | "address";
  value: string;
  label?: string;
  className?: string;
  underline?: boolean;
}) {
  if (!value) return null;
  const href = kind === "tx" ? txUrl(value) : addressUrl(value);
  const text = label ?? (kind === "tx" ? shortId(value, 6, 4) : shortAddr(value));
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`View on 0G explorer: ${value}`}
      className={cx(
        "inline-flex items-center gap-1 font-mono text-violet transition",
        underline
          ? "underline decoration-violet/40 underline-offset-2 hover:decoration-violet"
          : "hover:-translate-y-px",
        className,
      )}
    >
      {text}
      <Out />
    </a>
  );
}

function Out() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path d="M4.5 2.5H9.5V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 2.5L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 9.5H2.5V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
