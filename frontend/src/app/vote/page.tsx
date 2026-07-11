"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { shortId } from "@/lib/format";
import type { VoteGasStatus } from "@/lib/types";
import { ConnectButton } from "@/components/ConnectButton";
import { Agent, Chip, PopButton, StickerCard, cx } from "@/components/zerun";
import { popButtonClass } from "@/components/zerun/PopButton";
import { Spinner } from "@/components/ui";

// Vote for Zerun in the 2026 0G Zero Cup.
//
// Most people who land here are on a phone and have never touched a wallet, so every step has to
// be one big obvious tap. The flow is one straight line ending in a BOOST: a boost is worth two
// votes to a plain vote's one, and it is the finish, not an extra. We remove the usual walls where
// we can (we hand out the gas so nobody has to fund a wallet), and we gate each step on the last
// so nobody gets stranded halfway.

// Where 0G puts the Google and X sign-in.
const SIGN_IN_URL = "https://0g.ai/arena/community/zero-cup";
// The quarter-final ballot: the page with Zerun on it.
const VOTE_URL = "https://0g.ai/arena/community/zero-cup/quarter-finals-zegon-vs-zerun";

// Boosting needs a wallet, and most people here do not have one. These are the two we point them
// at: both are free, both have a phone app, both open our page and 0G's inside them. One tap.
const RABBY_URL = "https://rabby.io/";
const OKX_WALLET_URL = "https://www.okx.com/download";

