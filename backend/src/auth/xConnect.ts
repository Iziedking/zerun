import { createHash, randomBytes } from "node:crypto";
import { publicClient } from "../chain/contracts.js";
import { query } from "../db/pool.js";

// X (Twitter) account connect via OAuth 2.0 with PKCE. Soft-gate v1: linking an X
// account puts a verified badge on the operator's profile; nothing is blocked. The
// unique(x_id) constraint in social_identity is the anti-Sybil spine (one X account,
// one wallet). Credentials come from env, so the flow ships now and activates once the
// X developer app is configured. Identity scope only (users.read tweet.read) — the
// least privilege that yields the handle for the badge.

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const ME_URL = "https://api.twitter.com/2/users/me?user.fields=username,name";
const SCOPE = "users.read tweet.read";

const MAX_AGE_MS = 5 * 60 * 1000; // the connect signature is good for five minutes
const FUTURE_SKEW_MS = 60 * 1000;

export function xConfigured(): boolean {
  return Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && process.env.X_REDIRECT_URI);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The message the wallet signs to prove it owns itself before we bind an X account to
// it (stops griefing someone else's profile with your handle). The frontend builds the
// same string; keep the two in sync.
export function xConnectMessage(owner: string, issuedAt: number): string {
  return `Zerun connect X\nwallet: ${owner.toLowerCase()}\nissued: ${issuedAt}`;
}

export async function verifyWalletSig(
  owner: string,
  issuedAt: number,
  signature: string,
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !issuedAt || !signature) return false;
  const now = Date.now();
  if (issuedAt > now + FUTURE_SKEW_MS || now - issuedAt > MAX_AGE_MS) return false;
  try {
    return await publicClient.verifyMessage({
      address: owner.toLowerCase() as `0x${string}`,
      message: xConnectMessage(owner, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

interface PendingAuth {
  wallet: string;
  codeVerifier: string;
  expiresAt: number;
}
// Short-lived PKCE state, keyed by the opaque `state` value. In memory is fine: the
// flow completes in minutes, and a backend restart mid-flow just means the user
// reconnects. Swept lazily on each begin.
const pending = new Map<string, PendingAuth>();
function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

// Start the flow for an (already signature-verified) wallet: mint PKCE + state and
// return the X authorize URL.
export function beginXAuth(wallet: string): { url: string; state: string } {
  sweep();
  const state = b64url(randomBytes(24));
  const codeVerifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(codeVerifier).digest());
  pending.set(state, { wallet: wallet.toLowerCase(), codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 });
  const p = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID!,
    redirect_uri: process.env.X_REDIRECT_URI!,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_URL}?${p.toString()}`, state };
}

export interface XIdentity {
  handle: string;
  name: string | null;
  xId: string;
}

// Finish the flow: exchange the code for a token, read the X identity, and bind it to
// the wallet the flow was started for. Throws with a friendly message on any failure.
export async function completeXAuth(code: string, state: string): Promise<{ wallet: string } & XIdentity> {
  const rec = pending.get(state);
  if (!rec) throw new Error("that connection expired, start it again");
  pending.delete(state);

  const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.X_REDIRECT_URI!,
      code_verifier: rec.codeVerifier,
      client_id: process.env.X_CLIENT_ID!,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`X token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("X did not return an access token");

  const meRes = await fetch(ME_URL, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!meRes.ok) throw new Error(`X profile fetch failed (${meRes.status})`);
  const me = (await meRes.json()) as { data?: { id?: string; username?: string; name?: string } };
  const xId = me.data?.id;
  const handle = me.data?.username;
  if (!xId || !handle) throw new Error("X profile did not include an id and handle");
  const name = me.data?.name ?? null;

  try {
    await query(
      `insert into social_identity (wallet, x_id, x_handle, x_name, verified_at)
         values ($1, $2, $3, $4, now())
       on conflict (wallet) do update set
         x_id = excluded.x_id, x_handle = excluded.x_handle, x_name = excluded.x_name, verified_at = now()`,
      [rec.wallet, xId, handle, name],
    );
  } catch (err) {
    // unique(x_id) violation: this X account is already bound to a different wallet.
    if ((err as { code?: string }).code === "23505") {
      throw new Error("that X account is already linked to another wallet");
    }
    throw err;
  }
  return { wallet: rec.wallet, handle, name, xId };
}

export async function xIdentityFor(
  wallet: string,
): Promise<{ handle: string; name: string | null; verifiedAt: string } | null> {
  const { rows } = await query<{ x_handle: string; x_name: string | null; verified_at: string }>(
    "select x_handle, x_name, verified_at::text as verified_at from social_identity where wallet = $1",
    [wallet.toLowerCase()],
  );
  const r = rows[0];
  return r ? { handle: r.x_handle, name: r.x_name, verifiedAt: r.verified_at } : null;
}
