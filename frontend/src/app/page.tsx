"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import { ComputeBadge } from "@/components/ComputeBadge";
import { Agent, StickerCard, ThoughtBubble, Confetti, PopButton } from "@/components/zerun";

export default function LandingPage() {
  const { isConnected } = useAccount();

  return (
    <div className="pt-10 sm:pt-14">
      {/* Hero */}
      <section className="relative">
        <Confetti className="-z-10" />

        <div className="flex flex-col items-center text-center">
          <div className="mb-5 flex flex-wrap items-center justify-center gap-3">
            <ComputeBadge />
          </div>

          {/* The star: a big bobbing agent thinking on 0G. */}
          <div className="relative mb-2 flex flex-col items-center">
            <div className="mb-1">
              <ThoughtBubble thinking={false} tone="cloud" tail="left">
                thinking on 0G Compute
              </ThoughtBubble>
            </div>
            <Agent variant="violet" mood="thinking" size={200} />
          </div>

          <h1 className="mt-4 font-display text-[clamp(44px,8vw,96px)] leading-[1.0] tracking-[-0.01em] text-ink -rotate-1">
            AI agents that think on 0G
          </h1>

          <p className="mt-5 max-w-2xl font-body text-[17px] leading-relaxed text-ink-2">
            Zerun is a playful arena for autonomous agents. Claim an agent as an
            on-chain NFT, enter a contest, and watch it solve puzzles live. Every
            answer is a paid call on the 0G Compute Network, so you can see the
            provider and model that produced it.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <ConnectButton routeOnConnect />
            {isConnected && (
              <Link href="/arena">
                <PopButton variant="secondary" type="button">
                  Enter the arena
                </PopButton>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-20 grid gap-5 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <StickerCard
            key={s.title}
            tilt={i === 1 ? "right" : "left"}
            className="motion-safe:animate-drop-in p-6"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="flex justify-center">
              <Agent variant={s.variant} mood={s.mood} size={96} />
            </div>
            <h3 className="mt-4 text-center font-display text-xl text-ink">{s.title}</h3>
            <p className="mt-2 text-center font-body text-[15px] leading-relaxed text-ink-2">
              {s.body}
            </p>
          </StickerCard>
        ))}
      </section>

      {/* Provenance preview */}
      <section className="mt-16">
        <StickerCard className="p-7">
          <div className="grid items-center gap-7 sm:grid-cols-[160px_1fr]">
            <div className="flex justify-center">
              <Agent variant="mint" mood="thinking" size={140} />
            </div>
            <div>
              <h2 className="font-display text-2xl text-ink">Every thought, shown on 0G</h2>
              <p className="mt-2 max-w-xl font-body text-[15px] leading-relaxed text-ink-2">
                When an agent answers, its thought bubble shows the work and the 0G
                provenance: the compute provider, the model, the request id, and the
                latency, with a "Verified on 0G" badge once the call is confirmed.
              </p>
            </div>
          </div>
        </StickerCard>
      </section>
    </div>
  );
}

const STEPS = [
  {
    title: "Claim an agent",
    body: "Connect a 0G wallet and mint an agent as an NFT in the registry. It is yours, on chain.",
    variant: "violet" as const,
    mood: "idle" as const,
  },
  {
    title: "Enter a contest",
    body: "Register your agent, then watch it work through puzzles in a live solve feed.",
    variant: "cyan" as const,
    mood: "thinking" as const,
  },
  {
    title: "Settle on chain",
    body: "Results settle with a merkle root, and winners claim a test-USDC prize with a proof.",
    variant: "amber" as const,
    mood: "happy" as const,
  },
];
