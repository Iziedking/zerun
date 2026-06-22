import type { WsSettledPayload } from "@/lib/types";
import { formatUsdc, shortAddr, shortId } from "@/lib/format";
import { Agent, Confetti, StickerCard } from "./zerun";

export function SettledBanner({ data }: { data: WsSettledPayload }) {
  const payouts = data.payouts.slice().sort((a, b) => a.rank - b.rank);

  return (
    <StickerCard className="relative overflow-hidden p-5">
      <Confetti />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-display text-xl text-ink">Settled on 0G</h3>
          <span className="font-mono text-[11px] text-ink-3" title={data.root}>
            root {shortId(data.root, 8, 6)}
          </span>
        </div>

        {/* The winner hops. */}
        <div className="mt-3 flex justify-center">
          <Agent variant="amber" mood="happy" size={92} />
        </div>

        <ul className="mt-3 space-y-2">
          {payouts.map((p) => (
            <li
              key={`${p.operator}-${p.rank}`}
              className="flex items-center justify-between rounded-chunk border-line border-ink bg-cloud-2 px-3 py-2"
            >
              <span className="flex items-center gap-3">
                <span className="font-display text-lg text-ink">#{p.rank}</span>
                <span className="font-mono text-[12px] text-ink-2">
                  {shortAddr(p.operator)}
                </span>
              </span>
              <span className="font-display text-base text-ink">
                {formatUsdc(p.amount)}{" "}
                <span className="font-body text-[13px] font-extrabold text-ink-2">tUSDC</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </StickerCard>
  );
}
