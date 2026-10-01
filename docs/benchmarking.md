# Benchmarking

The in-app **Tests & Benchmark** panel (`src/views/Demo.vue`) runs the
`benchmark/*.json` velocity-command tests against one or more policies and
reports metrics via `src/simulation/benchmarkRunner.js`. What the tests are and
how their thresholds were chosen is in
[`benchmark/METHODOLOGY.md`](../benchmark/METHODOLOGY.md); run-to-run noise is in
[`benchmark/VARIANCE_ANALYSIS.md`](../benchmark/VARIANCE_ANALYSIS.md).

## Headless runs

To run the same sweep outside a browser tab:

```bash
# Every discovered checkpoint x every committed benchmark/*.json test
npm run benchmark -- --out benchmark_runs/run.json

# One policy, one test (fast smoke check)
npm run benchmark -- \
  --policies "ckpt:<root>/<model>/policy.onnx" \
  --tests backward_walk.json \
  --out benchmark_runs/run.json
```

"Discovered" means the checkpoints under the [model library](model-library.md);
`--policies` skips discovery.

This boots a Vite dev server (the `/api/models`, `/api/sequences`, and
`/api/benchmarks` endpoints only exist under `vite dev`, not `vite build` +
`preview`), drives it with headless Chromium via Playwright, and calls the
same `window.__runHeadlessBenchmark(...)` hook the confirm-dialog-driven UI
flow uses (`Demo.vue`'s `runHeadlessBenchmark()` method). See
`scripts/run-benchmark.mjs`.

## Parallelism

A single page can only host one live `MuJoCoDemo` (one canvas, one MuJoCo
WASM instance, one ONNX Runtime session), so policies are benchmarked
sequentially within a run. Parallelism comes from running multiple shards,
each its own OS process with its own dev server + browser; `--policies` and
`--tests` make it straightforward to partition a sweep across shards.

Sharding, merging shard outputs into one report, PR comments and deployment
belong to whatever repo embeds the viewer.

## Saved runs

Runs are written to `benchmark_runs/` (or `HPV_BENCHMARK_RUNS_DIR`, see
[Model library](model-library.md)) and listed at `/api/benchmarks`. Test
definitions live in `benchmark/` and are edited in the trajectory editor
(`/api/sequences`); `benchmark/` is gitignored, so keeping a test in git needs an
intentional `git add -f`.
