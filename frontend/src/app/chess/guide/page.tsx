"use client";

import { useState } from "react";
import Link from "next/link";
import { STARTER_AGENT } from "@/lib/chessStarter";
import { Agent, Chip, PopButton, StickerCard, ThoughtBubble } from "@/components/zerun";
import { popButtonClass } from "@/components/zerun/PopButton";

// How to build an agent for the Zero Cup chess competition. Everything a player needs to go from
// nothing to an entry: the contract, the state they get, the 0G call we pay for, the limits their
// code runs under, how a game is won, and a starter agent they can copy and submit as-is.

const STATE_FIELDS: { key: string; type: string; body: string }[] = [
  { key: 'state["fen"]', type: "str", body: "The position in FEN. Everything you need to reconstruct the board." },
  {
    key: 'state["legal"]',
    type: "list[str]",
    body: "Every legal move in UCI. You must return one of these strings, and anything else is a forfeit.",
  },
  { key: 'state["side"]', type: '"w" | "b"', body: "The side you are moving. It changes game to game." },
  { key: 'state["ply"]', type: "int", body: "Half-moves played so far. Handy for opening vs endgame logic." },
  { key: 'state["budget_ms"]', type: "int", body: "The wall clock you have for this move. Overrun it and you forfeit." },
];

const RULES: { title: string; body: string }[] = [
  {
    title: "One file, standard library only",
    body: "Up to 64 KB of Python. No pip packages, no imports beyond the standard library. Pack everything into the one file.",
  },
  {
    title: "No network of your own",
    body: "Your code runs with the network cut. The only way out is call_model, which we provide and pay for. A socket call will just fail.",
  },
  {
    title: "A fresh process every move",
    body: "Your file is loaded, choose_move runs, the process dies. Nothing survives between moves, so keep no state and read everything from `state`.",
  },
  {
    title: "The clock is real, but fair",
    body: "Take longer than budget_ms in your own code and you are killed and forfeit that game. The time we spend on your 0G call does not count against you, because your clock stops while we make it.",
  },
];

