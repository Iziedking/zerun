"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Chip, PopButton } from "./zerun";
import { Spinner } from "./ui";

// The exact message the wallet signs to prove it owns itself before we bind an X
// account. Must match backend src/auth/xConnect.ts xConnectMessage.
function xConnectMessage(owner: string, issuedAt: number): string {
  return `Zerun connect X\nwallet: ${owner.toLowerCase()}\nissued: ${issuedAt}`;
}

function XLogo() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.9l-5.4-7-6.2 7H1.6l8.2-9.3L1 2h7l4.9 6.5L18.9 2Zm-2.4 18h1.9L7.6 4H5.6l10.9 16Z" />
    </svg>
  );
}

// The X-connect control for a profile. Shows a verified badge (linking to the X profile)
// when the wallet has linked an account; on the owner's own profile, when X connect is
// configured and no account is linked, shows a "Connect X" button that signs a message
// and hands off to the X OAuth flow. Renders nothing on someone else's unlinked profile.
export function ConnectX({ address, isMe }: { address: string; isMe: boolean }) {
  const { address: connected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idQ = useQuery({
    queryKey: ["x-identity", address.toLowerCase()],
    queryFn: () => api.xIdentity(address),
    staleTime: 30_000,
  });
  const statusQ = useQuery({ queryKey: ["x-status"], queryFn: () => api.xStatus(), staleTime: 300_000 });
  const identity = idQ.data?.identity;

  if (identity) {
    return (
      <a
        href={`https://x.com/${identity.handle}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex"
        title={`Verified on X${identity.name ? ` as ${identity.name}` : ""}`}
      >
        <Chip tone="live">
          <span className="inline-flex items-center gap-1.5">
            <XLogo /> @{identity.handle}
          </span>
        </Chip>
      </a>
    );
  }

  // Only the owner can connect, and only when the server has X configured.
  if (!isMe || !statusQ.data?.enabled) return null;

  const connect = async () => {
    setError(null);
    if (!connected) {
      setError("Connect your wallet first.");
      return;
    }
    setBusy(true);
    try {
      const owner = connected.toLowerCase();
      const issuedAt = Date.now();
      const signature = await signMessageAsync({ message: xConnectMessage(owner, issuedAt) });
      const { url } = await api.xStart({ owner, issuedAt, signature });
      // Remember where the connect started (e.g. the chess page) so the callback returns here instead
      // of always dropping the user on their profile. Survives the round trip to X in the same tab.
      try {
        localStorage.setItem("zerun:xReturnTo", window.location.pathname + window.location.search);
      } catch {
        /* storage may be unavailable; the callback just falls back to the profile */
      }
      window.location.href = url; // hand off to X for authorization
    } catch (e) {
      setError(friendlyError(e, "Could not start the X connection. Try again."));
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <PopButton
        type="button"
        variant="secondary"
        onClick={connect}
        disabled={busy}
        icon={busy ? <Spinner /> : <XLogo />}
      >
        Connect X
      </PopButton>
      {error && <span className="font-body text-[11px] font-bold text-coral">{error}</span>}
    </span>
  );
}
