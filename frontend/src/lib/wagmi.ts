import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { zeroGGalileo } from "./chain";

// RainbowKit drives the connect modal (injected wallets plus WalletConnect for
// mobile). 0G Galileo is the only chain, so RainbowKit defaults to it and
// prompts the wallet to add and switch on connect. WalletConnect needs a free
// project id from cloud.reown.com, set as NEXT_PUBLIC_WALLETCONNECT_ID; injected
// wallets (MetaMask, Rabby) work without it.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID || "zerun_dev_walletconnect_id";

export const wagmiConfig = getDefaultConfig({
  appName: "Zerun",
  projectId,
  chains: [zeroGGalileo],
  transports: {
    [zeroGGalileo.id]: http(zeroGGalileo.rpcUrls.default.http[0]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