export default function VotePage() {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<VoteGasStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  const refresh = useCallback(() => {
    api
      .voteGasStatus(address ?? "")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [address]);

  useEffect(refresh, [refresh]);

  const claim = useCallback(async () => {
    if (!address) return;
    setError(null);
    setClaiming(true);
    try {
      await api.claimVoteGas(address);
      refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setClaiming(false);
    }
  }, [address, refresh]);

  const gasDone = Boolean(status?.claimed);
  const faucetOpen = Boolean(status?.enabled) && (status?.remainingClaims ?? 0) > 0;
  // The contract lets a wallet vote exactly once. If this one already has, the flow is moot.
  const alreadyVoted = isConnected && Boolean(status?.alreadyVoted);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <header className="text-center">
        <div className="mx-auto w-fit motion-safe:animate-pop-in">
          <Agent variant="violet" mood="happy" size={96} name="Zerun" />
        </div>
        <h1 className="mt-4 font-display text-4xl leading-tight text-ink sm:text-5xl">
          Vote for Zerun
        </h1>
        <p className="mx-auto mt-2 max-w-md font-body text-[15px] font-bold text-ink-2">
          We reached the quarter-finals of the 2026 0G Zero Cup. Boost your vote for Zerun in three
          quick steps. The small fee is on us.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Chip tone="won">quarter-finals</Chip>
          <Chip tone="live" pulse>
            voting open
          </Chip>
        </div>
      </header>

      {alreadyVoted ? (
        <AlreadyVoted />
      ) : (
        <div className="mt-8 space-y-4">
          <Step
            n={1}
            title="Get a wallet"
            done={isConnected && gasDone}
            body={
              !isConnected ? (
                <>
                  <p className="font-body text-[14px] text-ink-2">
                    To boost your vote you need a wallet: a free app that holds your vote. Most
                    people here are getting their first one, and it takes a minute.
                  </p>
                  <p className="mt-3 font-body text-[13px] font-extrabold text-ink">New here? Install one free:</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <a
                      href={RABBY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("secondary", "md", "w-full")}
                    >
                      Get Rabby
                    </a>
                    <a
                      href={OKX_WALLET_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("secondary", "md", "w-full")}
                    >
                      Get OKX Wallet
                    </a>
                  </div>
                  <p className="mt-4 font-body text-[13px] font-extrabold text-ink">
                    Already have a wallet? Connect it:
                  </p>
                  <div className="mt-2">
                    <ConnectButton />
                  </div>
                </>
              ) : gasDone ? (
                <p className="font-body text-[14px] font-extrabold text-ink">
                  Wallet ready and your free credit landed. You are set to boost.{" "}
                  {status?.txHash && (
                    <span className="font-mono text-[12px] font-bold text-ink-3">
                      {shortId(status.txHash, 8, 6)}
                    </span>
                  )}
                </p>
              ) : (
                <>
                  <p className="font-body text-[14px] text-ink-2">
                    Wallet connected. Boosting has a tiny fee, so we drop a little credit into your
                    wallet to cover it. Free, once, and yours to keep.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <PopButton
                      onClick={claim}
                      disabled={claiming || !faucetOpen}
                      className="w-full sm:w-auto"
                    >
                      {claiming ? "Sending…" : "Get my free credit"}
                    </PopButton>
                    {claiming && <Spinner />}
                    {!faucetOpen && (
                      <span className="font-body text-[13px] text-ink-3">
                        {status?.enabled
                          ? "The free credit has run out, but you can still boost with your own."
                          : "The free credit is paused right now, but you can still boost with your own."}
                      </span>
                    )}
                  </div>
                  {error && (
                    <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>
                  )}
                </>
              )
            }
          />

          <Step
            n={2}
            title="Sign in on 0G"
            done={signedIn}
            locked={!gasDone}
            body={
              <>
                <p className="font-body text-[14px] text-ink-2">
                  0G needs to know a vote came from a person. Open the Zero Cup page and sign in with
                  Google or X <strong className="text-ink">in this same browser</strong>, then come
                  back and tick the box.
                </p>
                <div className="mt-3 space-y-3">
                  <a
                    href={SIGN_IN_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={popButtonClass("secondary", "md", "w-full sm:w-auto")}
                  >
                    Open 0G and sign in
                  </a>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={signedIn}
                      onChange={(e) => setSignedIn(e.target.checked)}
                      className="h-5 w-5 rounded-md border-2 border-ink accent-violet"
                    />
                    <span className="font-body text-[13px] font-extrabold text-ink-2">
                      Done, I am signed in
                    </span>
                  </label>
                </div>
              </>
            }
          />

          <Step
            n={3}
            title="Boost for Zerun"
            locked={!signedIn}
            final
            body={
              <>
                <p className="font-body text-[14px] text-ink-2">
                  This is the finish. On 0G, connect the same wallet, pick Zerun, and choose{" "}
                  <strong className="text-ink">Boost</strong>. A boost counts as two votes, and the
                  free credit from step 1 pays for it.
                </p>
                <p className="mt-2 rounded-chunk border-line border-ink bg-amber/25 px-3 py-2 font-body text-[13px] font-extrabold text-ink">
                  You get one vote per wallet, and you cannot change it later. Pick Boost the first
                  time so it counts double. A normal vote counts once and cannot be topped up.
                </p>
                <div className="mt-4 flex items-center gap-3 rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3 shadow-pop-press">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-chunk border-line border-ink bg-violet font-display text-xl text-white shadow-pop-press">
                    Z
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-lg leading-tight text-ink">Zerun</span>
                    <span className="block font-body text-[12px] font-bold text-ink-2">
                      by Invincibles
                    </span>
                  </span>
                  <span className="ml-auto text-right">
                    <span className="block font-body text-[10px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
                      representing
                    </span>
                    <span className="block font-display text-[15px] leading-tight text-ink">
                      Portugal
                    </span>
                  </span>
                </div>
                <div className="mt-4">
                  <a
                    href={VOTE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={popButtonClass("primary", "lg", "w-full")}
                  >
                    Boost Zerun on 0G
                  </a>
                </div>
              </>
            }
          />
        </div>
      )}

      <p className="mt-8 text-center font-body text-[12px] text-ink-3">
        The free credit comes from Zerun&apos;s own wallet, one per person. We never ask for your
        recovery phrase or for permission to move anything you hold.
      </p>
    </main>
  );
}

/**
 * Shown when the connected wallet has already voted. There is nothing left for it to do here, so
 * this thanks the voter and points them at the one thing that still moves the score: a new person.
 */
function AlreadyVoted() {
  return (
    <div className="mt-8">
      <StickerCard className="p-6 text-center">
        <div className="mx-auto w-fit motion-safe:animate-pop-in">
          <Agent variant="mint" mood="happy" size={84} name="Zerun" />
        </div>
        <div className="mt-3 flex justify-center">
          <Chip tone="won">already voted</Chip>
        </div>
        <h2 className="mt-3 font-display text-2xl text-ink">This wallet has voted. Thank you.</h2>
        <p className="mx-auto mt-2 max-w-md font-body text-[14px] font-bold text-ink-2">
          A wallet can vote once and only once, so there is nothing more to do here with this one.
          The score moves from here on with new people, not new clicks.
        </p>
        <p className="mx-auto mt-3 max-w-md font-body text-[14px] text-ink-2">
          The biggest help now is bringing one friend who has not voted yet.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <a href={VOTE_URL} target="_blank" rel="noopener noreferrer">
            <PopButton variant="secondary">See the ballot</PopButton>
          </a>
        </div>
      </StickerCard>
    </div>
  );
}

/**
 * One numbered step. Locked steps stay readable but cannot be acted on out of order. The final
 * step wears a violet ring and a "finish" chip so nobody stops at the sign-in and calls it done.
 */
function Step({
  n,
  title,
  body,
  done = false,
  locked = false,
  final = false,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
  done?: boolean;
  locked?: boolean;
  final?: boolean;
}) {
  return (
    <StickerCard
      className={cx(
        "p-5 transition-opacity",
        locked && "opacity-55",
        final && !locked && "ring-4 ring-violet/30",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "grid h-10 w-10 shrink-0 place-items-center rounded-chunk border-line border-ink font-display text-lg shadow-pop-press",
            done ? "bg-mint text-candyink" : final ? "bg-violet text-white" : "bg-cloud text-ink",
          )}
          aria-hidden
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl text-ink">{title}</h2>
            {done && <Chip tone="won">done</Chip>}
            {final && !done && <Chip tone="live">finish</Chip>}
            {locked && !done && !final && <Chip tone="neutral">next</Chip>}
          </div>
          <div className="mt-2">{body}</div>
        </div>
      </div>
    </StickerCard>
  );
}
