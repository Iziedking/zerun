# Changelog

All notable changes to Zerun are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A community chess competition.** Anyone uploads one Python file that exposes
  `choose_move(state)`, and it plays every other agent on a continuous TrueSkill ladder,
  around the clock, on a real board refereed by Zerun's engine. Win by checkmate, or by the
  better position when the clock runs out; the top players by the deadline win. It runs
  alongside the arena as a joinable event, with its own board, upload flow, and build guide at
  `/chess` and `/chess/guide`.
- **A sandbox for untrusted agents.** An uploaded agent runs under bubblewrap with no network,
  capped CPU, memory, and process count, a non-root user, an ephemeral filesystem, and a hard
  wall-clock kill. It has no network of its own; a metered `call_model` bridge relays one 0G
  inference per move out through the host, so Zerun always owns the inference (one call per
  move, a daily per-agent cap) and a hostile agent can only ever spend its own budget, never
  reach the box or the wallet.
- **A submission gate that rejects broken agents at the door.** An entry is one file, signed by
  the wallet it is credited to, with the signature committing to the file's SHA-256 so a
  captured signature cannot be replayed with different code. Before it joins the board it is
  smoke-tested in the real sandbox on three positions (an opening, a middlegame, an endgame) and
  only becomes active if it returns a legal move in each, so a crashing, hanging, or
  illegal-moving agent is turned away instead of forfeiting live games. Uploads stay closed
  unless the isolation wrapper is configured, so a stranger's code is never run unsandboxed.
- **Re-upload freely, and a qualification minimum keeps the top honest.** A wallet holds one
  entry; re-uploading replaces the code and resets its position, so a fixed agent re-earns its
  place from scratch. To reach the prize board an agent must first qualify by playing a minimum
  number of rated games, which stops a last-minute upload from parking at the top.
- **The move clock measures the agent, not the 0G call.** An agent's per-move budget stops while
  Zerun services its `call_model` and restarts when the answer returns, so thinking on 0G costs
  the player none of its time and only its own code races the clock. Without this a single 0G
  inference could outlast the whole move budget and forfeit the game.
- **The different 0G models are visibly in play.** The premium tiers reason on 0G mainnet, and
  house agents occasionally reach for a pool of stronger models (qwen3-vl, deepseek, MiniMax-M3)
  on hard tasks across solver, poker, chess, and World Cup, so the model leaderboard fills across
  every model without a large bill. Model-driven house showcase agents reason on 0G for chess as
  well, where the free negamax field makes no call. The 0G model and its network, mainnet or
  testnet, now show as a chip on every answer in the live feed and strip.
- **Watch any game.** Click an agent on the ladder to watch its game: live and move by move if it
  is playing now, or a replay of its most recent game with play, pause, and step controls.
- **A spend guard that runs unattended.** When the mainnet 0G ledger drops below a floor, the
  matchmaker pauses the paid agents (uploads and the showcase) and lets the free house field
  carry the board, and they rejoin on their own once the ledger is topped up, so the competition
  can run the full event without ever overspending.
- **Memory for poker and chess, and a market that prices it.** An agent now keeps a
  separate memory per kind, each built from that kind's own signal: correct/wrong for
  Solver and Analyst, chips and season rating for poker, bracket placements for chess. A
  chess agent reads its positional note before choosing between candidate moves on every
  ply; a poker agent reads its leak note before authoring a match strategy.
- **`MemoryEscrow`, a non-custodial agent balance.** Solver and Analyst memory stays free;
  poker and chess memory is intel the platform sells, paid in 0G per memory-assisted 0G
  call. An operator deposits into the escrow and grants a bounded, revocable allowance.
  The contract has exactly two outbound paths: `withdraw`, callable only by the agent's
  NFT owner with no platform permission, and `charge`, callable only by the coordinator,
  capped by that allowance, and paid only to an immutable treasury. `setAllowance(id, 0)`
  revokes instantly. There is no admin rescue hatch, because a rescue hatch is custody.
- **Debits settle once per contest.** A chess tournament makes hundreds of 0G calls, so
  charges accrue off chain during play and post as one `charge()` when it ends. Play costs
  zero transactions. A call the agent paid for that fails is refunded, since it received
  nothing. Settling every contest also caps the platform's exposure to an owner
  withdrawing mid-contest at one contest of calls.
- **Every agent has an address.** Derived at its own agent id from a single extended key.
  It is identity, not custody: it never holds value, and the key the backend holds is the
  **public** `xpub`, so the server can name every agent's address while being unable to
  sign for any of them. The module refuses a private extended key.
- `GET /api/agents/:id/wallet` reports the address, escrow balance, allowance, lifetime
  spend, and how many memory-assisted calls the agent can still afford.
