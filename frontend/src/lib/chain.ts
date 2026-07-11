import { defineChain } from "viem";

export const zeroGGalileo = defineChain({
  id: 16602,
  name: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://evmrpc-testnet.0g.ai"] },
  },
  blockExplorers: {
    default: { name: "Chainscan", url: "https://chainscan-galileo.0g.ai" },
  },
  testnet: true,
});

export const FAUCET_URL = "https://faucet.0g.ai";

// 0G Galileo expects legacy (pre-EIP-1559) transactions. A wallet's default EIP-1559
// transaction carries a priority-fee (tip) that can fall below the node's minimum and
// get rejected ("gas tip cap below minimum") — the same reason deploys need --legacy.
// That rejection is intermittent (it depends on the wallet's fee estimate at the
// moment), which is exactly why some user transactions fail at random while others go
// through. Forcing the legacy type makes the wallet price the tx with eth_gasPrice,
// which the node accepts. Spread this into every user wallet write/send.
export const LEGACY_TX = { type: "legacy" } as const;

// Raw params used for wallet_addEthereumChain when the wallet does not know 16602.
export const addChainParams = {
  chainId: "0x40da", // 16602
  chainName: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: ["https://evmrpc-testnet.0g.ai"],
  blockExplorerUrls: ["https://chainscan-galileo.0g.ai"],
} as const;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/**
 * Put the wallet on 0G, adding the network first if it does not have it. Many mobile wallets will
 * not switch to a chain they do not already know and simply reject a bare wallet_switchEthereumChain,
 * which is where onboarding stalls. So we add first (with full params) and then switch. Adding a
 * chain that already exists is a no-op in well-behaved wallets; a user rejection (4001) stops us.
 */
export async function addAndSwitchZeroG(provider: Eip1193): Promise<void> {
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams] });
  } catch (err) {
    if ((err as { code?: number })?.code === 4001) throw err; // user said no
    // otherwise the wallet likely already has it; fall through to the switch
  }
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: addChainParams.chainId }],
  });
}
