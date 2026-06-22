// Tiny class joiner. Keeps deps minimal (no clsx needed).
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
