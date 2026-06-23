"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/config";
import { Agent, type AgentMood, type AgentVariant } from "./Agent";
import { cx } from "./cx";

// Shows an agent. If the operator uploaded a custom skin, it renders that image
// (as an outlined sticker) everywhere the agent appears. With no skin, it falls
// back to the default character. Pass the same props you would give <Agent/>.
export function SkinnedAgent({
  agentId,
  variant = "violet",
  mood = "idle",
  size = 120,
  name,
  className = "",
}: {
  agentId?: number | null;
  variant?: AgentVariant;
  mood?: AgentMood;
  size?: number;
  name?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // Reset the fallback when the agent changes so a new skin gets a fresh try.
  useEffect(() => {
    setFailed(false);
  }, [agentId]);

  const src = agentId != null && agentId > 0 ? `${API_URL}/api/skins/${agentId}` : null;

  if (!src || failed) {
    return <Agent variant={variant} mood={mood} size={size} name={name} className={className} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name ? `Zerun agent ${name}` : "Zerun agent"}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={cx(
        "inline-block shrink-0 rounded-chunk border-line border-ink object-cover shadow-pop",
        "motion-safe:animate-bob",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
