# Benchmarking

A benchmark runs a policy through a **suite** of test scenarios (velocity commands, timed pushes, slippery
floors) and scores it. The suite is a [Hugging Face benchmark dataset](benchmark-datasets.md); the results go
into the model repo's `.eval_results/` and appear on the model page and on the benchmark's leaderboards
([Hugging Face eval results](https://huggingface.co/docs/hub/eval-results)).

```bash
npm run benchmark menloresearch/asimov1-loco                         # Hub model, default suite -> uploads
npm run benchmark ./models/model_Aug_18_1                            # local model -> local results only
npm run benchmark menloresearch/asimov1-loco ../asimov-locomotion-bench          # local suite -> local only
npm run benchmark menloresearch/asimov1-loco datasets/menloresearch/asimov-locomotion-bench@v1 pr
npm run benchmark menloresearch/asimov1-loco test/fixtures/smoke-suite jobs=1   # 20-second smoke run
```

No `--` is needed: everything is a word. `npm run benchmark` alone prints the full usage.

| Word | Meaning |
|---|---|
| `org/name`, `org/name@rev`, a Hub model URL | model on the Hub |
| a folder with an `.onnx` + `env.yaml`, or an `.onnx` | local model |
| `datasets/org/name[@rev]`, a Hub dataset URL | suite on the Hub |
| a folder with a `suite.yaml` | local suite |
| `suite=`, `suite-file=`, `model=` | the same, as options (`model=` may repeat) |
| `tests=<id,id>`, `repeats=<n>` | run part of the suite (results stay local) |
| `jobs=<n>` | browser pages in parallel (default: half the cores) |
| `shard=<i>/<n>`, then `npm run benchmark merge <dirs...> [upload]` | split a run across machines |
| `out=<dir>` | output folder (default `benchmark_runs/<timestamp>/`) |
| `dry-run`, `no-upload`, `pr`, `force`, `watch`, `verbose` | see the usage text |

A bare `org/name` is always a model; write `datasets/` for a suite. Without a suite,
`src/benchmark/default-suite.json` names the released default.

## What a run produces

`<out>/run.json` holds everything: the provenance (viewer commit and whether the checkout was clean, benchmark
protocol, asimov-1 commit, mujoco-js / onnxruntime-web / Chromium versions), the suite.yaml and test rows that
ran, the model (Hub commit, sha256 of the ONNX and env.yaml), and for every **cell** (one test, one repeat) the
seed, the action delay drawn, the commands actually sent if a policy's command range clamped them, and the full
metrics. `<out>/report.html` is the readable report. `<out>/models/<model>/eval_results.yaml` previews what would
be uploaded.

The results have three layers, and only the last is squashed into single numbers:

1. **Cells**: raw metrics of each test repeat (`run.json` `cells`).
2. **Per test**: repeats combined by the suite's `aggregate` and `pass_rule` (`perTest`).
3. **Tasks**: the suite's leaderboard numbers (`tasks`), e.g. `push_walking_reasonable_pass_v1`. Each is one
   leaderboard on the Hub; a suite can define as many as it likes. There is no single overall score unless a
   suite defines one.

## When results are uploaded

Only when they can be reproduced: a Hub model, a Hub suite (pinned to its commit), a viewer checkout with no
uncommitted changes whose `BENCHMARK_PROTOCOL` matches the suite, the whole suite as specified (no `tests=`,
`repeats=`, `force`, unmerged shard) and no failed cell. Otherwise the run is written locally and the reasons are
printed.

Uploading writes, in one commit, `.eval_results/<dataset>.yaml` (one entry per task; re-runs replace their own
task ids and keep the rest) and `eval_logs/<dataset>/v<version>/{run.json,report.html}` (the source each entry
links to). If you own the model's namespace (your user or one of your orgs) it is committed to `main`;
otherwise, or with `pr`, or if a direct commit is refused, it is opened as a pull request, which the Hub shows
as a community result until merged. It needs a token: `hf auth login` or `HF_TOKEN`.

Each entry's `notes` records `hpv@<commit> protocol=<n> suite=<name> v<version> asimov-1@<commit> model@<commit>`.

## Versions: why numbers stay comparable

- **`BENCHMARK_PROTOCOL`** (`src/benchmark/protocol.js`) is bumped by any viewer change that can move a number:
  metrics, fall criteria, the scene, how env.yaml is applied, the tick loop, randomisation. A suite names the
  protocol it was validated with; the runner refuses a mismatch (`force` runs it locally anyway).
  `npm run benchmark:golden` compares a smoke run with `test/fixtures/smoke-suite/golden.json` to catch an
  accidental change.
- **The suite `version`** goes up when its tests or scoring change. Task ids end in `_v<version>`, so every version
  has its own leaderboards and old results stay listed under the old ids.
- Every result also records the exact viewer and dataset commits.

## Speed, parallelism and determinism

A headless run does not wait for the wall clock: the runner stops the viewer's real-time loop and steps the
simulation itself, exactly `duration / dt` policy ticks per test, as fast as the CPU allows (a 4 s test takes
about 0.5 s). Each page of the pool (`jobs=`) is its own Chromium process, so pages run on separate cores; a page
keeps its loaded policy and is handed that model's cells first, and the longest tests start first.

A cell's result depends only on the model files, the test, its seed and the viewer commit. The seed comes from the
suite seed, the test id and the repeat index, never from run order, so `jobs=1`, `jobs=4` and merged shards give
identical cells. Each extra page costs some start-up time (loading MuJoCo and the policy), so for a short suite
fewer pages can be faster.

`watch` shows the browser and runs in real time on one page, for looking at a policy. The in-app
**Tests & Benchmark** panel runs the same code on the tests of the current folder (or of `npm run dev suite=<dir>`)
and keeps its results locally; it never uploads.

## Saved runs

`benchmark_runs/` (or `HPV_BENCHMARK_RUNS_DIR`, see [Model library](model-library.md)) holds headless runs and the
in-app runs listed at `/api/benchmarks`.
