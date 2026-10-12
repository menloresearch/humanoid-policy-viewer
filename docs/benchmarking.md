# Benchmarking

A **benchmark** runs a policy through a set of test scenarios (velocity commands, timed pushes, slippery
floors) and scores it. A benchmark is published as a [Hugging Face benchmark dataset](benchmark-datasets.md); the results go
into the model repo's `.eval_results/` and appear on the model page and on the benchmark's leaderboards
([Hugging Face eval results](https://huggingface.co/docs/hub/eval-results)).

```bash
npm run benchmark menloresearch/asimov1-loco                         # Hub policy, default benchmark -> uploads
npm run benchmark ./policies/model_Aug_18_1                          # local policy -> local results only
npm run benchmark menloresearch/asimov1-loco ./benchmarks/default    # local benchmark -> local only
npm run benchmark menloresearch/asimov1-loco datasets/<org>/<name>@v1 pr
npm run benchmark menloresearch/asimov1-loco test/fixtures/smoke-benchmark jobs=1   # 20-second smoke run
```

No `--` is needed: everything is a word. `npm run benchmark` alone prints the full usage.

| Word | Meaning |
|---|---|
| `org/name`, `org/name@rev`, a Hub model URL | policy on the Hub |
| a folder with an `.onnx` + `env.yaml`, or an `.onnx` | local policy |
| `datasets/org/name[@rev]`, a Hub dataset URL | benchmark on the Hub |
| a folder with a `benchmark.yaml` | local benchmark |
| `benchmark=`, `policy=` | the same, as options (`policy=` may repeat) |
| `tests=<id,id>`, `repeats=<n>` | run part of the benchmark (results stay local) |
| `jobs=<n>` | browser pages in parallel (default: half the cores) |
| `robots=<n>` | most repeats of one test a page runs at once, as robots in one scene (1-5, default 5); results do not depend on it |
| `shard=<i>/<n>`, then `npm run benchmark merge <dirs...> [upload]` | split a run across machines |
| `out=<dir>` | output folder (default `benchmark_results/<timestamp>/`) |
| `dry-run`, `no-upload`, `pr`, `force`, `watch`, `verbose` | see the usage text |

A bare `org/name` is always a policy; write `datasets/` for a benchmark. Without a benchmark,
`src/benchmark/default-suite.json` names the released default.

## What a run produces

`<out>/result.json` holds everything: the provenance (viewer commit and whether the checkout was clean, benchmark
protocol, asimov-1 commit, mujoco-js / onnxruntime-web / Chromium versions), the benchmark.yaml and test rows that
ran, the policy (Hub commit, sha256 of the ONNX and env.yaml), and for every **cell** (one test, one repeat) the
seed, the action delay drawn, the commands actually sent if a policy's command range clamped them, and the full
metrics. `<out>/report.html` is the readable report. `<out>/policies/<policy>/eval_results.yaml` previews what would
be uploaded.

The results have three layers, and only the last is squashed into single numbers:

1. **Cells**: raw metrics of each test repeat (`result.json` `cells`).
2. **Per test**: every metric's value for each repeat, and their mean (`perTest`).
3. **Tasks**: the benchmark's leaderboard numbers (`tasks`), e.g. `push_walking_survival_rate_v1`, each with a 95%
   interval over the seeds. Each is one leaderboard on the Hub; a benchmark can define as many as it likes. There is
   no single overall score unless a benchmark defines one.

How repeats and tests combine is part of each metric's versioned definition (see
[benchmark-datasets.md](benchmark-datasets.md#metrics-and-repeats)).

The report tells the two ways to fail a test apart: a run that fell shows "fell at T s"; one that stayed upright but
never entered the test's end zone (`goal`) shows "missed end zone by D m". Both score 0 on `survival_rate`, but only
the fall costs `survival_time`.

## When results are uploaded

Only when they can be reproduced: a Hub policy, a Hub benchmark (pinned to its commit), a viewer checkout with no
uncommitted changes whose `BENCHMARK_PROTOCOL` matches the benchmark, the whole benchmark as specified (no `tests=`,
`repeats=`, `force`, unmerged shard) and no failed cell. Otherwise the run is written locally and the reasons are
printed.

Uploading writes, in one commit, `.eval_results/<dataset>.yaml` (one entry per task; re-runs replace their own
task ids and keep the rest) and `eval_logs/<dataset>/v<version>/{result.json,report.html}` (the source each entry
links to). If you own the model repo's namespace (your user or one of your orgs) it is committed to `main`;
otherwise, or with `pr`, or if a direct commit is refused, it is opened as a pull request, which the Hub shows
as a community result until merged. It needs a token: `hf auth login` or `HF_TOKEN`.

Each entry's `notes` records `hpv@<commit> protocol=<n> benchmark=<name> v<version> asimov-1@<commit> policy@<commit>`.

## Versions: why numbers stay comparable

- **`BENCHMARK_PROTOCOL`** (`src/benchmark/protocol.js`) is bumped by any viewer change that can move a number:
  metrics, fall criteria, the scene, how env.yaml is applied, the tick loop, randomisation. A benchmark names the
  protocol it was validated with; the runner refuses a mismatch (`force` runs it locally anyway).
  `npm run benchmark:golden` compares a smoke run with `test/fixtures/smoke-benchmark/golden.json` to catch an
  accidental change.
- **The benchmark `version`** goes up when its tests or scoring change. Task ids end in `_v<version>`, so every version
  has its own leaderboards and old results stay listed under the old ids.
- Every result also records the exact viewer and dataset commits.

## Speed, parallelism and determinism

A headless run does not wait for the wall clock: the runner stops the viewer's real-time loop and steps the
simulation itself, exactly `duration / dt` policy ticks per test, as fast as the CPU allows (a 4 s test takes
about 0.5 s). Each page of the pool (`jobs=`) is its own Chromium process, so pages run on separate cores; a page
keeps its loaded policy and is handed that policy's cells first, and the longest tests start first.

A cell's result depends only on the policy files, the test, its seed and the viewer commit. The seed comes from the
benchmark seed, the test id and the repeat index, never from run order, so `jobs=1`, `jobs=4` and merged shards give
identical cells. Each extra page costs some start-up time (loading MuJoCo and the policy), so for a short benchmark
fewer pages can be faster.

A test's repeats are one policy with one simulation state per repeat, stepped in turn inside a page, up to
`robots=` of them (a test with more repeats is split into groups). Each repeat keeps its own seed, so the cells are
bit-identical to running the repeats one at a time.

`watch` shows the browser and runs in real time on one page, for looking at a policy. A test's repeats walk side by
side as see-through robots (fallen ones fade), each with its own seeded randomisation, so
`npm run benchmark <policy> <benchmark> watch` is how to see a seeded run: the benchmark's repeats, action delay and joint
noise, several robots at once. It needs a display; on a machine without one, run headless.

The in-app **Tests & Benchmark** panel runs the same code, once per test, on the benchmark open there (see
[Benchmark datasets](benchmark-datasets.md#creating-a-new-benchmark)): double-click a benchmark to run all its tests, or
check some tests and press **Run Benchmark**. Its confirm dialog has **Watch at real-time speed**, the in-app `watch`.
It plays each test once, one robot, with no seeds or randomisation: it ignores the benchmark's repeats, randomisation and
test selection (the benchmark's ⚙ **Benchmark settings** edit those for `npm run benchmark`, see
[Benchmark datasets](benchmark-datasets.md#editing-benchmarkyaml-in-the-viewer)). It keeps its results locally and never
uploads.

## Saved results

`benchmark_results/` (or `HPV_BENCHMARK_RESULTS_DIR`, see [Policy library](policy-library.md)) holds headless results and
the in-app results listed at `/api/results`.
