import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { http } from "wagmi";
import { zeroGGalileo, zeroGMainnet } from "./chain";

// RainbowKit drives the connect modal. WalletConnect (and the mobile wallets that ride
// on it, like Rainbow/Base) need a real project id from cloud.reown.com — a 32-char hex
// string — set as NEXT_PUBLIC_WALLETCONNECT_ID. WITHOUT a valid one, selecting any of
// those options throws a client-side exception the moment it is picked and white-screens
// the whole app. So we only offer WalletConnect when a real id is present; otherwise the
// modal shows injected / browser-extension wallets only (MetaMask, Rabby, Phantom, etc.,
// discovered via EIP-6963), which never touch WalletConnect, and the app stays up. Set
// NEXT_PUBLIC_WALLETCONNECT_ID to a real project id to enable WalletConnect and mobile.
const rawId = (process.env.NEXT_PUBLIC_WALLETCONNECT_ID ?? "").trim();
const hasWalletConnect = /^[0-9a-fA-F]{32}$/.test(rawId);

export const wagmiConfig = getDefaultConfig({
  appName: "Zerun",
  // getDefaultConfig requires a projectId; when WalletConnect is disabled below it is
  // never used, so a dummy keeps the types happy without initializing WalletConnect.
  projectId: hasWalletConnect ? rawId : "00000000000000000000000000000000",
  // Both networks are supported: the arena runs on the testnet, the Zero Cup vote on the mainnet.
  // Declaring mainnet here is what lets a wallet like OKX connect on it without adding the testnet.
  chains: [zeroGGalileo, zeroGMainnet],
  transports: {
    [zeroGGalileo.id]: http(zeroGGalileo.rpcUrls.default.http[0]),
    [zeroGMainnet.id]: http(zeroGMainnet.rpcUrls.default.http[0]),
  },
  ssr: true,
  // With a real id, keep RainbowKit's full default wallet list (includes WalletConnect).
  // Without one, restrict to the injected wallet so no WalletConnect-based option is even
  // offered; EIP-6963 still surfaces every installed browser extension.
  ...(hasWalletConnect
    ? {}
    : { wallets: [{ groupName: "Installed", wallets: [injectedWallet] }] }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
