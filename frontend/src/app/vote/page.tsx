"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { VoteGasStatus } from "@/lib/types";
import { useConnectModal } from "@rainbow-me/rainbowkit";
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
// The semi-final ballot: the page with Zerun on it (AskZero vs Zerun).
const VOTE_URL = "https://0g.ai/arena/community/zero-cup/semi-finals-askzero-vs-zerun";

// Boosting needs a wallet, and most people here do not have one. These are the ones we point them
// at: all free, all with a phone app, all able to open our page and 0G's inside them. One tap.
const METAMASK_URL = "https://metamask.io/download/";
const RABBY_URL = "https://rabby.io/";
const OKX_WALLET_URL = "https://www.okx.com/download";
// On a phone the generic download page does not load, so we send people straight to the store for
// their OS. OKX is the smoothest wallet on mobile, so it is what we recommend there.
const OKX_IOS_URL = "https://apps.apple.com/us/app/okx-buy-bitcoin-btc-crypto/id1327268470";
const OKX_ANDROID_URL = "https://play.google.com/store/apps/details?id=com.okinc.okex.gp";

// A compact wallet chip: small and quiet, since three of them sit in a row and they are the
// fallback for people without a wallet, not the main action.
const WALLET_CHIP =
  "inline-flex min-h-[40px] items-center justify-center rounded-chunk border-line border-ink bg-cloud px-2 text-center font-body text-[13px] font-extrabold text-ink shadow-pop-press transition-[transform,box-shadow] duration-150 ease-spring hover:-translate-y-px hover:shadow-pop";

// How long we hold on the "taking you to boost" card before sending the tab to 0G. Enough for the
// credit transfer to propagate so the wallet has the fee ready when they arrive to boost.
const REDIRECT_MS = 3500;