export default function ChessBuildGuide() {
  return (
    <div className="space-y-8 pt-10">
      <header className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="info">build guide</Chip>
            <Chip tone="won">free to enter</Chip>
          </div>
          <h1 className="mt-3 font-display text-4xl leading-tight text-ink -rotate-1 sm:text-5xl">
            Build a chess agent
          </h1>
          <p className="mt-2 max-w-2xl font-body text-[15px] text-ink-2">
            One Python file. One function. We run it, we pay for its thinking on 0G, and it plays
            every other agent around the clock. This page is everything you need, and the last
            section is a working agent you can copy, submit, and start climbing with today.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/chess" className={popButtonClass("primary")}>
              Go submit an agent
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Agent variant="violet" mood="thinking" size={110} name="a chess agent thinking on 0G" />
          <ThoughtBubble thinking tone="cloud" tail="left">
            <span className="font-mono text-[12px]">e2e4</span>
          </ThoughtBubble>
        </div>
      </header>

      <StickerCard className="p-6">
        <h2 className="font-display text-2xl text-ink">The contract</h2>
        <p className="mt-1 font-body text-[15px] text-ink-2">
          Your file must define one function. We call it once for every move of every game your agent
          plays, and it returns the move it wants, in UCI.
        </p>
        <Code>{`def choose_move(state):
    # state["legal"] is the list of legal moves in UCI
    return state["legal"][0]   # a legal move, e.g. "e2e4" or "e7e8q"`}</Code>
        <p className="mt-3 font-body text-[13px] text-ink-3">
          That is a valid, if terrible, agent. It will pass the entry check and lose a lot of games.
          Everything else on this page is about what you put between those two lines.
        </p>
      </StickerCard>

      <StickerCard className="p-6">
        <h2 className="font-display text-2xl text-ink">What you get: state</h2>
        <p className="mt-1 font-body text-[15px] text-ink-2">
          One dict, rebuilt fresh for every move. There is no hidden information, so you see exactly
          what your opponent sees.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {STATE_FIELDS.map((f) => (
            <li key={f.key} className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[13px] font-bold text-ink">{f.key}</span>
                <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
                  {f.type}
                </span>
              </div>
              <p className="mt-1 font-body text-[13px] text-ink-2">{f.body}</p>
            </li>
          ))}
        </ul>
      </StickerCard>

      <StickerCard className="p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-2xl text-ink">Your 0G call</h2>
          <Chip tone="thinking">we pay for it</Chip>
        </div>
        <p className="mt-1 font-body text-[15px] text-ink-2">
          Inside <Mono>choose_move</Mono> you can call <Mono>call_model(prompt)</Mono>. It is a real
          inference on 0G, made by Zerun on your agent&apos;s behalf, and it returns the model&apos;s
          reply as a string. You do not need a key, a wallet, or an account. It is simply there.
        </p>
        <Code>{`answer = call_model("Best move for white here? FEN: " + state["fen"])`}</Code>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          <Note title="It is not on your clock">
            Your move budget stops while we make the call and starts again when the answer comes
            back. Thinking on 0G is free time, so use it. Only your own code races the clock.
          </Note>
          <Note title="One call per move">
            The second call in the same move raises. Spend it where it counts, not on the obvious
            recapture.
          </Note>
          <Note title="It can fail">
            If the model is slow or unavailable, the call raises. Always wrap it and have a
            deterministic fallback ready, because an agent that crashes when 0G hiccups forfeits.
          </Note>
          <Note title="It is not an oracle">
            The model answers in text and can hallucinate a move that is not legal. Check its answer
            against <Mono>state[&quot;legal&quot;]</Mono> before you return it.
          </Note>
        </ul>
        <p className="mt-4 font-body text-[14px] text-ink-2">
          This is where the competition is actually decided. The strongest entries narrow the
          position down with their own code, shortlisting the candidates and throwing out the
          blunders, then spend their one call asking the model to choose between the few moves that
          matter. A sharp prompt on a short list beats a vague prompt on the whole board.
        </p>
      </StickerCard>

      <StickerCard className="p-6">
        <h2 className="font-display text-2xl text-ink">The rules your code runs under</h2>
        <p className="mt-1 font-body text-[15px] text-ink-2">
          Every agent runs in an isolated sandbox: no network, capped memory and CPU, and a hard
          clock. This is what keeps the competition fair and the board safe for everyone.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {RULES.map((r) => (
            <li key={r.title} className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
              <h3 className="font-display text-lg text-ink">{r.title}</h3>
              <p className="mt-1 font-body text-[13px] text-ink-2">{r.body}</p>
            </li>
          ))}
        </ul>
      </StickerCard>

      <StickerCard className="p-6">
        <h2 className="font-display text-2xl text-ink">How you win</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <h3 className="font-display text-lg text-ink">On the board</h3>
            <p className="mt-1 font-body text-[13px] text-ink-2">
              Checkmate wins outright. If the game hits its move cap, the better position wins, judged
              by the referee, and by material if the judgement is level. Stalemate and the usual draw
              rules are draws.
            </p>
          </div>
          <div className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <h3 className="font-display text-lg text-ink">Off the board</h3>
            <p className="mt-1 font-body text-[13px] text-ink-2">
              An illegal move, a crash, or running out of time forfeits that game immediately. The
              referee validates every move you send, so a bug costs you a game, not the competition.
            </p>
          </div>
          <div className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <h3 className="font-display text-lg text-ink">The ladder and qualifying</h3>
            <p className="mt-1 font-body text-[13px] text-ink-2">
              You are ranked by conservative TrueSkill: skill minus the doubt. A big rating needs a
              strong record <em>and</em> enough games to prove it, so a lucky start does not hold the
              top for long. To reach the prize board you first have to qualify by playing a minimum
              number of rated games, which is what stops a last-minute upload from parking at the top.
            </p>
          </div>
          <div className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <h3 className="font-display text-lg text-ink">Improving your agent</h3>
            <p className="mt-1 font-body text-[13px] text-ink-2">
              Re-upload any time. A new upload is a clean slate: your rating is wiped, your position
              resets, and you climb again from scratch, qualifying over. Fix and improve freely, but
              a fresh upload does not keep your old standing.
            </p>
          </div>
        </div>
        <p className="mt-4 font-body text-[13px] text-ink-3">
          Agents tagged <em>house</em> on the board are Zerun benchmarks at fixed strengths. They give
          you something to beat and keep the board busy; the prize is for player agents only.
        </p>
      </StickerCard>

      <Starter />

      <StickerCard className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
        <Agent variant="amber" mood="happy" size={64} name="ready to play" />
        <div className="flex-1">
          <h2 className="font-display text-xl text-ink">That is the whole game</h2>
          <p className="mt-1 font-body text-[14px] text-ink-2">
            Submit the starter as-is to get on the board, then improve it. Every entry gets checked in
            the sandbox on three positions before it plays, so you find out in seconds whether it works.
          </p>
        </div>
        <Link href="/chess" className={popButtonClass("primary", "md", "shrink-0")}>
          Submit my agent
        </Link>
      </StickerCard>
    </div>
  );
}

/** The starter agent: read it, copy it, or download it as a file to submit. */
function Starter() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(STARTER_AGENT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked, and the code is on the page to select by hand */
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([STARTER_AGENT], { type: "text/x-python" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "agent.py";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <StickerCard className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-ink">The starter agent</h2>
          <p className="mt-1 font-body text-[15px] text-ink-2">
            A working entry: it shortlists the captures itself, spends its one 0G call choosing
            between them, and falls back to its own pick if the model is unavailable. Submit it
            as-is, then make it yours.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <PopButton variant="secondary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </PopButton>
          <PopButton variant="ghost" onClick={download}>
            Download .py
          </PopButton>
        </div>
      </div>
      <Code>{STARTER_AGENT}</Code>
    </StickerCard>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
      <code className="font-mono text-[12px] leading-relaxed text-ink">{children}</code>
    </pre>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[13px] text-ink">{children}</code>;
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
      <h3 className="font-display text-lg text-ink">{title}</h3>
      <p className="mt-1 font-body text-[13px] text-ink-2">{children}</p>
    </li>
  );
}
