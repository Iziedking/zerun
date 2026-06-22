// Decorative cosmic confetti for hero and win states. Purely decorative, so it is
// aria-hidden and disabled under reduced motion (the loop simply does not run).
const PIECES = [
  { x: "8%", y: "18%", c: "#6C4CF1", d: "0ms", s: 10 },
  { x: "22%", y: "62%", c: "#36C5FF", d: "200ms", s: 7 },
  { x: "40%", y: "10%", c: "#FFB13C", d: "120ms", s: 8 },
  { x: "63%", y: "28%", c: "#1FD6A6", d: "320ms", s: 9 },
  { x: "78%", y: "70%", c: "#FF6B5C", d: "80ms", s: 7 },
  { x: "90%", y: "20%", c: "#6C4CF1", d: "260ms", s: 8 },
  { x: "52%", y: "78%", c: "#36C5FF", d: "160ms", s: 6 },
  { x: "33%", y: "40%", c: "#FFB13C", d: "360ms", s: 6 },
];

export function Confetti({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {PIECES.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-[3px]"
          style={{
            left: p.x,
            top: p.y,
            width: p.s,
            height: p.s,
            background: p.c,
            border: "2px solid #171449",
            animation: "zr-confetti 2.6s ease-in-out infinite alternate",
            animationDelay: p.d,
          }}
        />
      ))}
    </div>
  );
}
