"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/config";
import { useAgentAvatars } from "@/lib/useAgents";
import { Agent, type AgentMood, type AgentVariant } from "./Agent";
import { cx } from "./cx";

// Shows an agent's avatar with a clear priority, everywhere the agent appears
// (games, standings, ladder, leaderboard, profile):
//   1. the owner's X profile picture, if they connected X — it overrides the skin;
//   2. the operator's uploaded custom skin;
//   3. the default cartoon character.
// Pass the same props you would give <Agent/>.
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
  const [skinFailed, setSkinFailed] = useState(false);
  const [xFailed, setXFailed] = useState(false);

  // Reset both fallbacks when the agent changes so a new avatar gets a fresh try.
  useEffect(() => {
    setSkinFailed(false);
    setXFailed(false);
  }, [agentId]);

  const { data: avatars } = useAgentAvatars();
  const xUrl = agentId != null && agentId > 0 ? avatars?.avatars?.[String(agentId)] : undefined;
  const skinSrc = agentId != null && agentId > 0 ? `${API_URL}/api/skins/${agentId}` : null;

  const imgClass = cx(
    "inline-block shrink-0 rounded-chunk border-line border-ink object-cover shadow-pop",
    "motion-safe:animate-bob",
    className,
  );
  const alt = name ? `Zerun agent ${name}` : "Zerun agent";

  // 1. X profile picture wins when connected.
  if (xUrl && !xFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={xUrl}
        alt={alt}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setXFailed(true)}
        className={imgClass}
        style={{ width: size, height: size }}
      />
    );
  }

  // 2. Uploaded skin.
  if (skinSrc && !skinFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={skinSrc}
        alt={alt}
        width={size}
        height={size}
        onError={() => setSkinFailed(true)}
        className={imgClass}
        style={{ width: size, height: size }}
      />
    );
  }

  // 3. Default character.
  return <Agent variant={variant} mood={mood} size={size} name={name} className={className} />;
}
