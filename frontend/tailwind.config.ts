import type { Config } from "tailwindcss";

// Zerun cosmic-candy theme. Bright sticker surfaces, deep-indigo ink outlines and
// hard offset (pop) shadows, candy accents with cosmic violet as the brand.
const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sky: { DEFAULT: "rgb(var(--sky) / <alpha-value>)", 2: "rgb(var(--sky-2) / <alpha-value>)" },
        cloud: { DEFAULT: "rgb(var(--cloud) / <alpha-value>)", 2: "rgb(var(--cloud-2) / <alpha-value>)" },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          2: "rgb(var(--ink-2) / <alpha-value>)",
          3: "rgb(var(--ink-3) / <alpha-value>)",
        },
        violet: {
          DEFAULT: "rgb(var(--violet) / <alpha-value>)",
          deep: "rgb(var(--violet-deep) / <alpha-value>)",
        },
        amber: { DEFAULT: "rgb(var(--amber) / <alpha-value>)" },
        mint: { DEFAULT: "rgb(var(--mint) / <alpha-value>)" },
        cyan: { DEFAULT: "rgb(var(--cyan) / <alpha-value>)" },
        coral: { DEFAULT: "rgb(var(--coral) / <alpha-value>)" },
        candyink: "rgb(var(--candy-ink) / <alpha-value>)",
        scrim: "rgb(var(--scrim) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderWidth: {
        line: "3px",
      },
      borderRadius: {
        chunk: "18px",
        "chunk-lg": "28px",
        pill: "999px",
      },
      boxShadow: {
        pop: "4px 4px 0 rgb(var(--pop-shadow))",
        "pop-lg": "6px 6px 0 rgb(var(--pop-shadow))",
        "pop-press": "1px 1px 0 rgb(var(--pop-shadow))",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.34,1.56,0.64,1)",
      },
      keyframes: {
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "60%": { opacity: "1", transform: "scale(1.02)" },
          "100%": { transform: "scale(1)" },
        },
        "drop-in": {
          "0%": { opacity: "0", transform: "translateY(-14px) scale(0.98)" },
          "70%": { opacity: "1", transform: "translateY(2px) scale(1.01)" },
          "100%": { transform: "translateY(0) scale(1)" },
        },
        bob: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        hop: {
          "0%, 100%": { transform: "translateY(0)" },
          "30%": { transform: "translateY(-12px)" },
          "55%": { transform: "translateY(0)" },
          "70%": { transform: "translateY(-5px)" },
        },
        wiggle: {
          "0%, 100%": { transform: "rotate(0deg)" },
          "25%": { transform: "rotate(-5deg)" },
          "75%": { transform: "rotate(5deg)" },
        },
      },
      animation: {
        "pop-in": "pop-in 0.30s cubic-bezier(0.34,1.56,0.64,1) both",
        "drop-in": "drop-in 0.36s cubic-bezier(0.34,1.56,0.64,1) both",
        bob: "bob 3s ease-in-out infinite",
        hop: "hop 0.9s cubic-bezier(0.34,1.56,0.64,1)",
        wiggle: "wiggle 0.4s ease-in-out",
      },
    },
  },
  plugins: [],
};

export default config;
