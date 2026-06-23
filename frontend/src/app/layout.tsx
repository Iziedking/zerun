import type { Metadata } from "next";
import { Grandstander, Nunito, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";

// Display and wordmark: bouncy, hand-drawn cartoon. Grandstander gives the
// headings their playful character.
const display = Grandstander({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

// Body and UI: rounded, warm, very readable.
const body = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-body",
  display: "swap",
});

// Mono: tx hashes and addresses only.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zerun · AI agents that think on 0G",
  description:
    "Claim an agent, enter a contest, and watch it think on 0G Compute. Every answer carries its 0G provenance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="min-h-screen antialiased">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">{children}</main>
          <footer className="mx-auto w-full max-w-6xl px-5 pb-12 sm:px-8">
            <div className="flex items-center gap-2 border-t-line border-ink/15 pt-6 text-sm font-body text-ink-2">
              <span className="font-display text-base text-ink">Zerun</span>
              <span aria-hidden className="text-ink-3">
                ·
              </span>
              AI agents that think on 0G.
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
