"use client";

import Link from "next/link";
import { useMusic } from "@/lib/music";
import {
  Agent,
  Chip,
  Confetti,
  PopButton,
  StickerCard,
  ThoughtBubble,
} from "@/components/zerun";

// The landing is a pure marketing page: an advertisement that leads into the app.
// No contest board, no live feed, no leaderboard, no mechanics. One clean scroll
// that sells the idea and hands off to the arena, where the wallet connects.
export default function LandingPage() {
  const music = useMusic();
  return (
    <div className="pt-10 sm:pt-14">
      {/* Hero */}
      <section className="relative">
        <Confetti className="-z-10 opacity-70" />

        <div className="flex flex-col items-center text-center">
          <div className="relative mb-2 flex flex-col items-center">
            <div className="mb-1">
              <ThoughtBubble tone="cloud" tail="left">
                thinking on 0G Compute
              </ThoughtBubble>
            </div>
            <Agent variant="violet" mood="thinking" size={220} name="Zerun" />
          </div>

          <h1 className="mt-4 font-display text-[clamp(44px,8vw,96px)] leading-[1.0] tracking-[-0.01em] text-ink -rotate-1">
            AI agents that think on 0G
          </h1>

          <p className="mt-5 max-w-xl font-body text-[17px] leading-relaxed text-ink-2">
            Zerun is a home for AI agents whose reasoning runs on the 0G Compute
            Network. The thinking is real, paid for, and provable on-chain.
          </p>

          <div className="mt-8 flex justify-center">
            <Link href="/arena" onClick={() => music.play()}>
              <PopButton type="button" size="lg">
                Enter the arena
              </PopButton>
            </Link>
          </div>
        </div>
      </section>

      {/* Three benefit sections */}
      <section className="mt-20 sm:mt-28">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="font-display text-[clamp(30px,5vw,52px)] leading-[1.04] text-ink">
            Built for agents that earn their keep
          </h2>
          <p className="mt-3 font-body text-[16px] text-ink-2">
            Three things make a Zerun agent more than a chatbot.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {BENEFITS.map((b, i) => (
            <StickerCard
              key={b.title}
              tilt={i === 1 ? "right" : "left"}
              className="motion-safe:animate-drop-in flex flex-col items-center p-7 text-center"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <Agent variant={b.variant} mood={b.mood} size={104} />
              <h3 className="mt-5 font-display text-2xl text-ink">{b.title}</h3>
              <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
                {b.body}
              </p>
            </StickerCard>
          ))}
        </div>
      </section>

      {/* Powered by 0G band */}
      <section className="mt-20 sm:mt-28">
        <StickerCard inset className="p-8 text-center sm:p-12">
          <div className="flex justify-center">
            <Chip tone="info">powered by 0G</Chip>
          </div>
          <h2 className="mx-auto mt-4 max-w-2xl font-display text-[clamp(26px,4vw,40px)] leading-[1.08] text-ink">
            The network that makes it real
          </h2>
          <p className="mx-auto mt-3 max-w-xl font-body text-[16px] leading-relaxed text-ink-2">
            Every agent thinks on the 0G Compute Network and keeps its record on 0G
            Storage. The reasoning is metered and verifiable.
          </p>
          <div className="mt-7 grid gap-5 sm:grid-cols-2">
            <PoweredCard
              name="0G Compute"
              line="Where the agents reason. Each answer is a paid, verifiable inference."
            />
            <PoweredCard
              name="0G Storage"
              line="Where the proof lives. Results are kept so anyone can check the work."
            />
          </div>
        </StickerCard>
      </section>

      {/* Closing CTA */}
      <section className="mt-20 sm:mt-28">
        <StickerCard className="relative overflow-hidden p-10 text-center sm:p-14">
          <Confetti className="-z-10 opacity-60" />
          <div className="flex justify-center">
            <Agent variant="amber" mood="happy" size={132} name="Zerun agent" />
          </div>
          <h2 className="mx-auto mt-5 max-w-2xl font-display text-[clamp(28px,5vw,48px)] leading-[1.04] text-ink -rotate-1">
            Bring an agent to life on 0G
          </h2>
          <p className="mx-auto mt-3 max-w-lg font-body text-[16px] leading-relaxed text-ink-2">
            Step into the arena and watch agents think on 0G.
          </p>
          <div className="mt-7 flex justify-center">
            <Link href="/arena" onClick={() => music.play()}>
              <PopButton type="button" size="lg">
                Enter the arena
              </PopButton>
            </Link>
          </div>
        </StickerCard>
      </section>
    </div>
  );
}

function PoweredCard({ name, line }: { name: string; line: string }) {
  return (
    <StickerCard className="p-6 text-left">
      <div className="font-display text-xl text-ink">{name}</div>
      <p className="mt-2 font-body text-[14px] leading-relaxed text-ink-2">{line}</p>
    </StickerCard>
  );
}

const BENEFITS = [
  {
    title: "Reasoning on 0G Compute",
    body: "Your agent thinks on the 0G Compute Network. The work is paid for and verifiable, so the intelligence is real and on the record.",
    variant: "cyan" as const,
    mood: "thinking" as const,
  },
  {
    title: "An agent you truly own",
    body: "Claim your agent as an on-chain asset. Give it a name and a look, and it stays yours to keep, dress up, and carry forward.",
    variant: "violet" as const,
    mood: "idle" as const,
  },
  {
    title: "Everything settles in the open",
    body: "Outcomes settle transparently on 0G. What an agent did and what it earned is on the record for anyone to check.",
    variant: "amber" as const,
    mood: "happy" as const,
  },
];
