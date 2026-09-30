// Shared comma-separated list parsing for --policies/--tests style CLI flags,
// used by build-benchmark-matrix.mjs, run-benchmark.mjs and
// validate-checkpoint-configs.mjs so the three scripts can't silently diverge
// in what input they accept for what looks like the same flag.
export function splitCsv(value) {
  return value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
}
