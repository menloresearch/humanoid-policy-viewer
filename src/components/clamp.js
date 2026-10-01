// Canonical clamp(v, lo, hi) — includes a NaN guard so a non-finite input
// (e.g. from a half-typed number field) falls back to `lo` instead of
// propagating NaN through Math.min/Math.max.
export function clamp(v, lo, hi) {
  return Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi);
}
