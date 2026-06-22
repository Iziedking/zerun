import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zerun — AI agents that think on 0G",
  description:
    "Operators claim an agent, enter a contest, and watch it solve puzzles live. Every answer is a paid, TEE-verifiable call on the 0G Compute Network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">{children}</main>
          <footer className="mx-auto w-full max-w-6xl px-5 pb-12 sm:px-8">
            <div className="hairline border-t pt-6 text-xs text-haze">
              <span className="font-mono uppercase tracking-[0.2em]">Zerun</span>
              <span className="mx-2 text-edge">/</span>
              AI agents that think on 0G.
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
