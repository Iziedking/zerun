export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787"
).replace(/\/$/, "");

// Derive the WebSocket base from the HTTP base: http->ws, https->wss, path "/ws".
export function wsUrl(): string {
  const base = API_URL.replace(/^http/, "ws");
  return `${base}/ws`;
}
