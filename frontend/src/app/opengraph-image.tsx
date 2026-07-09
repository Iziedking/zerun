import { ImageResponse } from "next/og";

// Render on the edge runtime so @vercel/og resolves its assets at request time
// rather than during the static prerender (which fails on Node file URLs).
export const runtime = "edge";

// The link preview card for zerun.site. Next serves this as the Open Graph and
// Twitter image automatically.
export const alt = "Zerun, AI agents that think on 0G";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// 0G's mark, inlined. 62x30 keeps its native 378:183 ratio.
const ZERO_G_MARK = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzc4IiBoZWlnaHQ9IjE4MyIgdmlld0JveD0iMCAwIDM3OCAxODMiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0yMC42NzkyIDE0OS40MTNDLTguODEyMjcgMTEzLjQ3IC02Ljc1ODE4IDYwLjM1MDYgMjYuODMzMiAyNi43OTY2QzYyLjYxODkgLTguOTMyMjEgMTIwLjYyOCAtOC45MzIyMSAxNTYuNDE0IDI2Ljc5NjZDMTkyLjE5MiA2Mi41MzM3IDE5Mi4xOTIgMTIwLjQ2NCAxNTYuNDE0IDE1Ni4yMDFDMTIxLjcxNyAxOTAuODUxIDY2LjExNjYgMTkxLjg5NyAzMC4xNTc3IDE1OS4zNTdMMTExLjA1OSA3OC41NTY5TDEyMC43NzcgODguMjYxNEw3MS4zNzk3IDEzNy42Qzg5LjgzMzUgMTQ1LjY4MSAxMTIuMTQ4IDE0Mi4xNzIgMTI3LjI1MyAxMjcuMDg4QzE0Ni45MzYgMTA3LjQzMiAxNDYuOTM2IDc1LjU2NjQgMTI3LjI1MyA1NS45MTg1QzEwNy41NzggMzYuMjYyMiA3NS42Njk0IDM2LjI2MjIgNTUuOTg2NCA1NS45MTg1QzM4LjUyMjUgNzMuMzU4NiAzNi41NTkyIDEwMC40MjEgNTAuMDk2NCAxMjAuMDI4TDIwLjY3OTIgMTQ5LjQxM1oiIGZpbGw9IiNCNzVGRkYiLz4KPHBhdGggZD0iTTI2My45MiAxMDkuNzA0Vjk2LjAyMDdIMzc4QzM3NS42ODIgMTQyLjk4NiAzMzcuODA5IDE4MC42MSAyOTAuNjk3IDE4Mi42MDRDMjM2Ljc3MSAxODQuODk0IDE5Mi40MzkgMTM5LjkxNCAxOTUuNTU3IDg2LjEwMkMxOTguMzI5IDM4LjIxMzYgMjM5LjM3OCAwLjIyNzU1NSAyODYuNzU0IDAuMjI3NTU1QzMzNC4xMyAwLjIyNzU1NSAzNzMuMDc1IDM2LjIzNjUgMzc3LjY2MiA4Mi4zMzcxSDMzNi4xNjhDMzMxLjg3OCA1OC45ODIgMzExLjM4NiA0MS4yODY1IDI4Ni43NTQgNDEuMjg2NUMyNTUuNzI4IDQxLjI4NjUgMjMxLjI2OSA2OS4zNzAzIDIzNy40ODEgMTAxLjQ4M0MyNDEuMzI1IDEyMS4zMjggMjU2Ljk3NCAxMzYuOTA3IDI3Ni44NjMgMTQwLjY5NkMzMDIuMjc5IDE0NS41MzIgMzI1LjE1NSAxMzEuMjMxIDMzMy41NzcgMTA5LjcwNEgyNjMuOTJaIiBmaWxsPSIjQjc1RkZGIi8+Cjwvc3ZnPgo=";

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

        {/* Built on 0G, as a sticker pill, carrying 0G's own mark.
            The SVG is inlined as a base64 data URI, not fetched: satori resolves images at
            request time on the edge, and a remote asset that is slow or missing yields a broken
            link preview. Inlined, the card can never render without it. */}
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ZERO_G_MARK} alt="" width={62} height={30} />
          <div style={{ fontSize: 30, fontWeight: 800, color: "#171449", letterSpacing: 1 }}>BUILT ON 0G</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