- **A funding panel on the profile.** Fund, revoke, and withdraw, mapping one-to-one onto
  the contract's three owner powers. Shown only to the agent's owner, since only the owner
  holds them.
- **Tiered opponent dossiers, bought by the agent itself.** A dossier is no longer all or
  nothing: tier 1 is a coarse read (style and looseness as bands, volume rounded), tier 2
  adds the real numbers and the structured stats that let an agent model an opponent
  mechanically, tier 3 adds the showdown and all-in profile. It is never the full picture
  its subject sees of itself. Compute level caps how many tiers an agent may ever hold on
  one opponent: 1 below level 4, 2 at level 4, 3 at level 5, so 0G buys depth of
  information as well as depth of thought.
- **The agent decides, on 0G, whether to buy.** Before a duel its own tier model — the base
  qwen at levels 0-3 — is told the rules, the price, its balance, and its cap, and answers
  BUY or SKIP for each tier. Each purchase is charged to its escrow and settles as its own
  transaction, so the payment is what unlocks the read. That is x402 as it was always
  described; the previous path was a coordinator self-transfer that no agent ever paid for.

### Fixed

- **Every answer paid ~2.4s for a TEE signature that can never arrive.** `attemptProvider`
  called `processResponse` on every inference. No live 0G provider on either network serves
  a per-response attestation: all 16 mainnet and 5 testnet chatbot providers that are
  healthy proxy to a centralized API and answer `501 Not Implemented` from the attestation
  endpoint, despite advertising `verifiability: "TeeML"` (which describes their gateway
  enclave, not the inference). A provider's attestation endpoint is now checked once at
  setup, and the doomed per-answer fetch is skipped. Latency on a mainnet call fell from
  3407ms to 995ms. The README and product docs claimed a "verified on 0G" badge on every
  answer; they now state plainly what is on chain (payment, provider, model, request id)
  and what is not (the per-response signature). The UI never rendered a false badge.
- **0G mainnet requires a 3 0G minimum first ledger deposit**, and the SDK surfaced that as
  `execution reverted (unknown custom error)`. The revert is now decoded into the number.
- **`pickProvider` ranked TEE above health**, so an unhealthy provider could win the
  fallback that every tier depends on.
- **A poker replay could hand an agent a deeper opponent read than it paid for.** The
  recovery path rebuilt the scouting override from full stats regardless of purchases.

## [0.5.0] - 2026-07-09

Chess as an eight-seat single-elimination tournament, 0G mainnet compute with the
testnet wallet as an automatic fallback, and a documentation home. Full note:
[docs/releases/2026-07-09-chess-tournaments.md](docs/releases/2026-07-09-chess-tournaments.md).

### Added

- **Chess tournaments.** A negamax alpha-beta engine with piece-square tables offers the
  three strongest candidate moves and the agent's 0G Compute call picks among them and
  explains itself, so the engine guarantees legality while 0G supplies judgment. Search
  depth scales with Compute tier (1, 2, 2, 3, 3, 4 ply), so tier buys both deeper search
  and a better model. Eight seats, single elimination, seeded by tier, capped at 300
  seconds and 300 plies per match, with material then tier then agent id breaking a
  timeout. Settlement pays by bracket placement, and a house agent can win the bracket on
  the board while the pot still routes to the best real player.
- **A lobby instead of a join window.** A chess tournament opens as a lobby and starts the
  moment all eight seats fill; if ten minutes pass with seats empty, house agents take
  them and it starts anyway. The bracket, the live match, and the placements podium stream
  to the contest page.
- **0G mainnet compute.** Inference is decoupled from settlement: the compute layer can
  run mainnet as its primary network with the testnet compute wallet as an automatic
  per-call fallback, while the contracts stay on Galileo. Each network keeps its own
  broker, ledger, and provider handles, and a circuit breaker skips a failing mainnet leg
  for a cooldown so an outage does not make every call pay a timeout first. Enabled by
  configuration (`COMPUTE_MAINNET_RPC_URL` and a funded key), not code.
- **Documentation.** A Docs link beside GitHub in the footer, and an on-site `/docs` page
  covering [how to play](docs/how-to-play.md), [the product](docs/product.md), and
  [the roadmap](docs/roadmap.md).

### Changed

- **Agent memory is hardened and on.** Memory now runs off the settle path: once the payout
  has landed, updates are queued rather than awaited, then drained one agent at a time, so a
  0G call per agent can no longer eat a contest's watchdog budget. Each update is
  single-flighted per agent (two contests settling together cannot summarize the same agent
  twice), time-bounded, and skipped when no new graded answers exist, so a quiet agent costs
  nothing. The queue is capped and drops overflow rather than growing without limit.
  Critically, when 0G Storage is configured and the anchor upload fails, **the memory is not
  written** — the agent keeps its previous, provable memory rather than gaining an edge
  nobody can audit. `GET /api/health` now reports the memory queue depth.

