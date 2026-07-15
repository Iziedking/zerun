import { query, closePool } from "../db/pool.js";
import { identityConfigured, registerIdentity, chessAgentCardUri, identityExplorerUrl } from "../identity/erc8004.js";

// Backfill ERC-8004 identities for uploaded chess agents that do not have one yet.
//
// Minting at submit time is best effort, so an agent uploaded while the feature was off, the wallet
// was unfunded, or the RPC hiccuped will have identity_token_id = null. This mints those in one pass,
// on 0G mainnet, from IDENTITY_PRIVATE_KEY. Safe by default: a dry run that changes nothing until you
// pass CONFIRM=mint.
//
//   # 1. see which agents are missing an identity (changes nothing):
//   npx tsx src/scripts/chessMintIdentities.ts
//
//   # 2. mint them (real 0G mainnet gas, one ERC-721 mint each):
//   CONFIRM=mint npx tsx src/scripts/chessMintIdentities.ts
//
// Requires CHESS_IDENTITY=on and IDENTITY_PRIVATE_KEY / IDENTITY_RPC_URL / IDENTITY_REGISTRY_ADDRESS.

const CONFIRM = process.env.CONFIRM === "mint";

async function main(): Promise<void> {
  const { rows } = await query<{ id: string; name: string }>(
    "select id, name from chess_agents where kind = 'upload' and identity_token_id is null order by id asc",
  );

  console.log(`ERC-8004 identity backfill: ${rows.length} uploaded agent(s) without an identity.`);
  for (const r of rows) console.log(`  #${r.id}  ${r.name}`);

  if (!identityConfigured()) {
    console.log(
      "\nIdentity minting is NOT configured. Set CHESS_IDENTITY=on and IDENTITY_PRIVATE_KEY / IDENTITY_RPC_URL " +
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
    const id = Number(r.id);
    try {
      const { tokenId, txHash } = await registerIdentity(chessAgentCardUri(id));
      await query("update chess_agents set identity_token_id = $2, identity_tx = $3 where id = $1", [id, tokenId, txHash]);
      minted++;
      console.log(`  minted #${id} ${r.name} -> agentId ${tokenId}  ${identityExplorerUrl(tokenId)}`);
    } catch (err) {
      console.error(`  FAILED #${id} ${r.name}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Minted ${minted}/${rows.length} identity(ies).`);
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("identity backfill failed:", (e as Error).message);
  process.exit(1);
});
