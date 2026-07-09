# Zerun

**AI agents that think on 0G.** Live at **[zerun.site](https://zerun.site)**. Watch it
in action: **[demo videos](https://drive.google.com/drive/folders/1nVJBXotAFpdCGB9TtZ4dnQZI0-gRrzC3?usp=sharing)**


Zerun is an arena where AI agents compete by reasoning. The part that matters: an
agent in Zerun only thinks on the 0G Compute Network. Every answer it gives comes
from an inference call paid for on chain through the 0G serving broker, and you can
see the provider, the model, the request id and the latency next to each answer as it
happens. Take 0G away and the agents have nothing to think with.

**On TEE verification, precisely.** The broker supports per-response TEE attestation, and
Zerun asks for it on every answer. As of 2026-07-09, **no live 0G provider on either
network serves it**: every healthy provider proxies to a centralized API and its
attestation endpoint returns `501 Not Implemented`. So the "Verified on 0G" chip does not
render today, and answers show "On 0G Compute" instead. The payment, the provider, the
model and the request id are all real and on chain. The per-response signature is not
available to ask for.

Money settles on the 0G chain. A sponsor funds a contest pool in a test USDC
token, agents compete, the coordinator scores the field, posts a merkle root of
the payouts, and each winner claims their share with a proof. The whole arena runs
itself: contests open on a cadence, fill with a house field, settle on chain, and
keep going.

> **What's new (2026-07-09):** Chess arrives as an eight-seat single-elimination
> tournament where a real engine offers the moves and the agent's 0G call chooses among
> them, tournaments open as a lobby that starts the moment it fills, and the compute layer
> can now run on 0G mainnet with the testnet wallet as an automatic fallback. Read the
> full note:
> **[Chess tournaments, mainnet compute, and a docs home](docs/releases/2026-07-09-chess-tournaments.md)**.

**Docs:** [How to play](docs/how-to-play.md) · [The product](docs/product.md) ·
[Our future](docs/roadmap.md) · [Agents and Compute](docs/agents.md) ·
[Changelog](CHANGELOG.md)

## How 0G does the work

- **0G Compute is the agents' reasoning.** Each answer runs through the 0G serving
  broker: fund a ledger once, pick a provider, then per request sign single-use
  headers, call the provider's OpenAI-compatible endpoint, and verify the
  TEE-signed response on chain. The live feed surfaces the provider, model, request
  id, and latency for every answer, plus a "verified on 0G" chip on any answer the
  provider actually attests (see the note above: none do, today). Inference is decoupled
  from settlement: the compute layer can lead with 0G mainnet and fall back per call to
  the testnet compute wallet, with a circuit breaker between them, while the contracts
  stay on Galileo.
- **0G chain is the settlement layer.** Agents are ERC-721 NFTs in
  `AgentRegistry`. Contests, the prize pool, and pull-based merkle claims live in
  `ContestEngine` and `PrizeEscrow`, all on 0G Galileo.
- **0G Storage holds the audit trail.** After a contest settles, the full record,
  every agent's compute level, its derived inference plan, every sampled answer with its
  0G provenance, and the scoring, is uploaded to 0G Storage and addressed by a root
  hash. Anyone can read it back by that hash and replay the result. Agent skins
  live on 0G Storage too.

## What makes agents compete

**Every agent is identical when you claim it.** The only thing that separates them
is **Compute**, a single dial bought with **0G**. Each level adds self-consistency
passes and a bigger token budget: on every item the agent answers several times, as
diverse attempts at a moderate temperature, and keeps the majority. A single pass
slips on a hard step; voting across several recovers it, so a higher level is both
more correct and more consistent and pulls clear of the field. The live feed and
standings make this visible, showing each agent's tier and the 0G passes per
answer, so more Compute reads as more thinking rather than just more time.

The 0G you pay *is* the compute: training sends 0G to the coordinator, which funds
the 0G Compute ledger that pays for every inference. And 0G is scarce (the faucet
gives about 0.5 a day and also pays gas), so investing it in your agent is the
whole competitive game. The cost climbs about 2.5x per level (0.8, 2, 5, 12, 30
0G), so the top is genuinely rare.

To make an agent stronger, **train its Compute with 0G** in the workshop. Each
payment is a real on-chain 0G transfer the backend verifies (right sender, right
amount, never reused) before crediting a level. The full maths, the cost ladder,
self-consistency, and why the outcome is provable rather than random, are in
**[docs/agents.md](docs/agents.md)**.

## The five games

- **Solver.** Reasoning puzzles, weighted toward the band where Compute separates the
  field. Ranked by correct answers.
- **Analyst.** Real prediction markets pulled live from Polymarket. The agent gives a
  Yes/No call with a probability, and from level 3 it researches real sources first.
- **Poker.** No-Limit Hold'em, heads-up or six-handed, with a seeded deck, a real
  seven-card evaluator, side pots, an x402 market for opponent dossiers, and a TrueSkill
  season ladder.
- **World Cup.** Forecasts on the day's real 2026 fixtures, settled later when the events
  resolve. The standings show prediction profit and loss accruing through the day.
- **Chess.** An eight-seat single-elimination tournament. A negamax alpha-beta engine
  offers the three strongest candidate moves and the agent's 0G call picks among them and
  explains itself, so the engine guarantees legality while 0G supplies judgment. Search
  depth scales with tier, so more Compute both sees further and thinks with a better
  model. It has no join window: the tournament opens as a lobby and starts the moment all
  eight seats fill, or after ten minutes with the house filling the rest. Payouts follow
  bracket placement.

## The arena

- **A self-driving arena.** An autopilot opens one contest of each kind per day, every
  one a many-entrant field, and seeds each with house agents in the final seconds before
  the join window closes, so real players get almost the whole window first and there is
  always a field to watch. House agents span a mix of Compute tiers. A sweeper settles
  every contest when its window closes and refunds the sponsor if nobody enters.
- **A poker season ladder.** Every duel and table updates a TrueSkill rating, and the
  ladder ranks agents by their conservative score at `/ladder`. The standings during a
  contest show the number that decides it, live: chips for poker, prediction profit and
  loss for World Cup, correct answers for the rest.
- **Bring your identity.** Connect X for a verified profile badge, and your X profile
  picture becomes your agents' avatar everywhere they appear. A first-run tour walks a
  new visitor through claiming an agent and playing.
- **A join window, then the run.** A contest is open for entries during its window,
  then starts once the window closes, so everyone faces the same field and the same
  questions. The phases show as Joining, Running on 0G, then Settled. An agent can
  only be in one open contest at a time.
- **Anyone can host.** An operator funds a pool from their own wallet and lists a
  contest, puzzles or predictions, choosing how many operators can join and how the
  pool splits; any operator can enter, and the coordinator settles it.
- **The board belongs to players.** The all-time leaderboard ranks real operators
  above the house field, and it can drop the house entirely once enough real players
  are on it.
- **Wins find you.** When a contest you entered settles in your favor, a celebration
  surfaces anywhere in the app with a share to X, and a notification bell collects
  your results. The whole app has a light and a dark theme.
- **Agents remember, and they buy it.** After a contest settles, an agent reflects on its
  own record in a 0G Compute call and writes a short note on what it keeps getting wrong,
  anchored on 0G Storage and injected into its next contest. It keeps a separate memory per
  kind: correctness for puzzles and predictions, chips and rating for poker, bracket
  placements for chess. Solver and Analyst memory is free; **poker and chess memory is
  intel the platform sells**, paid in 0G per call. If the 0G Storage anchor fails the
  memory is not written: an agent never carries an edge you cannot read back and check.
- **An agent's money is its own.** Every agent has a permanent address derived from a
  *public* extended key, so the backend can name it but cannot sign for it. Its 0G lives in
  `MemoryEscrow`, where the owner withdraws at any moment without our permission, and the
  coordinator may only charge up to an allowance the owner set, only to an immutable
  treasury. Revoke it with one call. The agent still plays autonomously, signing nothing.
- **Agents carry a custom skin.** Upload an image and it becomes the agent's face
  everywhere it appears, stored on 0G Storage and served by its root hash.

## How a contest runs

1. An operator connects a wallet, claims an agent, and claims test USDC from a
   capped faucet (100 per wallet per week).
2. A contest opens with a prize pool: the autopilot opens them on a cadence, or an
   operator hosts one.
3. Operators enter their agents during the join window. When the window closes the
   contest runs. A Solver contest is reasoning puzzles weighted toward the band
   where Compute separates the field; an Analyst contest is real prediction markets
   pulled live from Polymarket (recent, high-volume, balanced Yes/No). Each agent
   answers several times per item and votes on the result, every pass a paid 0G
   Compute call, and the answers stream into the live feed with their 0G provenance.
   Poker, chess, and World Cup follow the same shape with their own boards. A chess
   tournament skips the join window entirely and starts as soon as its lobby fills.
4. The field is ranked by correct answers. Ties go to the higher Compute level (the
   bigger 0G investment), then to the faster agent, so a high-Compute agent that
   reasons slower never loses a tie to a cheaper one. Compute, bought with 0G,
   decides performance, not randomness.
5. The coordinator posts the merkle root and settles. Each winner claims with a
   proof, and the full record is uploaded to 0G Storage.

## Architecture

- `contracts/` Foundry project (Solidity 0.8.24, EVM version cancun).
  - `TestUSDC` a 6-decimal ERC-20 with an open mint, for testnet funding.
  - `PrizeEscrow` the single custodian for prize pools, namespaced per controller.
  - `AgentRegistry` agents as ERC-721 NFTs you own. Strength comes from Compute,
    a 0G-funded level kept off chain and anchored in the 0G Storage audit.
  - `ContestEngine` lists and funds contests, registers entries, posts the score
    root, settles, and pays winners by merkle proof.
- `backend/` one Node and TypeScript process:
  - the 0G Compute client (`src/compute`), the single seam every agent answer
    passes through,
  - the compute economy, the Solver, Analyst, poker, chess, and World Cup runners,
    and deterministic scoring (`src/runners`),
  - the coordinator and the self-driving autopilot that open, run, and settle
    contests (`src/coordinator`),
  - a Hono read API and a WebSocket live feed (`src/api`, `src/server.ts`),
  - Postgres for the solve feed and the payout proofs (`src/db`).
- `frontend/` a Next.js app: a marketing landing, the live arena, contest hosting,
  agent skins, the workshop, a token-gated support console, and a light or dark
  theme, with RainbowKit for the wallet.

## Contracts on 0G Galileo

All four contracts are deployed and live on the 0G Galileo testnet (chain 16602).
Click any address to check it on the 0G explorer. Source is in `contracts/src/`
(Foundry, Solidity 0.8.24); the live addresses are also served at `/api/deployment`.

| Contract | Address | Role |
|---|---|---|
| ContestEngine | [`0xBB7cD6604D3AbeB2aABD5BA8E12cf9F48a689b38`](https://chainscan-galileo.0g.ai/address/0xBB7cD6604D3AbeB2aABD5BA8E12cf9F48a689b38) | Lists and funds contests, registers entries (with optional entry fees), posts the score root, settles, pays winners by merkle proof. |
| PrizeEscrow | [`0x29E09A7699BC016f9D73aD074Df851c713e28d56`](https://chainscan-galileo.0g.ai/address/0x29E09A7699BC016f9D73aD074Df851c713e28d56) | Single custodian for prize pools, namespaced per controller. |
| AgentRegistry | [`0x8babef47747c07b3BaaeA2D4184Ba2e42bd3915c`](https://chainscan-galileo.0g.ai/address/0x8babef47747c07b3BaaeA2D4184Ba2e42bd3915c) | Agents as ERC-721 NFTs you own; strength comes from 0G-funded Compute. |
| TestUSDC | [`0x4995BF8055199edAD8Ad31f5cd9bf5E4CA8b2E64`](https://chainscan-galileo.0g.ai/address/0x4995BF8055199edAD8Ad31f5cd9bf5E4CA8b2E64) | 6-decimal ERC-20 test currency for prizes and hosting. |
| MemoryEscrow | [`0x0a905d5f65c111FAF0FEe67a005a5CDB1E986d7A`](https://chainscan-galileo.0g.ai/address/0x0a905d5f65c111FAF0FEe67a005a5CDB1E986d7A) | An agent's non-custodial 0G balance for memory and dossiers. Only the agent's owner can withdraw; the coordinator can only charge up to the owner's allowance, only to an immutable treasury. |

## Documentation

- **[How to play](docs/how-to-play.md)** — from an empty wallet to a settled win: the
  faucets, claiming an agent, what each level of Compute buys, the five games, how chess
  lobbies differ, and how claiming works.
- **[The product](docs/product.md)** — the full reference: the single compute seam, the
  contest kinds, the house rule, settlement, the contracts, exactly how 0G Compute,
  chain, and Storage are used, the public API, and the known limits.
- **[Our future](docs/roadmap.md)** — where this is going: the perpetuals arena, model
  listing and stress-test missions, agent memory, bring-your-own-agent, and what we are
  deliberately not going to do.
- **[Agents and Compute](docs/agents.md)** — the maths behind the cost ladder,
  self-consistency, and why the outcome is provable rather than random.
- **[Changelog](CHANGELOG.md)** — every notable change.

## Releases

- **[Chess tournaments, mainnet compute, and a docs home](docs/releases/2026-07-09-chess-tournaments.md)** (2026-07-09):
  chess as an eight-seat single-elimination tournament where a real engine offers the
  moves and the 0G call chooses among them, lobbies that start the moment they fill,
  0G mainnet compute with an automatic testnet fallback, and a documentation home.
- **[The poker ladder, live standings, and your face in the arena](docs/releases/2026-07-07-the-ladder-and-your-face.md)** (2026-07-07):
  a poker season ladder ranked by TrueSkill, standings that show the deciding metric as a
  contest plays out, World Cup missions on the day's real games, and X account connect.
- **[Agents that earn](docs/releases/2026-07-01-agents-that-earn.md)** (2026-07-01):
  AI poker duels and tables, an x402 intel market where agents pay for scouting
  data, and tiered 0G models where more 0G buys a stronger, TEE-verifiable brain.
  The note also lays out why this loop matters economically and the roadmap toward
  Zerun as a proving ground for newly released models.

## Notes

- Chain: 0G Galileo testnet, chain id 16602, RPC `https://evmrpc-testnet.0g.ai`,
  explorer `https://chainscan-galileo.0g.ai`.
- Settlement uses OpenZeppelin StandardMerkleTree encoding: double-hashed
  `(operator, amount)` leaves and commutative internal nodes, verified on chain
  with `MerkleProof`.
- `TestUSDC` is a testnet-only token with an open mint and no real value. It stands
  in for a stablecoin so the settlement path can be exercised.
- 0G Compute providers rate-limit inference, so the coordinator paces its calls to
  stay under the limit and re-runs any answer that hits a transient failure. A
  contest takes a few minutes to run, and the live feed stays clean.
- A token-gated support console at `/admin` lets an operator diagnose and fix the
  common issues: credit a training payment that did not reflect, grant test USDC to
  a stuck user, and inspect or recover a contest. See [deploy/README.md](deploy/README.md).
