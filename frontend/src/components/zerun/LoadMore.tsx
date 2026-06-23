"use client";

import { PopButton } from "./PopButton";

// A friendly "Load more" control for lists that grow. Shows how many remain and
// reveals the next batch on tap. Keep lists short and tappable, never endless.
export function LoadMore({
  remaining,
  onMore,
  label = "Load more",
  className = "",
}: {
  remaining: number;
  onMore: () => void;
  label?: string;
  className?: string;
}) {
  if (remaining <= 0) return null;
  return (
    <div className={`flex justify-center ${className}`}>
      <PopButton type="button" variant="ghost" onClick={onMore}>
        {label}
        <span className="ml-1.5 font-mono text-[12px] text-ink-3">+{remaining}</span>
      </PopButton>
    </div>
  );
}
