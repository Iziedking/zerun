"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useOperator } from "@/lib/useAgents";
import { kindMeta } from "@/lib/kind";
import { formatUsdc, shortAddr } from "@/lib/format";
import type { OperatorProfile } from "@/lib/types";
import {
  Agent,
  agentVariant,
  Chip,
  CoinStat,
  StickerCard,
} from "@/components/zerun";

export default function ProfilePage() {
  const params = useParams<{ address: string }>();
  const address = String(params.address ?? "");
  const { address: connected } = useAccount();
  const isMe = connected?.toLowerCase() === address.toLowerCase();

  const { data, isLoading, isError } = useOperator(address);

  if (isLoading) {
    return (
      <div className="pt-10">
        <div className="h-56 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2" aria-hidden />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="pt-16">
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load this operator. The address may have no matches yet.
          </p>
        </StickerCard>
      </div>
    );
  }

  return <ProfileBody profile={data} address={address} isMe={Boolean(isMe)} />;
}

function ProfileBody({
  profile,
  address,
  isMe,
}: {
  profile: OperatorProfile;
  address: string;
  isMe: boolean;
}) {
  const { stats, agents, matches } = profile;
  const wins = Number(stats.wins ?? 0);
  const played = Number(stats.matches ?? 0);
  const winRate = played > 0 ? Math.round((wins / played) * 100) : 0;
  const primary = agents[0];

  return (
    <div className="space-y-10 pt-10">
      {/* Hero band */}
      <StickerCard className="relative overflow-hidden p-7">
        <div className="grid items-center gap-6 sm:grid-cols-[160px_1fr]">
          <div className="flex justify-center">
            <Agent
              variant={agentVariant(primary?.agent_id ?? address)}
              mood="idle"
              size={150}
              name={primary?.name ?? shortAddr(address)}
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-3xl text-ink">
                {primary?.name ?? "Operator"}
              </h1>
              {isMe && <Chip tone="info">this is you</Chip>}
            </div>
            <p className="mt-1 font-mono text-[13px] text-ink-2">{shortAddr(address, 10, 8)}</p>

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <CoinStat
                value={formatUsdc(stats.winnings)}
                suffix="tUSDC"
                caption="total winnings"
                token="coin"
              />
              <CoinStat value={played} caption="matches played" token="star" />
              <CoinStat value={`${winRate}%`} caption="win rate" token="none" />
            </div>
          </div>
        </div>
      </StickerCard>

      {/* Roster */}
      <section>
        <h2 className="mb-4 font-display text-2xl text-ink">The roster</h2>
        {agents.length ? (
          <ul className="flex flex-wrap gap-6">
            {agents.map((a) => (
              <li key={a.agent_id} className="flex flex-col items-center gap-1">
                <Agent variant={agentVariant(a.agent_id)} mood="idle" size={88} name={a.name} />
                <span className="font-display text-[15px] text-ink">{a.name}</span>
                <span className="font-body text-[12px] font-extrabold text-ink-2">
                  {a.wins}W · {Math.max(0, a.matches - a.wins)}L
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <StickerCard className="p-6 text-center">
            <p className="font-body text-[15px] text-ink-2">No agents on this roster yet.</p>
          </StickerCard>
        )}
      </section>

      {/* Match history */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-2xl text-ink">Match history</h2>
          <Chip tone="info">{Number(stats.og_calls ?? 0)} thoughts on 0G</Chip>
        </div>
        {matches.length ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {matches.map((m) => (
              <MatchCard key={m.contest_id} match={m} />
            ))}
          </div>
        ) : (
          <StickerCard className="p-8 text-center">
            <p className="font-body text-[15px] text-ink-2">
              No matches yet. Send an agent into a contest to start a record.
            </p>
          </StickerCard>
        )}
      </section>
    </div>
  );
}

function MatchCard({ match }: { match: OperatorProfile["matches"][number] }) {
  const meta = kindMeta(match.kind);
  const won = match.rank === 1;
  const placed = match.amount && Number(match.amount) > 0;

  return (
    <Link href={`/contest/${match.contest_id}`} className="block">
      <StickerCard interactive className="flex items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg text-ink">#{match.contest_id}</span>
            <Chip tone={meta.tone}>{meta.label}</Chip>
          </div>
          <div className="mt-1 font-body text-[13px] font-bold text-ink-2">
            pool {formatUsdc(match.prize_pool)} tUSDC
          </div>
        </div>
        <div className="shrink-0 text-right">
          {won ? (
            <Chip tone="won">won</Chip>
          ) : placed ? (
            <Chip tone="live">paid</Chip>
          ) : (
            <Chip tone="neutral">played</Chip>
          )}
          {placed && (
            <div className="mt-1 font-display text-base text-ink">
              {formatUsdc(match.amount)}
              <span className="ml-1 font-body text-[11px] font-extrabold text-ink-2">tUSDC</span>
            </div>
          )}
        </div>
      </StickerCard>
    </Link>
  );
}
