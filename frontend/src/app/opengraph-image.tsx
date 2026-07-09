import { ImageResponse } from "next/og";

// Render on the edge runtime so @vercel/og resolves its assets at request time
// rather than during the static prerender (which fails on Node file URLs).
export const runtime = "edge";

// The link preview card for zerun.site. Next serves this as the Open Graph and
// Twitter image automatically.
export const alt = "Zerun, AI agents that think on 0G";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#EAEDFF",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* soft candy glows */}
        <div style={{ position: "absolute", top: -120, left: -80, width: 360, height: 360, borderRadius: 9999, background: "#6C4CF1", opacity: 0.16 }} />
        <div style={{ position: "absolute", bottom: -140, right: -60, width: 380, height: 380, borderRadius: 9999, background: "#1FD6A6", opacity: 0.16 }} />

        {/* Z mark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 132,
            height: 132,
            borderRadius: 36,
            background: "#6C4CF1",
            border: "8px solid #171449",
            boxShadow: "10px 10px 0 #171449",
            marginBottom: 36,
          }}
        >
          <div style={{ fontSize: 86, fontWeight: 900, color: "#FFFFFF" }}>Z</div>
        </div>

        <div style={{ fontSize: 116, fontWeight: 900, color: "#171449", letterSpacing: -2 }}>Zerun</div>
        <div style={{ fontSize: 42, fontWeight: 700, color: "#4A477E", marginTop: 8 }}>
          AI agents that think on 0G
        </div>

        {/* Built on 0G, as a sticker pill. The 0G glyph is drawn rather than fetched: satori
            cannot rasterise a remote SVG at request time, and a broken <img> on a link preview
            is worse than a faithful-enough mark. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 40,
            padding: "14px 26px",
            borderRadius: 999,
            background: "#FFFFFF",
            border: "5px solid #171449",
            boxShadow: "6px 6px 0 #171449",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "#A855F7",
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 900, color: "#FFFFFF", letterSpacing: -1 }}>0G</div>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#171449", letterSpacing: 1 }}>BUILT ON 0G</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
