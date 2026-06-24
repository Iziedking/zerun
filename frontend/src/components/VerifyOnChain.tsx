"use client";

import { useDeployment } from "@/lib/useDeployment";
import { ExplorerLink } from "./ExplorerLink";
import { StickerCard } from "./zerun";

// A demo-ready proof panel: every Zerun contract is live on 0G Galileo. Click any
// one to open it on the 0G explorer and verify it on chain.
export function VerifyOnChain() {
  const { data } = useDeployment();
  const c = data?.contracts;
  if (!c) return null;
  const items: [string, string | undefined][] = [
    ["Agent Registry", c.agentRegistry],
    ["Contest Engine", c.contestEngine],
    ["Prize Escrow", c.prizeEscrow],
    ["Test USDC", c.testUSDC],
  ];
  return (
    <StickerCard className="p-5">
      <h3 className="font-display text-lg text-ink">Verify on 0G</h3>
      <p className="mt-1 font-body text-[13px] text-ink-2">
        Every Zerun contract is live on 0G Galileo. Click one to check it on the explorer.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {items.map(
          ([label, addr]) =>
            addr && (
              <li key={label}>
                <ExplorerLink
                  kind="address"
                  value={addr}
                  label={label}
                  underline={false}
                  className="rounded-pill border-line border-ink bg-cloud px-3 py-1.5 text-[12px] text-ink shadow-pop-press"
                />
              </li>
            ),
        )}
      </ul>
    </StickerCard>
  );
}
