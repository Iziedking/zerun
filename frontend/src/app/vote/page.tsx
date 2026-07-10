"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { shortId } from "@/lib/format";
import type { VoteGasStatus } from "@/lib/types";
import { ConnectButton } from "@/components/ConnectButton";
import { Agent, Chip, PopButton, StickerCard, cx } from "@/components/zerun";
import { Spinner } from "@/components/ui";

// Vote for Zerun in the 2026 0G Zero Cup.
//
// The vote itself lives on 0G's site, not ours, and boosting it costs mainnet gas. Most people
// arriving from a tweet have a wallet with nothing in it, hit a gas error, and give up. So this
// page does the one thing we can do for them: it sends them the gas, then walks them to the
// booth in the right order. Every step is gated on the one before it, because doing them out of
// order is exactly how people get stranded.

// Two different destinations, and sending someone to the wrong one wastes their trip.
//
// The Zero Cup hub is where 0G puts the Google and X sign-in. Step 2 opens THAT, the voter
// connects, comes back, and ticks the box.
const SIGN_IN_URL = "https://0g.ai/arena/community/zero-cup";
// The quarter-final itself is the ballot: this is the page with Zerun on it.
const VOTE_URL = "https://0g.ai/arena/community/zero-cup/quarter-finals-zegon-vs-zerun";

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

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <header className="text-center">
        <div className="mx-auto w-fit motion-safe:animate-pop-in">
          <Agent variant="violet" mood="happy" size={96} name="Zerun" />
        </div>
        <h1 className="mt-4 font-display text-4xl leading-tight text-ink sm:text-5xl">
          Vote for Zerun
        </h1>
        <p className="mx-auto mt-2 max-w-xl font-body text-[15px] font-bold text-ink-2">
          We reached the quarter-finals of the 2026 0G Zero Cup. Boosting a vote costs a little
          mainnet gas, so we are covering it. Four steps, about a minute.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Chip tone="won">quarter-finals</Chip>
          <Chip tone="live" pulse>
            voting open
          </Chip>
        </div>
      </header>

      <div className="mt-10 space-y-4">
        <Step
          n={1}
          title="Claim your gas"
          done={gasDone}
          body={
            <>
              <p className="font-body text-[14px] text-ink-2">
                We send {status?.amountOg ?? "0.0001"} 0G of real mainnet gas straight to your
                wallet. Once per wallet, and it costs you nothing.
              </p>
              {!isConnected ? (
                <div className="mt-3">
                  <ConnectButton />
                </div>
              ) : gasDone ? (
                <p className="mt-3 font-body text-[14px] font-extrabold text-ink">
                  Gas landed.{" "}
                  {status?.txHash && (
                    <span className="font-mono text-[12px] font-bold text-ink-3">
                      {shortId(status.txHash, 8, 6)}
                    </span>
                  )}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <PopButton onClick={claim} disabled={claiming || !faucetOpen}>
                    {claiming ? "Sending…" : "Claim gas"}
                  </PopButton>
                  {claiming && <Spinner />}
                  {!faucetOpen && (
                    <span className="font-body text-[13px] text-ink-3">
                      {status?.enabled
                        ? "The faucet has run dry. You can still vote with your own gas."
                        : "The faucet is closed right now. You can still vote with your own gas."}
                    </span>
                  )}
                </div>
              )}
              {error && <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>}
            </>
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
                0G needs to know a vote came from a person. Open the Zero Cup page and connect
                with Google or X <strong className="text-ink">in this same browser</strong>, then
                come back and tick the box.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a href={SIGN_IN_URL} target="_blank" rel="noopener noreferrer">
                  <PopButton variant="secondary">Open 0G and sign in</PopButton>
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
          title="Boost with your wallet"
          locked={!signedIn}
          body={
            <p className="font-body text-[14px] text-ink-2">
              On the 0G page, connect the same wallet you just funded and boost your vote. The gas
              from step 1 pays for it. A boost counts for more than a plain vote, which is the
              whole reason we sent you the gas.
            </p>
          }
        />

        <Step
          n={4}
          title="Pick Zerun"
          locked={!signedIn}
          body={
            <>
              <p className="font-body text-[14px] text-ink-2">
                This is us on the ballot. Representing Portugal, by Invincibles.
              </p>
              <div className="mt-3 flex items-center gap-3 rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3 shadow-pop-press">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-chunk border-line border-ink bg-violet font-display text-xl text-white shadow-pop-press">
                  Z
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-lg leading-tight text-ink">Zerun</span>
                  <span className="block font-body text-[12px] font-bold text-ink-2">by Invincibles</span>
                </span>
                <span className="ml-auto text-right">
                  <span className="block font-body text-[10px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
                    representing
                  </span>
                  <span className="block font-display text-[15px] leading-tight text-ink">Portugal</span>
                </span>
              </div>
              <div className="mt-4">
                <a href={VOTE_URL} target="_blank" rel="noopener noreferrer">
                  <PopButton>Go vote for Zerun</PopButton>
                </a>
              </div>
            </>
          }
        />
      </div>

      <p className="mt-8 text-center font-body text-[12px] text-ink-3">
        Gas is sent from Zerun&apos;s own wallet on 0G mainnet. One claim per wallet. We never ask
        for a signature, a seed phrase, or an approval to take anything.
      </p>
    </main>
  );
}

/** One numbered step. Locked steps stay readable but cannot be acted on out of order. */
function Step({
  n,
  title,
  body,
  done = false,
  locked = false,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
  done?: boolean;
  locked?: boolean;
}) {
  return (
    <StickerCard className={cx("p-5 transition-opacity", locked && "opacity-55")}>
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "grid h-10 w-10 shrink-0 place-items-center rounded-chunk border-line border-ink font-display text-lg shadow-pop-press",
            done ? "bg-mint text-candyink" : "bg-cloud text-ink",
          )}
          aria-hidden
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl text-ink">{title}</h2>
            {done && <Chip tone="won">done</Chip>}
            {locked && !done && <Chip tone="neutral">next</Chip>}
          </div>
          <div className="mt-2">{body}</div>
        </div>
      </div>
    </StickerCard>
  );
}
