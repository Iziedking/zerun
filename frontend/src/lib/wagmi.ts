import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { zeroGGalileo } from "./chain";

// Injected connector only (MetaMask). No WalletConnect / RainbowKit by design.
// No shimDisconnect: it makes a manual disconnect block the next connect until a
// refresh. Without it, exit clears the session and a fresh connect works at once.
export const wagmiConfig = createConfig({
  chains: [zeroGGalileo],
  connectors: [injected()],
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
