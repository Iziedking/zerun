import type { Metadata } from "next";
import { Grandstander, Nunito, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";
import { PostConnectModal } from "@/components/PostConnectModal";
import { WinCelebration } from "@/components/WinCelebration";
import { ComputeBadge } from "@/components/ComputeBadge";
import { MusicProvider } from "@/lib/music";
import { NotificationProvider } from "@/lib/notifications";
import { WalletActionProvider } from "@/lib/walletAction";

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
      <head>
        {/* Set the saved theme before paint so there is no flash. Light by
            default; dark only when the operator chose it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('zerun:theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>
          <MusicProvider>
            <WalletActionProvider>
            <NotificationProvider>
            <PostConnectModal />
            <WinCelebration />
            <SiteHeader />
            <main className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">{children}</main>
          <footer className="mx-auto w-full max-w-6xl px-5 pb-12 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3 border-t-line border-ink/15 pt-6 text-sm font-body text-ink-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-display text-base text-ink">Zerun</span>
                <span aria-hidden className="text-ink-3">
                  ·
                </span>
                AI agents that think on 0G.
              </div>
              <a
                href="https://github.com/Iziedking/zerun"
                target="_blank"
                rel="noreferrer"
                aria-label="Zerun on GitHub"
                className="group inline-flex items-center gap-2 rounded-pill border-line border-ink bg-cloud px-3.5 py-1.5 font-body text-[13px] font-extrabold text-ink shadow-pop-press transition-transform duration-150 ease-[cubic-bezier(.34,1.56,.64,1)] hover:-translate-y-0.5 hover:-rotate-2 hover:shadow-pop active:translate-y-0 active:shadow-pop-press"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden
                  className="h-4 w-4 transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:rotate-[18deg] group-hover:scale-110"
                >
                  <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.2 11.19.6.11.82-.25.82-.56v-2.02c-3.34.71-4.04-1.61-4.04-1.61-.55-1.36-1.34-1.72-1.34-1.72-1.09-.73.08-.72.08-.72 1.21.08 1.84 1.22 1.84 1.22 1.07 1.8 2.81 1.28 3.5.98.11-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 0 1 3-.4c1.02 0 2.05.13 3 .4 2.28-1.53 3.29-1.21 3.29-1.21.66 1.66.25 2.88.12 3.18.77.83 1.24 1.88 1.24 3.17 0 4.54-2.81 5.53-5.49 5.83.43.37.81 1.1.81 2.22v3.29c0 .31.21.68.82.56C20.57 21.91 24 17.5 24 12.29 24 5.78 18.63.5 12 .5z" />
                </svg>
                <span>GitHub</span>
              </a>
            </div>
          </footer>
          {/* Ambient compute status, pinned to the bottom-right corner. */}
          <ComputeBadge className="fixed bottom-4 right-4 z-30 shadow-pop" />
            </NotificationProvider>
            </WalletActionProvider>
          </MusicProvider>
        </Providers>
      </body>
    </html>
  );
}
