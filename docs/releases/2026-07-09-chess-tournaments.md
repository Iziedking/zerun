# Chess tournaments, mainnet compute, and a docs home

*2026-07-09*

Chess arrives as the fifth contest kind, and it arrives as a tournament rather than a
one-off game. The compute layer learned to run on 0G mainnet with the testnet wallet
behind it as a safety net. And two long-standing bugs that made a working system look
broken were traced and fixed.

## Chess, as an eight-seat bracket

An agent that plays chess by asking a language model for a move plays terrible chess. It
hallucinates illegal moves, hangs pieces, and never sees a tactic. So Zerun does not ask
it to.

A negamax alpha-beta search with piece-square tables generates the three strongest
candidate moves in the position. The agent's 0G Compute call chooses among those three
and says why. The engine guarantees legality and basic soundness; the 0G call supplies
judgment, and the feed shows its reasoning next to the request id that proves it ran on
0G. When a provider fails, the engine's own best move is played, so an outage costs
quality rather than the game.

**Compute buys depth.** The search runs 1, 2, 2, 3, 3, and 4 ply from tier 0 to tier 5,
so a higher tier both sees further and picks with a better model. The two levers
compound, exactly as they do everywhere else in Zerun.

**Tournaments, not duels.** Eight seats, single elimination, seeded by Compute tier so
the strongest agents meet last. The higher-tier agent plays White. Matches are capped at
300 seconds and 300 plies; when the clock runs out the winner is decided on captured
material, then tier, then the lower agent id. Checkmate ends it immediately.

The bracket streams live: seats, rounds, the match currently playing, the running board,
and the placements podium when it is done.

**Placement decides the payout.** Finishing higher pays better, so semifinalists share
third and quarterfinal losers share fifth. A house agent can win the bracket on the
board, and the pot still goes to the best real player.

## A lobby instead of a join window

Every other contest kind runs a join window: entries open, the window closes, the field
runs. For a bracket that is dead time. If eight real players are already sitting in the
room, why are they waiting?

So a chess tournament **opens as a lobby**. You watch the seats fill, and the moment all
eight are taken the first round begins. If ten minutes pass with seats still empty, house
agents take them and it starts anyway. A full room starts instantly; a quiet one still
runs.

One honest caveat: an early-filled tournament plays immediately, but its on-chain
settlement still waits for the contest's `endTime`. That gate is immutable on chain. The
chess is live; the payout arrives when the window would have closed.

## 0G mainnet compute, with a net

Inference is now decoupled from settlement. The compute layer can run **0G mainnet as its
primary network**, with the testnet compute wallet as an automatic per-call fallback,
while the contracts stay on Galileo. Each network keeps its own broker, ledger, and
provider handles.

A circuit breaker sits between them. Without it, a sustained mainnet outage would make
every single call pay the full mainnet timeout before falling back, which defeats the
point of having a fallback. After a run of consecutive mainnet failures the leg is
skipped for a cooldown, then probed again.

It turns on with configuration rather than code: set `COMPUTE_MAINNET_RPC_URL` and a
funded wallet key, and mainnet leads.

## Fixed

**Every chess move showed as an error.** The backend writes a `move` verdict for a chess
play, which is neither right nor wrong; the frontend's verdict map did not know the word
and fell through to its error case. So every successful, TEE-verified 0G move painted
itself red. The move is now a first-class verdict.

**Concurrent agents fought over one wallet nonce.** Three agents run in parallel, and each
inference call re-checked the 0G Compute ledger. With no single-flight guard, all three
could see a low balance and all three would send a deposit from the same key, building
three transactions on the same nonce. Two reverted, and the call died before it ever sent
an inference request, which is why those agents showed a bare `error` with zero latency.

Every wallet-writing broker call is now serialized behind a mutex, the ledger check is
single-flight and cached, and a failed top-up falls through to the balance the ledger
already holds rather than killing a contest it could have paid for.

The reason it took so long to find is the second half of the fix: a fully failed 0G call
used to be **completely silent**. The last candidate never logged, and the runners threw
the error away. Now every failed pass says why, at every level, and a failed call is no
longer mislabelled `offline-dev` when the offline stub never ran.

**Agent skins could hang into a 503.** A skin uploaded to 0G Storage had its local copy
discarded, so serving it depended on a live storage download that had no timeout. On a
cold cache, a slow indexer hung the request until the gateway killed it. Downloads are
now bounded, the local copy is kept alongside the 0G anchor, and legacy skins heal
themselves on their first successful read.

**A winner's prize could read `0.00`.** An entry-fee challenge keeps its pot in the fee
pool, not the staked prize pool, and the winner card was reading the wrong one.

## Docs

There is now a **Docs** link next to GitHub in the footer, and real documentation behind
it: [how to play](../how-to-play.md), [the product in full](../product.md), and
[where this is going](../roadmap.md).
