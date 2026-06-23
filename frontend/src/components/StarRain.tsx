"use client";

import { useMemo } from "react";

const COLORS = ["#6C4CF1", "#FFB13C", "#1FD6A6", "#36C5FF", "#FF6B5C"];

// A burst of colored cartoon stars raining down, in the zerun palette with ink
// outlines. Used for the win celebration. Decorative and non-interactive.
export function StarRain({ count = 44 }: { count?: number }) {
  const stars = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.6,
        dur: 2.6 + Math.random() * 2.4,
        size: 10 + Math.random() * 18,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      })),
    [count],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {stars.map((s, i) => (
        <svg
          key={i}
          width={s.size}
          height={s.size}
          viewBox="0 0 24 24"
          className="absolute -top-10"
          style={{
            left: `${s.left}%`,
            animation: `zr-starfall ${s.dur}s linear ${s.delay}s infinite`,
          }}
        >
          <path
            d="M12 2l2.6 6.3L21 9l-5 4.2L17.5 20 12 16.4 6.5 20 8 13.2 3 9l6.4-.7L12 2z"
            fill={s.color}
            stroke="#171449"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      ))}
      <style>{`@keyframes zr-starfall {
        0% { transform: translateY(-12vh) rotate(0deg); opacity: 0; }
        10% { opacity: 1; }
        100% { transform: translateY(112vh) rotate(420deg); opacity: 0.9; }
      }`}</style>
    </div>
  );
}
