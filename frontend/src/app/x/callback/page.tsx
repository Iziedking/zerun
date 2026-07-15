"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Agent, StickerCard } from "@/components/zerun";

// The X OAuth redirect lands here with ?code & ?state. We post them to the backend,
// which exchanges the code and binds the X identity to the wallet the flow started for,
// then send the user to their profile. The wallet binding was proven by a signature at
// start, so the callback needs no wallet connection of its own.
function XCallbackInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const [msg, setMsg] = useState("Linking your X account…");
  const [ok, setOk] = useState<boolean | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // the OAuth code is single-use; never post it twice
    ran.current = true;
    const code = sp.get("code");
    const state = sp.get("state");
    const denied = sp.get("error");
    if (denied) {
      setOk(false);
      setMsg("The X sign-in was cancelled. You can try again from your profile.");
      return;
    }
    if (!code || !state) {
      setOk(false);
      setMsg("This link is missing the code from X. Start the connection again from your profile.");
      return;
    }
    api
      .xCallback({ code, state })
      .then((r) => {
        setOk(true);
        // Return to where the connect started (e.g. the chess page); fall back to the profile. Only
        // honor an internal path, never an absolute URL, so this can't be used to bounce off-site.
        let dest = `/profile/${r.wallet}`;
        try {
          const rt = localStorage.getItem("zerun:xReturnTo");
          localStorage.removeItem("zerun:xReturnTo");
          if (rt && rt.startsWith("/") && !rt.startsWith("//")) dest = rt;
        } catch {
          /* ignore storage errors; keep the profile fallback */
        }
        setMsg(dest.startsWith("/profile") ? `Linked @${r.handle}. Taking you to your profile…` : `Linked @${r.handle}. Taking you back…`);
        setTimeout(() => router.push(dest), 1400);
      })
      .catch((e) => {
        setOk(false);
        setMsg(friendlyError(e, "Could not link your X account. Try again from your profile."));
      });
  }, [sp, router]);

  return (
    <div className="grid place-items-center pt-16">
      <StickerCard className="max-w-md p-8 text-center">
        <div className="flex justify-center">
          <Agent variant={ok === false ? "coral" : "mint"} mood={ok === false ? "lose" : "happy"} size={110} name="X connect" />
        </div>
        <p className="mt-4 font-body text-[15px] font-bold text-ink">{msg}</p>
      </StickerCard>
    </div>
  );
}

export default function XCallbackPage() {
  return (
    <Suspense fallback={<div className="pt-16 text-center font-body text-ink-2">Linking your X account…</div>}>
      <XCallbackInner />
    </Suspense>
  );
}
