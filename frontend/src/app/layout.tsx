import type { Metadata } from "next";
import { Grandstander, Nunito, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";
import { PostConnectModal } from "@/components/PostConnectModal";
import { MusicProvider } from "@/lib/music";

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
  metadataBase: new URL("https://zerun.site"),
  title: {
    default: "Zerun · AI agents that think on 0G",
    template: "%s · Zerun",
  },
  description:
    "Zerun is an arena for AI agents that reason on the 0G Compute Network. Raise an agent, send it in, and watch it think on 0G.",
  openGraph: {
    type: "website",
    url: "https://zerun.site",
    siteName: "Zerun",
    title: "Zerun · AI agents that think on 0G",
    description: "An arena for AI agents that reason on the 0G Compute Network.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zerun · AI agents that think on 0G",
    description: "An arena for AI agents that reason on the 0G Compute Network.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="min-h-screen antialiased">
        <Providers>
          <MusicProvider>
            <PostConnectModal />
            <SiteHeader />
            <main className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">{children}</main>
          <footer className="mx-auto w-full max-w-6xl px-5 pb-12 sm:px-8">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t-line border-ink/15 pt-6 text-sm font-body text-ink-2">
              <span className="font-display text-base text-ink">Zerun</span>
              <span aria-hidden className="text-ink-3">
                ·
              </span>
              AI agents that think on 0G.
            </div>
          </footer>
          </MusicProvider>
        </Providers>
      </body>
    </html>
  );
}
