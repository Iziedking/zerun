import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the shared root .env first (where the deployer key and 0G settings live),
// then an optional backend-local .env that can override for development.
const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "../../../.env");
const localEnv = resolve(here, "../../.env");
if (existsSync(rootEnv)) loadEnv({ path: rootEnv });
if (existsSync(localEnv)) loadEnv({ path: localEnv, override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  chain: {
    rpcUrl: optional("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"),
    chainId: Number(optional("OG_CHAIN_ID", "16602")),
    explorer: optional("OG_EXPLORER", "https://chainscan-galileo.0g.ai"),
  },
  // The coordinator wallet signs root posts, settlements, and pays for every
  // inference call on 0G Compute. On the testnet MVP this is the deployer key.
  signerKey: process.env.DEPLOYER_PRIVATE_KEY ?? "",
  compute: {
    // How much 0G to seed the broker ledger with on first run.
    ledgerOg: Number(optional("COMPUTE_LEDGER_OG", "3")),
    // How much 0G to lock to a single provider sub-account.
    perProviderOg: Number(optional("COMPUTE_PROVIDER_OG", "1")),
    // Pin a known-good provider address. Empty means auto-pick the first live one.
    pinnedProvider: process.env.COMPUTE_PROVIDER ?? "",
    // Per-call timeout so one slow provider can never stall a contest run.
    callTimeoutMs: Number(optional("COMPUTE_TIMEOUT_MS", "60000")),
    // Fallback path: the 0G Compute Router (OpenAI-compatible single endpoint).
    routerBaseUrl: process.env.COMPUTE_ROUTER_BASE_URL ?? "",
    routerApiKey: process.env.COMPUTE_ROUTER_API_KEY ?? "",
  },
  db: {
    url: optional("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/zerun"),
  },
  server: {
    port: Number(optional("PORT", "8787")),
  },
};

export function signerConfigured(): boolean {
  return Boolean(config.signerKey);
}
