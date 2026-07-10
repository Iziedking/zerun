-- Zerun off-chain state. On-chain (0G) stays the source of truth for agents,
-- contests, and prize custody. Postgres holds what does not belong on chain:
-- the per-solve proof feed (the record that each answer came from 0G Compute)
-- and the merkle payout proofs winners need to claim.

create table if not exists agents_meta (
  agent_id     bigint primary key,
  owner        text not null,
  name         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists agents_meta_owner_idx on agents_meta (lower(owner));

-- Custom agent skin: the image the operator uploaded. Stored as base64 for fast
-- serving, plus the 0G Storage root so the skin also lives on decentralized
-- storage. Added separately so existing rows migrate cleanly.
alter table agents_meta add column if not exists skin_mime text;
alter table agents_meta add column if not exists skin_b64 text;
alter table agents_meta add column if not exists skin_root text;

-- Agent traits: the build that decides how an agent reasons on 0G. Rolled from
-- the agent id the first time it competes, then raised by training.
alter table agents_meta add column if not exists trait_precision int;
alter table agents_meta add column if not exists trait_focus int;
alter table agents_meta add column if not exists trait_speed int;
alter table agents_meta add column if not exists trait_resilience int;

-- Compute level: the single skill dial, bought with 0G. Every agent starts at 0
-- (identical at claim); training with 0G raises it for more passes and tokens.
alter table agents_meta add column if not exists compute_level int not null default 0;

-- House agents are the autopilot's filler so the arena is never empty. They are
-- always ranked below real operators and can be hidden once real players scale.
alter table agents_meta add column if not exists is_house boolean not null default false;

-- 0G training payments already credited, so a transaction can never be reused.
create table if not exists compute_trainings (
  tx_hash    text primary key,
  agent_id   bigint not null,
  operator   text not null,
  amount_wei text not null,
  level_after int not null,
  created_at timestamptz not null default now()
);

-- x402 dossier payments already spent, so a single on-chain payment tx can unlock
-- exactly one dossier read and can never be replayed for more.
create table if not exists dossier_payments (
  tx_hash        text primary key,
  for_agent      bigint,
  opponent_agent bigint,
  created_at     timestamptz not null default now()
);

-- tUSDC faucet claims, so an operator is capped to 100 tUSDC per 7 days.
create table if not exists usdc_claims (
  id         bigserial primary key,
  operator   text not null,
  amount_wei text not null,
  created_at timestamptz not null default now()
);
create index if not exists usdc_claims_op_idx on usdc_claims (lower(operator), created_at);

create table if not exists contests_meta (
  contest_id    bigint primary key,
  status        text not null default 'open',
  puzzle_count  int  not null,
  agent_count   int  not null default 0,
  metric        text not null default 'PUZZLE',
  prize_pool    text not null default '0',
  final_root    text,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);

-- 0G Storage root of the settled contest's solve-feed audit trail, recorded
-- after settlement. Added separately so existing rows migrate cleanly.
alter table contests_meta add column if not exists audit_root text;
alter table contests_meta add column if not exists audit_tx text;

-- Poker duel replay: the full hand-by-hand match log (seeds, cards, actions) on 0G
-- Storage, so a duel can be reconstructed and verified by its root hash.
alter table contests_meta add column if not exists poker_root text;
alter table contests_meta add column if not exists poker_tx text;

-- Per-agent poker record, accumulated as duels settle. Powers the opponent dossier
-- (how an agent tends to play), which another agent can scout before a duel.
create table if not exists poker_stats (
  agent_id      int primary key,
  hands         int not null default 0,
  folds         int not null default 0,
  checks        int not null default 0,
  calls         int not null default 0,
  raises        int not null default 0,
  allins        int not null default 0,
  showdowns     int not null default 0,
  showdowns_won int not null default 0,
  duels         int not null default 0,
  duels_won     int not null default 0,
  updated_at    timestamptz not null default now()
);
-- The agent's dossier snapshot on 0G Storage: owned, provable scouting data.
alter table agents_meta add column if not exists dossier_root text;

-- A verified X (Twitter) identity bound to an operator wallet. The unique(x_id) is the
-- anti-Sybil spine: one X account maps to exactly one wallet, so a wallet farm cannot
-- multiply a single X identity. Soft-gate for now (a verified badge); the same binding
-- later gates campaigns and powers a friends leaderboard.
create table if not exists social_identity (
  wallet      text primary key,      -- operator wallet, lowercased
  x_id        text not null,         -- X user id (stable across handle changes)
  x_handle    text not null,         -- @handle (may change)
  x_name      text,                  -- display name
  verified_at timestamptz not null default now(),
  unique (x_id)
);
-- The operator's X profile image, used as their agents' avatar everywhere once linked
-- (it overrides an uploaded skin; the skin stays the fallback when X is not connected).
alter table social_identity add column if not exists x_avatar text;

-- TrueSkill ratings per agent per poker season, updated after every duel/table. The
-- ladder ranks by the conservative rating (mu - 3*sigma), so a top spot needs both
-- skill and enough games to be confident. A season groups a run of matches (POKER_SEASON).
create table if not exists poker_ratings (
  season      text not null,
  agent_id    bigint not null,
  mu          double precision not null default 25.0,
  sigma       double precision not null default 8.3333333,
  games       int not null default 0,
  wins        int not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (season, agent_id)
);
create index if not exists poker_ratings_season_idx on poker_ratings (season, ((mu - 3 * sigma)) desc);
-- Platform (house) agents fill empty seats but are never rated; the ladder is real
-- players only. Drop any house rows a prior build wrote, so the ladder starts clean.
-- Idempotent: no house rows are written going forward, so this no-ops after the first run.
delete from poker_ratings r using agents_meta m
  where m.agent_id = r.agent_id and coalesce(m.is_house, false) = true;

-- The 0G-authored strategy policy an agent used for a contest, anchored on 0G Storage.
-- The policy override (a bounded tuning of the deterministic engine) is produced by a
-- 0G Compute call and uploaded to 0G Storage, so "the agent's strategy was authored on
-- 0G" is provable from the stored root. Reused across an agent's contests until refreshed.
create table if not exists poker_policies (
  agent_id     bigint not null,
  contest_id   bigint not null,
  override     jsonb not null,
  storage_root text,
  model        text,
  chat_id      text,
  created_at   timestamptz not null default now(),
  primary key (contest_id, agent_id)
);
-- Free opponent-dossier reads an agent has used. Beyond its tier's free allotment,
-- an agent pays for a dossier via x402.
alter table agents_meta add column if not exists dossier_free_used int not null default 0;

-- Contest type: 'solver' (puzzles) or 'analyst' (prediction markets).
alter table contests_meta add column if not exists kind text not null default 'solver';

create table if not exists contest_entries (
  contest_id  bigint not null,
  agent_id    bigint not null,
  operator    text not null,
  created_at  timestamptz not null default now(),
  primary key (contest_id, agent_id)
);
create index if not exists contest_entries_contest_idx on contest_entries (contest_id);

-- One row per agent answer. This is the live solve feed and the audit trail.
-- source/provider/model/chat_id/verified capture the 0G Compute provenance.
create table if not exists solve_runs (
  id          bigserial primary key,
  contest_id  bigint not null,
  agent_id    bigint not null,
  operator    text not null,
  puzzle_idx  int not null,
  prompt      text not null,
  expected    text,
  answer      text,
  verdict     text not null default 'pending',   -- correct | wrong | error | pending
  source      text,                              -- 0g-compute | 0g-router | offline-dev
  provider    text,
  model       text,
  chat_id     text,
  verified    boolean,
  latency_ms  int,
  created_at  timestamptz not null default now(),
  unique (contest_id, agent_id, puzzle_idx)
);
create index if not exists solve_runs_contest_idx on solve_runs (contest_id, id);

-- The live "winning metric" per agent per contest: the number the standings rank on
-- and that decides the winner, which differs by kind (poker = chip stack, world cup =
-- prediction P&L, the rest = correct answers). Runners upsert this as play advances so
-- the standings reveal real, live data instead of a placeholder zero. Correct-answer
-- kinds do not need a row (the standings derive their score from solve_runs verdicts).
create table if not exists contest_scores (
  contest_id  bigint not null,
  agent_id    bigint not null,
  score       double precision not null default 0,
  metric      text not null default 'points',  -- "chips" | "P&L" | "correct"
  updated_at  timestamptz not null default now(),
  primary key (contest_id, agent_id)
);

-- Self-consistency record: how many passes ran for an answer and how many backed
-- the winning one. Part of the provable audit (better builds vote more tightly).
alter table solve_runs add column if not exists samples int;
alter table solve_runs add column if not exists agreement int;
-- Analyst research: sources the agent gathered (via Exa) before forecasting.
alter table solve_runs add column if not exists sources int;

-- When the join window closes (on-chain endTime), so the contest page can show a
-- countdown and the phase.
alter table contests_meta add column if not exists ends_at timestamptz;

-- Host-set cap on how many operators can join (app-level; 0 or null = no cap).
alter table contests_meta add column if not exists max_operators int;

-- Entry-fee challenge: the per-entrant fee (6dp string) and the collected fee pot.
-- A contest has entry_fee '0'; a challenge builds its pot from these fees. fee_pool
-- is mirrored from the chain as entrants join and at settlement.
alter table contests_meta add column if not exists entry_fee text not null default '0';
alter table contests_meta add column if not exists fee_pool text not null default '0';

create table if not exists payouts (
  contest_id  bigint not null,
  operator    text not null,
  amount      text not null,        -- USDC 6dp, as a decimal string
  leaf_index  int not null,
  proof       jsonb not null,       -- array of 0x hex sibling hashes
  rank        int,
  claimed     boolean not null default false,
  primary key (contest_id, operator)
);

-- World Cup Prediction Mission pool. A cache of the live World Cup markets pulled
-- from Polymarket, plus each one's resolution state (filled in later when the real
-- event settles) and the rotation bookkeeping that keeps missions from repeating a
-- market until the whole pool has been used once.
create table if not exists worldcup_markets (
  condition_id     text primary key,   -- Polymarket conditionId, the stable key
  question         text not null,
  description      text,
  group_title      text,               -- e.g. "Spain" (the team/subject)
  event_title      text,               -- e.g. "World Cup Winner"
  end_date         timestamptz,        -- the market's own end date
  resolved         boolean not null default false,
  winner_index     int,                -- 0 = Yes, 1 = No, once resolved
  last_used_cycle  int not null default 0, -- rotation: cycle this market last appeared in
  first_seen       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists worldcup_markets_rotation_idx
  on worldcup_markets (resolved, last_used_cycle);

-- Single-row rotation state: the current rotation cycle. Bumped when the unused pool
-- for the current cycle is exhausted, which frees every market to appear again.
create table if not exists worldcup_state (
  id     int primary key default 1,
  cycle  int not null default 1
);
insert into worldcup_state (id, cycle) values (1, 1) on conflict (id) do nothing;

-- The markets a specific World Cup mission (contest) drew, in order. market_idx lines
-- up with solve_runs.puzzle_idx so the live feed and the audit reuse the same slot.
-- Fixed once at forecast time so the resolver knows exactly which events to wait on.
create table if not exists worldcup_mission_markets (
  contest_id   bigint not null,
  market_idx   int not null,
  condition_id text not null,
  question     text not null,
  primary key (contest_id, market_idx)
);

-- The market's Yes price (Polymarket implied probability) at forecast time, fixed with
-- the mission, plus the live price on the pool. The prediction-market P&L grader scores
-- an agent by how well it beat this price in the direction the market actually settled.
alter table worldcup_markets add column if not exists price double precision;
alter table worldcup_mission_markets add column if not exists price double precision;

-- The Polymarket sportsMarketType (e.g. "totals", "spreads", "both_teams_to_score"),
-- and the match subject (e.g. "Brazil vs. Norway"). Used to draw a mission that spans
-- distinct prediction types across distinct games rather than five near-identical lines
-- from one market family.
alter table worldcup_markets add column if not exists market_type text;
alter table worldcup_markets add column if not exists match_subject text;

-- Pre-built World Cup intel cache: a research brief per market (history, stats, the
-- pundit read), built once and reused across agents and missions, refreshed on a TTL.
-- The live-sentiment half of the intel pack is fetched fresh at forecast time and not
-- cached here.
create table if not exists worldcup_intel (
  condition_id text primary key,
  brief        text not null,
  updated_at   timestamptz not null default now()
);

-- Each agent's forecast for one mission market, as a probability the market resolves
-- Yes. Kept as a number so grading is exact once the real outcome is known (World Cup
-- missions settle later, not at the join-window close). latency feeds the speed tiebreak.
create table if not exists worldcup_forecasts (
  contest_id  bigint not null,
  agent_id    bigint not null,
  market_idx  int not null,
  prob_yes    double precision,
  latency_ms  int not null default 0,
  primary key (contest_id, agent_id, market_idx)
);

-- Agent memory (retrieved-context evolution): a compact, evolving self-profile an agent
-- carries across contests. After a contest settles, the agent's own recent play is
-- summarized by a 0G Compute call and folded in here; at decision time that summary is
-- injected into the agent's prompt, so a seasoned agent reasons with its accumulated
-- read instead of a blank prior. This is the agent's memory of ITSELF, distinct from the
-- poker dossier (memory of OPPONENTS). The summary is authored on 0G and anchored on 0G
-- Storage for provenance, so "the agent learned on 0G" is provable. House agents are
-- never summarized. Gated by AGENT_MEMORY. A version that could not be anchored on 0G
-- Storage is never written: the agent keeps its previous, provable memory instead.
create table if not exists agent_memory (
  agent_id      bigint primary key,
  summary       text not null default '',            -- the self-summary injected at decision time
  tendencies    jsonb not null default '{}'::jsonb,  -- structured read (accuracy by kind, recent form)
  contests      int not null default 0,              -- contests folded into this memory so far
  model         text,                                -- the 0G model that authored the summary
  chat_id       text,                                -- the 0G Compute request id (provenance)
  storage_root  text,                                -- 0G Storage anchor of this memory version
  updated_at    timestamptz not null default now()
);
-- Whether an answer was produced with the agent's memory injected into its prompt. Lets
-- the lift be measured: accuracy of graded answers with memory vs without (the A/B for
-- "agents improve with memory"). Default false, so pre-memory answers read as the control.
alter table solve_runs add column if not exists memory_used boolean not null default false;

-- An agent keeps a SEPARATE memory per contest kind: what it learned about puzzles is not
-- what it learned about chess. 'general' covers solver + analyst (which share a graded
-- correct/wrong record); 'poker' and 'chess' each carry their own, built from chips and
-- placements rather than from correctness.
alter table agent_memory add column if not exists kind text not null default 'general';
-- Repoint the primary key from (agent_id) to (agent_id, kind). Idempotent: only fires
-- while the old single-column key is still in place.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'agent_memory'::regclass and contype = 'p' and array_length(conkey, 1) = 1
  ) then
    alter table agent_memory drop constraint agent_memory_pkey;
    alter table agent_memory add constraint agent_memory_pkey primary key (agent_id, kind);
  end if;
