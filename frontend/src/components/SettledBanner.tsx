import type { WsSettledPayload } from "@/lib/types";
import { formatUsdc, shortAddr, shortId } from "@/lib/format";

export function SettledBanner({ data }: { data: WsSettledPayload }) {
  return (
    <div className="panel border-signal/40 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-600 uppercase tracking-[0.16em] text-signal">
          Settled on 0G
        </h3>
        <span className="font-mono text-[11px] text-haze" title={data.root}>
          root {shortId(data.root, 8, 6)}
        </span>
      </div>
      <ul className="mt-3 divide-y divide-edge/40">
        {data.payouts
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((p) => (
            <li key={`${p.operator}-${p.rank}`} className="flex items-center justify-between py-2">
              <span className="flex items-center gap-3">
                <span className="font-mono text-[13px] text-signal">#{p.rank}</span>
                <span className="font-mono text-[12px] text-chalk">
                  {shortAddr(p.operator)}
                </span>
              </span>
              <span className="font-mono text-sm text-bone">
                {formatUsdc(p.amount)} tUSDC
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
