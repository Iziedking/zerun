import type { ReactNode } from "react";

export function Pill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "signal" | "amber" | "ember";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-edge/70 text-haze",
    signal: "border-signal/40 text-signal bg-signal/5",
    amber: "border-amber/40 text-amber bg-amber/5",
    ember: "border-ember/40 text-ember bg-ember/5",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-500 uppercase tracking-[0.12em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatChip({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.18em] text-haze">{label}</span>
      <span className={`text-bone ${mono ? "font-mono text-[13px]" : "text-sm font-500"}`}>
        {value}
      </span>
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  );
}

export function StatusDot({ live }: { live: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {live && (
        <span className="absolute inline-flex h-full w-full animate-pulse-dot rounded-full bg-signal" />
      )}
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${
          live ? "bg-signal" : "bg-haze"
        }`}
      />
    </span>
  );
}
