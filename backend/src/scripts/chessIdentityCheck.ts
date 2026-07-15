import { identityStatus } from "../identity/erc8004.js";

// Read-only preflight for ERC-8004 agent identity. Spends nothing: it connects to the configured 0G
// mainnet RPC, confirms the canonical IdentityRegistry resolves (reads totalAgents), and reports the
// minting wallet's gas balance. Run this before turning AGENT_IDENTITY=on for a launch.
//
//   npx tsx src/scripts/chessIdentityCheck.ts

async function main(): Promise<void> {
  const s = await identityStatus();
  console.log("ERC-8004 identity preflight");
  console.log(`  feature flag (AGENT_IDENTITY): ${s.enabled ? "on" : "off"}`);
  console.log(`  fully configured:              ${s.configured ? "yes" : "no"}`);
  console.log(`  registry:                      ${s.registry}`);
  console.log(`  configured chainId:            ${s.configuredChainId}`);
  console.log(`  connected chainId:             ${s.connectedChainId ?? "-"}`);
  console.log(`  minting wallet:                ${s.signer ?? "-"}`);
  console.log(`  wallet balance (0G, for gas):  ${s.balanceOg ?? "-"}`);
  console.log(`  registry name (resolve check): ${s.registryName ?? "-"}`);

  if (s.error) {
    console.error(`\nNOT READY: ${s.error}`);
    process.exit(1);
  }
  const warnings: string[] = [];
  if (s.connectedChainId !== null && s.connectedChainId !== s.configuredChainId) {
    warnings.push(
      `connected chainId ${s.connectedChainId} != configured ${s.configuredChainId} (is IDENTITY_RPC_URL a 0G mainnet RPC?)`,
    );
  }
  if (s.balanceOg !== null && Number(s.balanceOg) <= 0) {
    warnings.push("the minting wallet holds 0 0G, so mints will fail; fund IDENTITY_PRIVATE_KEY with mainnet 0G");
  }
  if (!s.enabled) warnings.push("AGENT_IDENTITY is off, so submissions will not mint yet; set it to 'on' to go live");

  if (warnings.length) {
    console.log("\nWARNINGS:");
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log("\nReady: the registry resolves and the wallet is funded. Identities will mint on submit.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("identity preflight failed:", (e as Error).message);
  process.exit(1);
});
