import { zeroGGalileo } from "@/lib/chain";
import { shortId } from "@/lib/format";
import { StickerCard } from "./zerun";

// Shows that a settled contest's full solve feed is stored on 0G Storage, addressed
// by its root hash. The storage transaction links to the explorer.
export function AuditTrail({ root, tx }: { root: string; tx: string | null }) {
  const explorer = zeroGGalileo.blockExplorers.default.url;
  return (
    <StickerCard className="p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-xl text-ink">Audit trail on 0G Storage</h3>
        {tx && (
          <a
            href={`${explorer}/tx/${tx}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-pill border-line border-ink bg-cloud px-3 py-1 font-mono text-[11px] text-ink shadow-pop-press transition hover:-translate-y-px"
          >
            storage tx {shortId(tx, 6, 4)}
          </a>
        )}
      </div>
      <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
        Every answer in this contest, with its 0G Compute provenance, is stored on 0G
        Storage and addressed by this root hash.
      </p>
      <div className="mt-3 break-all rounded-chunk border-line border-ink bg-cloud-2 p-3 font-mono text-[12px] text-ink">
        {root}
      </div>
    </StickerCard>
  );
}
