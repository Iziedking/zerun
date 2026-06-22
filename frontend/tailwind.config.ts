import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Control-room palette: deep ink base, one confident signal accent.
        ink: {
          900: "#070a0c",
          800: "#0b1013",
          700: "#10171b",
          600: "#161f24",
          500: "#1d282e",
          400: "#27343b",
        },
        edge: "#2a3a42",
        haze: "#5d6e76",
        chalk: "#c8d3d8",
        bone: "#eef3f4",
        // The signal: a precise electric teal that reads as "0G live".
        signal: {
          DEFAULT: "#23e6c4",
          dim: "#16a892",
          glow: "#5cf3da",
        },
        amber: {
          DEFAULT: "#f0a93b",
          dim: "#b97c1e",
        },
        ember: "#ff5d57",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: {
        wordmark: "0.32em",
      },
      keyframes: {
        "feed-in": {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "flare": {
          "0%": { boxShadow: "0 0 0 0 rgba(35,230,196,0.35)" },
          "100%": { boxShadow: "0 0 0 14px rgba(35,230,196,0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        "sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "rise": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "feed-in": "feed-in 0.45s cubic-bezier(0.16,1,0.3,1)",
        "flare": "flare 0.9s ease-out",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        "sweep": "sweep 2.2s linear infinite",
        "rise": "rise 0.6s cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
