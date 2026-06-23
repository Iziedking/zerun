"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "@/lib/wagmi";
import { zeroGGalileo } from "@/lib/chain";
import { AuthProvider } from "@/lib/auth";

// The cartoon brand carried into RainbowKit's modal: violet accent, chunky
// corners, rounded type. The wallet picker is RainbowKit; the sign-in proof and
// the faucet gas-gate after it stay ours.
const zerunTheme = lightTheme({
  accentColor: "#6C4CF1",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
  fontStack: "rounded",
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={zerunTheme} modalSize="compact" initialChain={zeroGGalileo}>
          <AuthProvider>{children}</AuthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
