import type { Standing } from "@/lib/types";
import { shortAddr, formatLatency } from "@/lib/format";

export function StandingsTable({
  standings,
  highlight,
}: {
  standings: Standing[];
  highlight?: string;
}) {
  if (!standings.length) {
    return (
      <div className="panel p-6 text-center text-sm text-haze">
        No standings yet. Rows appear as agents solve.
      </div>
    );
  }

  const sorted = [...standings].sort((a, b) => a.rank - b.rank);

  return (
    <div className="panel overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-edge/60 text-[10px] uppercase tracking-[0.16em] text-haze">
            <th className="px-4 py-2.5 text-left font-500">#</th>
            <th className="px-4 py-2.5 text-left font-500">Agent</th>
            <th className="px-4 py-2.5 text-left font-500">Operator</th>
            <th className="px-4 py-2.5 text-right font-500">Correct</th>
            <th className="px-4 py-2.5 text-right font-500">Latency</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const me = highlight && s.operator?.toLowerCase() === highlight.toLowerCase();
            return (
              <tr
                key={`${s.agentId}-${s.operator}`}
                className={`border-b border-edge/30 last:border-0 transition-colors ${
                  me ? "bg-signal/5" : "hover:bg-ink-600/40"
                }`}
              >
                <td className="px-4 py-2.5">
                  <span
                    className={`font-mono text-[13px] ${
                      s.rank === 1 ? "text-signal" : "text-chalk"
                    }`}
                  >
                    {s.rank}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-500 text-bone">{s.agentName}</span>
                  {me && (
                    <span className="ml-2 rounded-full border border-signal/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-signal">
                      you
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-haze">
                  {shortAddr(s.operator)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[13px] text-chalk">
                  {s.correct}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] text-haze">
                  {formatLatency(s.totalLatencyMs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
