import { query, closePool } from "../db/pool.js";
import { identityConfigured, identityExplorerUrl } from "../identity/erc8004.js";
import { mintArenaIdentity } from "../identity/arenaAgents.js";

// Pre-mint ERC-8004 identities for existing ARENA agents (agents_meta) that do not have one yet.
//
// Run this BEFORE announcing the claim campaign: it mints every existing agent's identity up front
// (platform-held), so at claim time the owner pays for nothing and the claim is a single fast transfer
// instead of a mint-plus-transfer. Skips house agents and anything already minted. Safe by default: a
// dry run that changes nothing until CONFIRM=mint.
//
//   # 1. see how many existing arena agents are missing an identity (changes nothing):
//   npx tsx src/scripts/arenaMintIdentities.ts
//
//   # 2. mint them (real 0G mainnet gas, one ERC-721 mint each):
//   CONFIRM=mint npx tsx src/scripts/arenaMintIdentities.ts
//
// Requires AGENT_IDENTITY=on and the IDENTITY_* wallet funded.

const CONFIRM = process.env.CONFIRM === "mint";

async function main(): Promise<void> {
  const { rows } = await query<{ agent_id: string; name: string }>(
    "select agent_id, name from agents_meta where identity_token_id is null and coalesce(is_house, false) = false order by agent_id asc",
  );

  console.log(`arena identity backfill: ${rows.length} agent(s) without an identity.`);
  for (const r of rows) console.log(`  #${r.agent_id}  ${r.name}`);

  if (!identityConfigured()) {
    console.log(
      "\nIdentity minting is NOT configured. Set AGENT_IDENTITY=on and IDENTITY_PRIVATE_KEY / IDENTITY_RPC_URL " +
        "(and fund that mainnet wallet with 0G) before minting.",
    );
    await closePool();
    process.exit(rows.length === 0 ? 0 : 1);
  }

  if (!CONFIRM) {
    console.log("\nDRY RUN: nothing was minted. Re-run with CONFIRM=mint to apply.");
    await closePool();
    process.exit(0);
  }

  let minted = 0;
  for (const r of rows) {
    const id = Number(r.agent_id);
    const tokenId = await mintArenaIdentity(id); // best effort, self-logs on failure
    if (tokenId !== null) {
      minted++;
      console.log(`  minted #${id} ${r.name} -> agentId ${tokenId}  ${identityExplorerUrl(tokenId)}`);
    } else {
      console.error(`  FAILED #${id} ${r.name} (see the warning above)`);
    }
  }

  console.log(`\nDone. Minted ${minted}/${rows.length} identity(ies).`);
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("arena identity backfill failed:", (e as Error).message);
  process.exit(1);
});
