"use client";

import { usePathname, useRouter } from "next/navigation";

// A back button that sits at the top-left of the page CONTENT, not in the header nav. Shown on
// every inner page except the landing and the arena (the app's home base). Uses browser history,
// falling back to the arena on a direct load so it is never a dead end.
export function PageBack() {
  const pathname = usePathname();
  const router = useRouter();

  if (pathname === "/" || pathname === "/arena" || pathname.startsWith("/admin")) return null;

  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) router.back();
        else router.push("/arena");
      }}
      aria-label="Go back"
      className="absolute left-5 top-3 z-10 grid h-9 w-9 place-items-center rounded-chunk border-line border-ink bg-cloud text-ink shadow-pop-press transition-[transform,box-shadow] duration-150 ease-spring hover:-translate-y-px hover:shadow-pop active:translate-y-0 active:shadow-pop-press sm:left-8"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