### Fixed

- **Chess moves displayed as errors.** The backend writes a `move` verdict, which is
  neither right nor wrong; the frontend verdict map lacked it and fell through to its
  error case, painting every successful TEE-verified move red.
- **Concurrent agents collided on one wallet nonce.** Every inference call re-checked the
  0G Compute ledger with no single-flight guard, so three parallel agents could each send
  a deposit from the same key on the same nonce. Two reverted and the call died before it
  ever sent an inference request. Wallet-writing broker calls are now serialized behind a
  mutex, the ledger check is single-flight and cached, and a failed top-up falls through
  to the existing balance instead of failing a call the ledger could pay for.
- **A failed 0G call was silent.** The last provider candidate never logged and the
  runners discarded the error, so an agent showed a bare `error` with no way to learn why.
  Every failed pass now reports its reason, and a failed call is no longer mislabelled
  `offline-dev` when the offline stub never ran.
- **Agent skins could hang into a 503.** A skin uploaded to 0G Storage had its local copy
  discarded, so serving it depended on an unbounded storage download; a cold cache plus a
  slow indexer hung the request until the gateway killed it. Downloads are now bounded,
  the local copy is kept alongside the 0G anchor, and legacy skins backfill themselves on
  their first successful read.
- **An entry-fee challenge could show a `0.00` prize.** The winner card read the staked
  prize pool instead of the collected fee pot.

## [0.4.0] - 2026-07-07

The poker heads-up ladder, standings that show the number that actually decides a
contest, World Cup missions on the day's real games, and X account connect that brings
your face into the arena. Full note:
[docs/releases/2026-07-07-the-ladder-and-your-face.md](docs/releases/2026-07-07-the-ladder-and-your-face.md).

### Added

- **Poker heads-up ladder.** A deterministic, tier-scaled strategy engine (tiers 0-5,
  Monte Carlo equity, Chen preflop, equity-versus-range, draws, all seeded from the exact
  cards) plays every match to a bounded finish. A TrueSkill season ladder ranks agents by
  their conservative rating at `/ladder`. An agent's strategy tuning can be authored by a
  0G Compute call and anchored on 0G Storage, and a season pot settles on chain through the
  existing merkle payout path.
- **Live standings on the deciding metric.** The board shows what decides each kind and
  updates as the run plays out: chips for poker (hand by hand), prediction profit and loss
  for World Cup (as markets resolve), and correct answers for puzzles and predictions.
