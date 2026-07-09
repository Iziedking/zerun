import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// Why does processResponse throw "getting signature error"?
//
// The SDK verifies an answer by GET {url}/v1/proxy/signature/{chatID}?model={model} and
// throws that message on ANY non-ok response, discarding the status and the body. So the
// interesting information — 404 vs 401 vs 500, and whether the signature simply is not ready
// yet — never reaches us. This calls the endpoint directly and prints what it says, then
// polls, in case the provider signs asynchronously after the completion returns.
//
//   PROBE_RPC=https://evmrpc.0g.ai PROBE_PROVIDER=0x... npx tsx src/scripts/teeSignatureProbe.ts

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function show(label: string, url: string) {
  try {
    const res = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
    const body = await res.text();
    console.log(`  ${label}\n    -> ${res.status} ${res.statusText}  ${body.slice(0, 180).replace(/\s+/g, " ")}`);
    return res.ok;
  } catch (err) {
    console.log(`  ${label}\n    -> FETCH FAILED: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc.0g.ai";
  const provider = process.env.PROBE_PROVIDER ?? "0x4415ef5CBb415347bb18493af7cE01f225Fc0868";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");

  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, new ethers.JsonRpcProvider(rpc));
  const broker = await createZGComputeNetworkBroker(wallet);

  const services = (await broker.inference.listService()) as unknown as unknown[][];
  const svc = services.find((s) => String(s[0]).toLowerCase() === provider.toLowerCase());
  if (!svc) throw new Error("provider not listed");

  const baseUrl = String(svc[2]); // the provider broker URL from the service struct
  const { endpoint, model } = await broker.inference.getServiceMetadata(provider);

  console.log(`\nprovider:  ${provider}`);
  console.log(`model:     ${model}`);
  console.log(`url [2]:   ${baseUrl}`);
  console.log(`endpoint:  ${endpoint}`);

  // The attestation report the SDK fetches first, to learn the provider's signing address.
  console.log(`\n1. attestation report (the SDK needs this to know who signs):`);
  await show(
    `GET ${baseUrl}/v1/proxy/attestation/report?model=${model}`,
    `${baseUrl}/v1/proxy/attestation/report?model=${encodeURIComponent(model)}`,
  );

  // One real inference, so we have a chatID to ask about.
  const userPrompt = "Compute: 17 + 25";
  const headers = await broker.inference.getRequestHeaders(provider, userPrompt);
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: 16,
      temperature: 0.2,
    }),
  });
  const data = (await res.json()) as { id?: string };
  const chatID = data.id;
  console.log(`\n2. inference -> http ${res.status}, chatID ${chatID ?? "(none)"}`);
  if (!chatID) return;

  // Poll the signature endpoint. If the provider signs asynchronously, an immediate call
  // fails and a later one succeeds — and the whole "TEE verification is broken" conclusion
  // would instead be "we ask too early".
  console.log(`\n3. signature endpoint, polled:`);
  const url = `${baseUrl}/v1/proxy/signature/${chatID}?model=${encodeURIComponent(model)}`;
  for (const waitMs of [0, 2000, 5000, 10000]) {
    if (waitMs) await sleep(waitMs);
    const ok = await show(`after ${waitMs}ms`, url);
    if (ok) {
      console.log(`\n  -> the signature DOES appear, after ~${waitMs}ms. processResponse asks too early.`);
      return;
    }
  }
  console.log(`\n  -> the signature never appears. This provider does not serve per-response attestations.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("teeSignatureProbe failed:", (e as Error).message);
    process.exit(1);
  });
