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
