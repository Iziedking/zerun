"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAccount, useSignMessage } from "wagmi";
import { friendlyError } from "./errors";

// One shared sign-in state for the whole app. Signing in anywhere (the modal or
// the navbar) updates everywhere at once, so the flow stays in step: connect,
// then sign in to prove ownership, then you are in. Sign-in is a wallet
// signature (no transaction, no gas) remembered per address on this device.

const KEY = (addr: string) => `zerun:signin:${addr.toLowerCase()}`;

interface AuthState {
  signedIn: boolean;
  signing: boolean;
  error: string | null;
  signIn: () => Promise<boolean>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [signedIn, setSignedIn] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-derive from storage whenever the connected address changes.
  useEffect(() => {
    setError(null);
    if (!address) {
      setSignedIn(false);
      return;
    }
    try {
      setSignedIn(localStorage.getItem(KEY(address)) === "1");
    } catch {
      setSignedIn(false);
    }
  }, [address]);

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    setSigning(true);
    setError(null);
    try {
      const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      const message = [
        "Sign in to Zerun.",
        "",
        "This signature proves you own this wallet. It is not a transaction and costs no gas.",
        "",
        `Wallet: ${address}`,
        `Nonce: ${nonce}`,
      ].join("\n");
      await signMessageAsync({ message });
      try {
        localStorage.setItem(KEY(address), "1");
      } catch {
        /* private mode: session stays in memory */
      }
      setSignedIn(true);
      return true;
    } catch (err) {
      setError(friendlyError(err, "That sign-in did not go through. Try once more."));
      return false;
    } finally {
      setSigning(false);
    }
  }, [address, signMessageAsync]);

  const signOut = useCallback(() => {
    if (address) {
      try {
        localStorage.removeItem(KEY(address));
      } catch {
        /* ignore */
      }
    }
    setSignedIn(false);
    setError(null);
  }, [address]);

  return (
    <AuthContext.Provider value={{ signedIn, signing, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
