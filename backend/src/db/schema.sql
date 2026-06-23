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
