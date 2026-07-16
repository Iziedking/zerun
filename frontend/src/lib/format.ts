// USDC and tUSDC use 6 decimals throughout the backend (strings) and contracts.
export const USDC_DECIMALS = 6;

export function formatUsdc(raw: string | bigint | number | null | undefined): string {
  if (raw === null || raw === undefined) return "0.00";
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(typeof raw === "number" ? Math.trunc(raw) : raw);
  } catch {
    return "0.00";
  }
  const base = 10n ** BigInt(USDC_DECIMALS);
  const neg = v < 0n;
  if (neg) v = -v;
  // Round to two decimals.
  const hundredths = (v * 100n + base / 2n) / base;
  const whole = hundredths / 100n;
  const cents = hundredths % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

// "1st", "2nd", "3rd", "4th"… for a finishing place.
export function ordinal(n: number): string {
  const v = Math.abs(Math.trunc(n));
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  switch (v % 10) {
    case 1:
      return `${v}st`;
    case 2:
      return `${v}nd`;
    case 3:
      return `${v}rd`;
    default:
      return `${v}th`;
  }
}

// Whole tUSDC with thousands separators, no decimals. For big "total" stats where
// the cents are noise and the full number needs to fit a narrow card.
export function formatUsdcWhole(raw: string | bigint | number | null | undefined): string {
  if (raw === null || raw === undefined) return "0";
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(typeof raw === "number" ? Math.trunc(raw) : raw);
  } catch {
    return "0";
  }
  const base = 10n ** BigInt(USDC_DECIMALS);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = (v + base / 2n) / base; // round to the nearest whole tUSDC
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}`;
}

// ERC-8004 agent identities are minted on 0G mainnet's canonical IdentityRegistry (chain 16661). The
// link opens the registry contract on the 0G explorer so anyone can confirm it is a real, portable
// on-chain 0G agent registry. (chainscan.0g.ai has no working per-token page for a large-supply ERC-721,
// so we link the contract, not the individual token id; the id is still shown in the UI.)
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const identityUrl = (_tokenId: number) => `https://chainscan.0g.ai/address/${IDENTITY_REGISTRY}`;

export function shortAddr(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortId(id: string | null | undefined, head = 8, tail = 6): string {
  if (!id) return "";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "·";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
