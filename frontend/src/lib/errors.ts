// Turn any thrown error (a wallet rejection, a chain switch, a contract revert,
// a network blip) into a short, friendly, in-world message. The UI only ever
// shows these, never a raw error string.
export function friendlyError(
  err: unknown,
  fallback = "Something glitched. Give it another go.",
): string {
  const e = err as { code?: number; name?: string; message?: string; shortMessage?: string };
  const raw = e?.shortMessage || e?.message || "";
  const msg = raw.toLowerCase();
  const code = e?.code;

  // Our API helper throws `Error("409 Conflict: {\"error\":\"...\"}")`. When the
  // backend hands us a short, in-world reason (already entered, window closed),
  // surface that reason directly rather than a generic fallback.
  const backend = backendError(raw);
  if (backend) return backend;

  // The operator waved it off in the wallet.
  if (code === 4001 || /user rejected|user denied|rejected the request|request was denied|denied/.test(msg)) {
    return "No worries, you waved it off. Tap again when you are ready.";
  }
  // Wrong or missing network.
  if (code === 4902 || (/chain|network/.test(msg) && /switch|add|unrecognized|mismatch/.test(msg))) {
    return "Your wallet needs to be on 0G. Switch over and try again.";
  }
  // Not enough gas or funds.
  if (/insufficient funds|insufficient balance|gas required|out of gas|exceeds balance/.test(msg)) {
    return "Not enough 0G for gas. Grab some from the faucet and retry.";
  }
  // The contract turned it down.
  if (/revert|execution reverted|already entered|already claimed|not allowed|unauthorized|too low/.test(msg)) {
    return "The chain said no on that one. Check the details and try again.";
  }
  // Connection or backend hiccup.
  if (/failed to fetch|network ?error|timeout|timed out|fetch failed|load failed/.test(msg)) {
    return "The connection hiccuped. Give it another go in a moment.";
  }
  return fallback;
}

// Pull a `{ "error": "..." }` message out of an API error string, if present.
// The reason is trusted to already be a short, friendly sentence from our own
// backend (e.g. an entry-guard 409). Returns null when there is nothing usable.
function backendError(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(raw.slice(start)) as { error?: unknown };
    const reason = typeof parsed.error === "string" ? parsed.error.trim() : "";
    if (reason && reason.length <= 160) return reason;
  } catch {
    /* not JSON; fall through to pattern matching */
  }
  return null;
}
