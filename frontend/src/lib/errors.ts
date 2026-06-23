// Turn any thrown error (a wallet rejection, a chain switch, a contract revert,
// a network blip) into a short, friendly, in-world message. The UI only ever
// shows these, never a raw error string.
export function friendlyError(
  err: unknown,
  fallback = "Something glitched. Give it another go.",
): string {
  const e = err as { code?: number; name?: string; message?: string; shortMessage?: string };
  const msg = (e?.shortMessage || e?.message || "").toLowerCase();
  const code = e?.code;

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