export default function VotePage() {
  const { address, isConnected } = useAccount();
  // The vote route is not the app. All the faucet needs is a connected address to send credit to,
  // so we open the wallet picker and stop there: no chain switch, no sign-in signature. The whole
  // "prove it is you" onboarding lives elsewhere and is suppressed on this page.
  const { openConnectModal } = useConnectModal();
  const [status, setStatus] = useState<VoteGasStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voted, setVoted] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [showOkxStores, setShowOkxStores] = useState(false);
  const isMobile = useIsMobile();

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
      // Credit is on its way. Hand them straight to the boost page instead of asking for another
      // tap: the whole point of this route is to get them to the ballot with a funded wallet.
      setRedirecting(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setClaiming(false);
    }
  }, [address, refresh]);

  // Once the credit is sent, hold on the hand-off card for a beat, then send the tab to 0G's
  // boost page. A same-tab navigation (not a popup) so no mobile blocker can eat it.
  useEffect(() => {
    if (!redirecting) return;
    const t = setTimeout(() => {
      window.location.href = VOTE_URL;
    }, REDIRECT_MS);
    return () => clearTimeout(t);
  }, [redirecting]);

  // A returning voter who still holds enough gas from an earlier round needs no credit. Once they
  // have marked step 1 done and connected such a wallet, there is nothing to claim, so send them
  // straight to the ballot. This is what turns a re-vote into two taps instead of the whole flow.
  const hasEnoughGas = isConnected && Boolean(status?.hasEnoughGas);
  const alreadyVoted = isConnected && Boolean(status?.alreadyVoted);
  useEffect(() => {
    if (voted && hasEnoughGas && !alreadyVoted && !redirecting) setRedirecting(true);
  }, [voted, hasEnoughGas, alreadyVoted, redirecting]);

  const faucetOpen = Boolean(status?.enabled) && (status?.remainingClaims ?? 0) > 0;
  // Ready to boost once the connected wallet actually has the fee covered: it holds enough gas
  // (whether from now or an earlier round), or the free credit has run out and it covers the tiny
  // fee itself. This is deliberately NOT "has it ever claimed": a wallet that claimed before but is
  // short after a gas spike still needs a top-up, so it keeps the claim button and can reclaim.
  const walletReady = isConnected && (hasEnoughGas || !faucetOpen);

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
          We reached the semi-finals of the 2026 0G Zero Cup. Vote for Zerun in seconds with no
          wallet, then double it if you can. The fee for that is on us.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Chip tone="won">semi-finals</Chip>
          <Chip tone="live" pulse>
            voting open
          </Chip>
        </div>
      </header>

      {alreadyVoted ? (
        <AlreadyVoted />
      ) : redirecting ? (
        <Redirecting />
      ) : (
        <div className="mt-8 space-y-4">
          <ReturningVoterNote />

          {/* Step 1, the plain vote. Free, no wallet, and it banks a point right away. On 0G a
              plain vote can be upgraded to a boost later, so locking it in now has no downside:
              worst case we keep this vote, best case we double it in step 3. */}
          <Step
            n={1}
            title="Vote now, it is free"
            done={voted}
            body={
              <>
                <p className="font-body text-[14px] text-ink-2">
                  Two quick taps, both on 0G. First sign in with Google or X, then open the ballot
                  and pick Zerun. That is your vote, banked with no wallet and no fee. You can make it
                  count double in a minute.
                </p>
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-pill border-line border-ink bg-cloud font-display text-[13px] text-ink shadow-pop-press" aria-hidden>
                      A
                    </span>
                    <a
                      href={SIGN_IN_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("secondary", "md", "w-full")}
                    >
                      Sign in on 0G
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-pill border-line border-ink bg-cloud font-display text-[13px] text-ink shadow-pop-press" aria-hidden>
                      B
                    </span>
                    <a
                      href={VOTE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("primary", "md", "w-full")}
                    >
                      Open the ballot and pick Zerun
                    </a>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      checked={voted}
                      onChange={(e) => setVoted(e.target.checked)}
                      className="h-5 w-5 rounded-md border-2 border-ink accent-violet"
                    />
                    <span className="font-body text-[13px] font-extrabold text-ink-2">
                      Done, I voted for Zerun
                    </span>
                  </label>
                </div>
              </>
            }
          />

          {/* Step 2, the wallet and the credit that pays the boost fee, to double the vote above. */}
          <Step
            n={2}
            title="Claim voting credit"
            done={walletReady}
            locked={!voted}
            body={
              !isConnected ? (
                isMobile ? (
                  <MobileWalletInstall
                    showOkxStores={showOkxStores}
                    onGetOkx={() => setShowOkxStores(true)}
                    onConnect={() => openConnectModal?.()}
                    connectReady={Boolean(openConnectModal)}
                  />
                ) : (
                  <>
                    <p className="font-body text-[14px] text-ink-2">
                      To double your vote you need a wallet: a free app that holds it. Most people here
                      are getting their first one, and it takes a minute.
                    </p>
                    <p className="mt-3 font-body text-[13px] font-extrabold text-ink">New here? Install one free:</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <a href={METAMASK_URL} target="_blank" rel="noopener noreferrer" className={WALLET_CHIP}>
                        MetaMask
                      </a>
                      <a href={RABBY_URL} target="_blank" rel="noopener noreferrer" className={WALLET_CHIP}>
                        Rabby
                      </a>
                      <a href={OKX_WALLET_URL} target="_blank" rel="noopener noreferrer" className={WALLET_CHIP}>
                        OKX
                      </a>
                    </div>
                    <p className="mt-4 font-body text-[13px] font-extrabold text-ink">
                      Already have a wallet? Connect it:
                    </p>
                    <div className="mt-2">
                      <PopButton
                        onClick={() => openConnectModal?.()}
                        disabled={!openConnectModal}
                        className="w-full sm:w-auto"
                      >
                        Connect wallet
                      </PopButton>
                    </div>
                  </>
                )
              ) : hasEnoughGas ? (
                // Already funded from an earlier round: nothing to claim. Blur the claim and hand
                // them to the ballot (the auto-redirect fires the moment step 1 is marked done).
                <>
                  <p className="font-body text-[14px] font-extrabold text-ink">
                    This wallet already has gas to boost. No credit needed, so we are taking you
                    straight to the ballot.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <PopButton disabled className="pointer-events-none w-full blur-[1px] sm:w-auto">
                      Claim credit and boost
                    </PopButton>
                    <a
                      href={VOTE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("primary", "md", "w-full sm:w-auto")}
                    >
                      Boost Zerun on 0G
                    </a>
                  </div>
                </>
              ) : !faucetOpen ? (
                <>
                  <p className="font-body text-[14px] text-ink-2">
                    The free credit is {status?.enabled ? "used up" : "paused"} right now, but you can
                    still boost with your own. It costs only a tiny fee.
                  </p>
                  <div className="mt-3">
                    <a
                      href={VOTE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={popButtonClass("primary", "md", "w-full sm:w-auto")}
                    >
                      Boost Zerun on 0G
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="font-body text-[14px] text-ink-2">
                    Wallet connected. Boosting has a tiny fee, so we drop your voting credit in to
                    cover it and then take you straight to the boost. It is on us.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <PopButton onClick={claim} disabled={claiming} className="w-full sm:w-auto">
                      {claiming ? "Sending…" : "Claim credit and boost"}
                    </PopButton>
                    {claiming && <Spinner />}
                  </div>
                  {error && (
                    <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>
                  )}
                </>
              )
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
 * True on phone-width viewports. Starts false (desktop) and corrects on mount, so PC keeps its
 * full layout and only phones get the OKX-first install flow.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

/**
 * The returning-voter note. 0G binds each account to ONE wallet for the whole Zero Cup, but it does
 * not show you which wallet that is, so a semi-final voter who used a wallet last round has to
 * find it themselves. This says, honestly, what to do: same account, same wallet, and the practical
 * tell (it is the wallet already holding a little 0G). A different wallet starts a separate vote
 * that does not add to the earlier one.
 */
function ReturningVoterNote() {
  return (
    <StickerCard className="border-amber/60 bg-amber/10 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-chunk border-line border-ink bg-amber shadow-pop-press" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 7L4 12l5 5" stroke="#171449" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 12h11a5 5 0 0 1 5 5v2" stroke="#171449" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg text-ink">Voted in an earlier round?</h2>
            <Chip tone="won">boost from the same wallet</Chip>
          </div>
          <p className="mt-1 font-body text-[13px] leading-relaxed text-ink-2">
            0G ties your vote to one wallet for the whole Zero Cup, and it does not show you which
            one. So sign in with the <strong className="text-ink">same Google or X</strong> you used
            before, and boost from the <strong className="text-ink">same wallet</strong>. It is the
            wallet app you connected here last time, and the one already holding a little 0G is
            almost always it. A different wallet starts a fresh vote that will not add to your earlier one.
          </p>
        </div>
      </div>
    </StickerCard>
  );
}

/**
 * The phone install flow. OKX is recommended because it is the smoothest wallet on mobile, and
 * tapping it reveals per-OS store links, since OKX's generic download page will not load on a
 * phone. Other wallets stay as a quiet fallback for people who already have a preference.
 */
function MobileWalletInstall({
  showOkxStores,
  onGetOkx,
  onConnect,
  connectReady,
}: {
  showOkxStores: boolean;
  onGetOkx: () => void;
  onConnect: () => void;
  connectReady: boolean;
}) {
  return (
    <>
      <p className="font-body text-[14px] text-ink-2">
        To double your vote you need a wallet, a free app that holds it. On a phone, OKX is the
        smoothest, and it only takes a minute.
      </p>

      <div className="mt-3 rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-lg text-ink">OKX Wallet</span>
          <Chip tone="won">best on phones</Chip>
        </div>
        {!showOkxStores ? (
          <PopButton onClick={onGetOkx} className="mt-3 w-full">
            Get OKX Wallet
          </PopButton>
        ) : (
          <div className="mt-3">
            <p className="font-body text-[12px] font-extrabold text-ink-2">Pick your phone:</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <a
                href={OKX_IOS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={popButtonClass("primary", "md", "w-full")}
              >
                iPhone
              </a>
              <a
                href={OKX_ANDROID_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={popButtonClass("primary", "md", "w-full")}
              >
                Android
              </a>
            </div>
            <p className="mt-3 font-body text-[12px] leading-relaxed text-ink-3">
              After it installs, open the OKX app, find its browser, and go to zerun.site there.
              Then Connect wallet works in one tap.
            </p>
          </div>
        )}
      </div>

      <p className="mt-4 font-body text-[13px] font-extrabold text-ink">Already have a wallet? Connect it:</p>
      <div className="mt-2">
        <PopButton onClick={onConnect} disabled={!connectReady} className="w-full">
          Connect wallet
        </PopButton>
      </div>

      <p className="mt-3 text-center font-body text-[12px] text-ink-3">
        Prefer another?{" "}
        <a href={METAMASK_URL} target="_blank" rel="noopener noreferrer" className="font-extrabold text-ink underline">
          MetaMask
        </a>{" "}
        or{" "}
        <a href={RABBY_URL} target="_blank" rel="noopener noreferrer" className="font-extrabold text-ink underline">
          Rabby
        </a>
      </p>
    </>
  );
}

/**
 * The hand-off after credit is claimed: hold for a beat, then the tab navigates to 0G's boost
 * page on its own. The "Go now" link is a manual fallback if the auto-redirect is slow.
 */
function Redirecting() {
  return (
    <div className="mt-8">
      <StickerCard className="p-6 text-center ring-4 ring-violet/30">
        <div className="mx-auto w-fit motion-safe:animate-pop-in">
          <Agent variant="violet" mood="happy" size={84} name="Zerun" />
        </div>
        <div className="mt-3 flex justify-center">
          <Chip tone="live" pulse>
            credit sent
          </Chip>
        </div>
        <h2 className="mt-3 font-display text-2xl text-ink">Taking you to boost Zerun</h2>
        <p className="mx-auto mt-2 max-w-md font-body text-[14px] font-bold text-ink-2">
          Your voting credit is on the way. Hang on a second, then pick{" "}
          <strong className="text-ink">Boost</strong> on Zerun to double your vote.
        </p>
        <p className="mt-4 inline-flex items-center justify-center gap-2 font-body text-[13px] text-ink-3">
          <Spinner /> redirecting
        </p>
        <div className="mt-4">
          <a href={VOTE_URL} className={popButtonClass("primary", "md", "w-full sm:w-auto")}>
            Go now
          </a>
        </div>
      </StickerCard>
    </div>
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
          <Chip tone="won">already boosted</Chip>
        </div>
        <h2 className="mt-3 font-display text-2xl text-ink">This wallet has boosted. Thank you.</h2>
        <p className="mx-auto mt-2 max-w-md font-body text-[14px] font-bold text-ink-2">
          A wallet can boost once, so there is nothing more to do here with this one. The score moves
          from here on with new people, not new clicks.
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
          {done ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 12.5L10 17.5L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            n
          )}
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