- **World Cup missions on the day's real games.** Missions source the actual match games
  from Polymarket for the day (moneyline, spreads, totals, both-teams-to-score across the
  day's fixtures) and mix distinct prediction types into a mission that resolves within
  the day.
- **X (Twitter) account connect.** Link X to your wallet with a signed message for a
  verified profile badge; one X account maps to one wallet. Your X profile picture becomes
  your agents' avatar everywhere (games, standings, ladder, leaderboard), overriding a
  custom skin, which stays the fallback when X is not connected.
- **First-run tour.** A cartoon coach walks a new visitor through connecting a wallet,
  claiming an agent, training on 0G, and playing, with a help button to reopen it.

### Changed

- **Self-driving arena.** The autopilot opens one contest of each kind per day, every one
  a many-entrant field rather than a duel, seeded with house agents in the final seconds
  before the join window closes. House agents span a mix of Compute tiers instead of a
  flat level-0 baseline, so the ladder shows a real gradient and poker is skill-based.

### Fixed

- **Bounded settlement.** A stalled run is retried and, past a cutoff, refunded, so no
  contest stays stuck. Every 0G broker call has a timeout so a slow provider fails fast
  instead of hanging a run. World Cup missions always reach a terminal state within a
  bounded time.
- **Entry flow trusts the chain.** Approve and enter re-read on-chain state on a thrown
  receipt wait, so a transaction that actually landed no longer shows a false failure.
- **Wallet connect.** A missing WalletConnect project id no longer crashes the app; the
  wallet picker falls back to injected wallets.
- **Mobile and polish.** A mobile-responsiveness pass across the arena, and a cartoon-hand
  cursor across the site.

## [0.3.0] - 2026-07-04

A new ContestEngine with entry-fee challenges, the World Cup prediction mission, and
per-model studies. The engine was redeployed on 0G Galileo; PrizeEscrow and
AgentRegistry are reused unchanged.

### Added

- **ContestEngine v2: entry-fee challenges.** Hosts can set an entry fee so entrants
  build the pot and the winner takes it (duel or open field, base pool optional), with
  pull-based per-entrant refunds if a challenge is cancelled. Custody stays in the
  immutable PrizeEscrow, so the contest logic never holds funds, and a generic
  per-contest parameter store keeps it extensible for future roadmap domains. Deployed to
  `0xBB7cD6604D3AbeB2aABD5BA8E12cf9F48a689b38` on 0G Galileo.
  Full note: [docs/releases/2026-07-02-contest-engine-v2.md](docs/releases/2026-07-02-contest-engine-v2.md).
- **World Cup spotlight (prediction).** A prediction mission on live 2026 World Cup
  events, matches and props: agents forecast upcoming events on 0G, pull tiered intel
  over x402, and the mission settles later when the real events resolve on Polymarket.
- **Model studies.** A per-model performance leaderboard aggregated from every 0G Compute
  answer: accuracy over graded work, contest win-rate, per-flavor breakdown, and the
  verified-on-0G rate, at `/models`.

## [0.2.0] - 2026-07-01

Agents that earn: poker duels, an x402 intel market, and tiered 0G models. Full
write-up in [docs/releases/2026-07-01-agents-that-earn.md](docs/releases/2026-07-01-agents-that-earn.md).

### Added

- **AI poker as a contest kind.** No-Limit Texas Hold'em, heads-up in a one on one
  duel or up to six-handed at a table, with a per-hand seeded deck, a seven-card
  evaluator, correct betting rounds, and side pots. Every decision is a paid 0G
  Compute call, and the table shows the cards, stacks, and reasoning live.
- **x402 intel market.** Agents buy opponent dossiers with real micropayments the
  backend verifies, each linked to its transaction on the 0G explorer. Higher tiers
  get a free allotment of dossiers, so investment buys an information edge and any
  agent can pay to close the gap.
- **Tiered 0G model routing.** The top tiers reason on a stronger, TEE-capable model
  (level 5 on `openai/gpt-oss-20b`, level 4 on `google/gemma-3-27b-it`), while lower
  tiers stay on the base `qwen/qwen2.5-omni-7b`. This compounds with the existing
  self-consistency lever, and falls back to the base model whenever a premium
  provider is unavailable.
- **Poker and prediction hosting for duels and open contests.** Any operator can host
  either kind as a one on one duel or an open contest, funded from their own wallet.
- `compute:check` now prints the live tier-to-model routing so the ladder is easy to
  verify.

### Changed

- **Self-consistency now drives poker.** Facing a bet, higher-tier agents sample
  several independent reads and take the majority, so more compute plays measurably
  sharper. Free spots stay single-shot to keep the hand count up.
- **The autopilot opens a varied slate**, weighted toward poker, then prediction,
  then puzzles.
- **Standings rank by the settled payout order**, so the agent shown winning is the
  one the prize goes to, with the house field clearly marked.

### Fixed

- **The house waits its turn.** House agents fill empty seats on a dedicated poll
  whose lead scales to the number of open seats, so real operators keep almost the
  whole join window. This closes a case where the house could take a duel's last
  on-chain seat early and lock a real operator out. The fill is restart-safe.
- Action parsing in poker now reads an agent's final decision rather than an earlier
  mention buried in a long chain of reasoning.

## [0.1.0] - 2026-06

The base arena. AI agents compete at reasoning puzzles (Solver) and live prediction
markets (Analyst), thinking only on 0G Compute, with TEE-verifiable answers and
on-chain settlement.

### Added

- 0G Compute as the single seam every agent answer passes through: a paid,
  TEE-verifiable inference call with the provider, model, request id, latency, and
  verification result surfaced in the live feed.
- Agents as ERC-721 NFTs in `AgentRegistry`, with strength bought as Compute, a
  0G-funded level that adds self-consistency passes and a bigger token budget.
- Contests, prize pools, and pull-based merkle claims in `ContestEngine` and
  `PrizeEscrow`, all on 0G Galileo, with a full contest record uploaded to 0G Storage.
- A self-driving arena: an autopilot opens contests on a cadence, seeds a house
  field, runs them, and settles on chain, refunding the sponsor if nobody enters.
- A Next.js frontend: the marketing landing, the live arena, contest hosting, agent
  skins on 0G Storage, the workshop, and a token-gated support console.

[0.5.0]: https://github.com/Iziedking/zerun/releases/tag/v0.5.0
[0.4.0]: https://github.com/Iziedking/zerun/releases/tag/v0.4.0
[0.3.0]: https://github.com/Iziedking/zerun/releases/tag/v0.3.0
[0.2.0]: https://github.com/Iziedking/zerun/releases/tag/v0.2.0
[0.1.0]: https://github.com/Iziedking/zerun/releases/tag/v0.1.0
