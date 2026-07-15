"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { identityUrl } from "@/lib/format";
import { Agent, Chip, StickerCard } from "@/components/zerun";

// A shareable proof page for one inference-receipt batch. It shows what each 0G-compute answer
// committed to, the Merkle root, and how to check that root against the on-chain anchor. Anyone with
// the link can audit an agent's thinking on 0G.

function short(s: string, head = 10, tail = 8): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export default function ReceiptBatchPage() {
  const params = useParams<{ root: string }>();
  const root = String(params.root ?? "");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["receipt-batch", root],
    queryFn: () => api.receiptBatch(root),
    staleTime: 300_000,
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 pt-8 pb-16">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Chip tone="live">verifiable receipts</Chip>
          <h1 className="mt-3 font-display text-[clamp(30px,6vw,52px)] leading-none text-ink">Inference proof</h1>
          <p className="mt-3 max-w-xl font-body text-[15px] leading-relaxed text-ink-2">
            Every answer below was produced on the 0G Compute Network, hashed into a receipt, and
            committed to the Merkle root shown here. The root is anchored on 0G, so this record cannot be
            changed after the fact.
          </p>
        </div>
        <div className="shrink-0 self-center">
          <Agent variant="mint" mood="happy" size={110} name="a verified agent" />
        </div>
      </header>

      {isLoading ? (
        <StickerCard className="p-8 text-center font-body text-ink-2">Loading the proof…</StickerCard>
      ) : isError || !data ? (
        <StickerCard className="p-8 text-center">
          <p className="font-body text-[15px] text-ink-2">No proof was found for this root.</p>
          <Link href="/arena" className="mt-3 inline-block font-body text-[14px] font-extrabold text-violet underline">
            Back to the arena
          </Link>
        </StickerCard>
      ) : (
        <>
          <StickerCard className="p-5 sm:p-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Agent identity (0G)">
                <a
                  href={identityUrl(data.agentId)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-violet underline decoration-violet/40 underline-offset-2"
                >
                  #{data.agentId}
                </a>
              </Field>
              <Field label="Receipts in this batch">
                <span className="font-display text-lg text-ink">{data.leafCount}</span>
              </Field>
              <Field label="Merkle root">
                <span className="font-mono text-[13px] text-ink" title={data.merkleRoot}>{short(data.merkleRoot)}</span>
              </Field>
              <Field label="Anchored">
                <span className="font-body text-[14px] text-ink-2">
                  {new Date(data.createdAt).toLocaleString()}
                </span>
              </Field>
            </div>
          </StickerCard>

          <div className="overflow-x-auto">
            <StickerCard className="min-w-[640px] p-0">
              <table className="w-full border-separate border-spacing-0">
                <thead>
                  <tr className="text-left font-body text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink-3">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">TEE</th>
                    <th className="px-4 py-3">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {data.receipts.map((r, i) => (
                    <tr key={i} className={i % 2 ? "bg-cloud-2" : "bg-cloud"}>
                      <td className="border-t-2 border-ink/10 px-4 py-2.5 font-mono text-[12px] text-ink-3">{i + 1}</td>
                      <td className="border-t-2 border-ink/10 px-4 py-2.5 font-body text-[13px] font-bold text-ink">{r.model || "—"}</td>
                      <td className="border-t-2 border-ink/10 px-4 py-2.5 font-mono text-[12px] text-ink-2" title={r.provider}>
                        {r.provider ? short(r.provider, 6, 4) : "—"}
                      </td>
                      <td className="border-t-2 border-ink/10 px-4 py-2.5">
                        {r.verified ? <Chip tone="live">verified</Chip> : <span className="font-body text-[12px] text-ink-3">—</span>}
                      </td>
                      <td className="border-t-2 border-ink/10 px-4 py-2.5 font-mono text-[12px] text-ink-2">{short(r.answer, 40, 12)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </StickerCard>
          </div>

          <StickerCard className="p-5 sm:p-7" inset>
            <h2 className="font-display text-xl text-ink">How to verify this yourself</h2>
            <ol className="mt-3 space-y-2 font-body text-[14px] leading-relaxed text-ink-2">
              <li>1. Fetch the full batch data, in order, from the record above.</li>
              <li>2. For each receipt, recompute its leaf hash the way the batch describes it.</li>
              <li>3. Build the Merkle root from the leaves and confirm it equals the root on this page.</li>
              <li>
                4. Confirm the same root is recorded on-chain against agent identity #{data.agentId} in the
                0G ValidationRegistry.
              </li>
            </ol>
            <p className="mt-3 font-mono text-[12px] text-ink-3">{data.algorithm}</p>
          </StickerCard>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink-3">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
