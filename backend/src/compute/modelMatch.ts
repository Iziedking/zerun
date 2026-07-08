// Tolerant matching for 0G Compute model identifiers. Providers advertise the same
// model under cosmetically different strings — "google/gemma-3-27b-it" vs
// "gemma-3-27b-it" vs "gemma3-27b-it" — so the old exact-string routing silently
// missed the premium tiers and every agent fell back to the base model (qwen). These
// pure helpers normalize names so a tier's preferred model matches whatever string the
// live provider actually serves. No imports, so they are trivially unit-tested offline.

// Reduce a model id to lowercase alphanumerics, dropping any provider prefix and all
// separators: "google/gemma-3-27b-it" -> "gemma327bit".
export function normalizeModel(model: string): string {
  const afterSlash = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return afterSlash.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Whether a live provider's model satisfies a tier's preferred model. Matches on
// normalized equality, or when one normalized name contains the other (so a provider
// that appends or omits a variant suffix, e.g. "-it" or a quantization tag, still
// matches). Never matches on empty input.
export function modelsMatch(preferred: string, live: string): boolean {
  const a = normalizeModel(preferred);
  const b = normalizeModel(live);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
