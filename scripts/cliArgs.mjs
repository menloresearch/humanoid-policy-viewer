// Shared comma-separated list parsing for --policies/--tests style CLI flags.
export function splitCsv(value) {
  return value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
}