end $$;

-- The memory market. Memory for poker and chess is a product the platform sells: an agent
-- spends 0G from its MemoryEscrow balance for every 0G call that reasons with its memory.
--
-- Debits accrue OFF chain during a contest (a chess tournament makes hundreds of calls;
-- one transaction each would be absurd) and settle as a single on-chain charge() when the
-- contest ends. `charge_tx` is that settlement. A row with a null charge_tx is money the
-- agent owes and the platform has not yet collected, which is why debits are flushed every
-- contest: the platform's exposure to an owner withdrawing mid-contest is capped at one
-- contest's worth of calls.
create table if not exists memory_debits (
  id          bigserial primary key,
  agent_id    bigint not null,
  contest_id  bigint not null,
  kind        text not null,
  calls       int not null default 0,          -- 0G calls that ran with memory injected
  amount_wei  numeric(78,0) not null default 0, -- calls * price per call, in 0G wei
  charge_tx   text,                             -- the on-chain MemoryEscrow.charge() that settled it
  created_at  timestamptz not null default now()
);
create index if not exists memory_debits_unsettled_idx on memory_debits (agent_id) where charge_tx is null;
create index if not exists memory_debits_contest_idx on memory_debits (contest_id);
-- What the agent bought: 'memory' (a memory-assisted 0G call) or 'dossier:N' (an opponent
-- read at tier N). Both draw on the same escrow balance.
alter table memory_debits add column if not exists item text not null default 'memory';

