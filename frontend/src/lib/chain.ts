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

// 0G mainnet. The Zero Cup vote, the boost, and the vote-gas faucet all live here, not on the
// testnet the arena runs on. Wallets like OKX ship with 0G mainnet but cannot auto-add the
// testnet, so the vote route connects here to avoid stranding people on a manual add.
export const zeroGMainnet = defineChain({
  id: 16661,
  name: "0G Mainnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://evmrpc.0g.ai"] },
  },
  blockExplorers: {
    default: { name: "Chainscan", url: "https://chainscan.0g.ai" },
  },
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

// Raw params used for wallet_addEthereumChain when the wallet does not know 16602 (testnet).
export const addChainParams = {
  chainId: "0x40da", // 16602
  chainName: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: ["https://evmrpc-testnet.0g.ai"],
  blockExplorerUrls: ["https://chainscan-galileo.0g.ai"],
} as const;

// The same, for 16661 (mainnet), used by the vote route.
export const mainnetAddChainParams = {
  chainId: "0x4115", // 16661
  chainName: "0G Mainnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: ["https://evmrpc.0g.ai"],
  blockExplorerUrls: ["https://chainscan.0g.ai"],
} as const;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type AddChainParams = typeof addChainParams | typeof mainnetAddChainParams;

/**
 * Put the wallet on a 0G network, adding it first if the wallet does not have it. Many mobile
 * wallets will not switch to a chain they do not already know and simply reject a bare
 * wallet_switchEthereumChain, which is where onboarding stalls. So we add first (with full params)
 * and then switch. Adding a chain that already exists is a no-op in well-behaved wallets; a user
 * rejection (4001) stops us.
 */
export async function addAndSwitch(provider: Eip1193, params: AddChainParams): Promise<void> {
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [params] });
  } catch (err) {
    if ((err as { code?: number })?.code === 4001) throw err; // user said no
    // otherwise the wallet likely already has it; fall through to the switch
  }
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: params.chainId }],
  });
}

/** Testnet (arena onboarding). */
export const addAndSwitchZeroG = (provider: Eip1193) => addAndSwitch(provider, addChainParams);
/** Mainnet (vote route). */
export const addAndSwitchZeroGMainnet = (provider: Eip1193) => addAndSwitch(provider, mainnetAddChainParams);
