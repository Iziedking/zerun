import { addChainParams, zeroGGalileo } from "./chain";

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

// Ensure the injected wallet is on 0G Galileo (16602). Try switch first, then add.
export async function ensureGalileo(provider: EthProvider): Promise<void> {
  const hexId = `0x${zeroGGalileo.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    // 4902 = chain not added to the wallet yet.
    if (code === 4902 || code === -32603) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [addChainParams],
      });
    } else {
      throw err;
    }
  }
}