-- Opponent dossiers, sold in TIERS. A dossier is never the full picture: tier 1 is a
-- coarse read, tier 2 adds the numbers, tier 3 adds the showdown and all-in profile. An
-- agent can never learn as much about an opponent as that opponent knows about itself.
--
-- How many tiers an agent may buy against one opponent is set by its Compute level, so the
-- 0G investment buys depth of information as well as depth of thought:
--   levels 0-3 -> 1 tier, level 4 -> 2 tiers, level 5 -> 3 tiers.
--
-- A purchase is permanent and per-opponent: buy tier 2 on agent #7 once, and you keep it.
create table if not exists dossier_purchases (
  buyer_agent     bigint not null,
  opponent_agent  bigint not null,
  tier            int not null,
  contest_id      bigint,
  amount_wei      numeric(78,0) not null default 0,  -- 0G paid, from the buyer's MemoryEscrow
  charge_tx       text,                              -- the on-chain charge() that paid for it
  created_at      timestamptz not null default now(),
  primary key (buyer_agent, opponent_agent, tier)
);
create index if not exists dossier_purchases_buyer_idx on dossier_purchases (buyer_agent, opponent_agent);

-- Zero Cup vote-gas faucet. A voter needs a whisper of 0G MAINNET gas to boost their vote on
-- 0G's own site, and most people arriving from a tweet have none. We send them a fixed, tiny
-- amount, once, and record it here.
--
-- The address is the primary key, so the claim is once per wallet, forever. The row is written
-- BEFORE the transfer and deleted if the transfer fails, which makes a slow send safe to retry
-- without paying twice. `amount_wei` is real mainnet 0G, so this table is also the ledger of
-- what the campaign has spent.
create table if not exists vote_gas_claims (
  address    text primary key,      -- lowercased recipient wallet
  amount_wei numeric not null,
  tx_hash    text,                  -- null while the send is in flight
  created_at timestamptz not null default now()
);
create index if not exists vote_gas_claims_created_idx on vote_gas_claims (created_at desc);
