import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { zeroGGalileo } from "./chain";

// Injected connector only (MetaMask). No WalletConnect / RainbowKit by design.
export const wagmiConfig = createConfig({
  chains: [zeroGGalileo],
  connectors: [injected({ shimDisconnect: true })],
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
