import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// One full inference against one provider, with the TEE verification error PRINTED rather
// than swallowed. `attemptProvider` catches processResponse failures and reports
// `verified: null`, which is correct behaviour for a contest but useless for diagnosis:
// "the answer is not attested" and "attestation threw" look identical from outside.
//
//   PROBE_RPC=https://evmrpc.0g.ai PROBE_PROVIDER=0x... npx tsx src/scripts/teeProbe.ts
//
// Assumes the provider is already acknowledged and funded (compute:check does that).

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc.0g.ai";
  const provider = process.env.PROBE_PROVIDER ?? "0x4415ef5CBb415347bb18493af7cE01f225Fc0868";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");

  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, new ethers.JsonRpcProvider(rpc));
  const broker = await createZGComputeNetworkBroker(wallet);

  const services = (await broker.inference.listService()) as unknown as unknown[][];
  const svc = services.find((s) => String(s[0]).toLowerCase() === provider.toLowerCase());
  console.log(`\nprovider:      ${provider}`);
  console.log(`model:         ${svc ? String(svc[6]) : "(not listed)"}`);
  console.log(`verifiability: ${svc ? String(svc[7]) : "?"}`);
  console.log(`tee signer[9]: ${svc ? String(svc[9]) : "?"}`);

  const { endpoint, model } = await broker.inference.getServiceMetadata(provider);
  const userPrompt = "Compute: 17 + 25";
  const headers = await broker.inference.getRequestHeaders(provider, userPrompt);

  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a precise solver. Answer with only the final result." },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 32,
      temperature: 0.2,
    }),
  });
  const data = (await res.json()) as { id?: string; choices?: { message?: { content?: string } }[] };
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  console.log(`\nhttp:          ${res.status}`);
  console.log(`chatID:        ${data.id ?? "(none)"}`);
  console.log(`answer:        ${text}`);

  if (!data.id) {
    console.log("\nno chatID, so processResponse cannot be called at all.");
    return;
  }

  console.log("\ncalling processResponse (the TEE verification)...");
  try {
    const verified = await broker.inference.processResponse(provider, data.id, text);
    console.log(`  verified: ${verified}`);
  } catch (err) {
    console.log(`  THREW: ${(err as Error).message}`);
    const e = err as { stack?: string };
    if (e.stack) console.log(`\n  ${e.stack.split("\n").slice(0, 4).join("\n  ")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("teeProbe failed:", (e as Error).message);
    process.exit(1);
  });
