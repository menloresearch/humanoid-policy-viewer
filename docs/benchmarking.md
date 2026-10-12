# Benchmarking

A **benchmark** runs a policy through a set of test scenarios (velocity commands, timed pushes, slippery
floors) and scores it. A benchmark is a folder ([Benchmarks](benchmarks.md)), published as a Hugging Face dataset.
Running one is always local; `npm run hf submit` then puts the results into the model repo's `.eval_results/`, where
they appear on the model page and on the benchmark's leaderboards
([Hugging Face eval results](https://huggingface.co/docs/hub/eval-results)).

```bash
npm run benchmark menloresearch/asimov1-loco datasets/<org>/<name>@v1   # Hub policy, Hub benchmark
npm run hf submit benchmark_results/<timestamp>                        # -> the policy's model repo
npm run benchmark ./policies/model_Aug_18_1                            # local policy, ./benchmarks/default
npm run benchmark menloresearch/asimov1-loco test/fixtures/smoke-benchmark jobs=1   # 20-second smoke run
```

`npm run benchmark` never uploads anything; `npm run hf submit` does, as a separate step (see below).

No `--` is needed: everything is a word. `npm run benchmark` alone prints the full usage.

The first run on a fresh clone sets itself up, as `npm run dev` and `npm run hf` do: it installs the dependencies,
fetches the Asimov robot model and installs the Chromium that Playwright drives (`merge`, `init` and `path-end` need
only the dependencies, and `view` no browser). The usage text and `help` install nothing.

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
| `shard=<i>/<n>`, then `npm run benchmark merge <dirs...>` | split a run across machines (merging is local) |
| `out=<dir>` | output folder (default `benchmark_results/<timestamp>/`) |
| `force`, `watch`, `verbose` | see the usage text |

A bare `org/name` is always a policy; write `datasets/` for a benchmark. Without a benchmark, the run uses
`./benchmarks/default`, a local folder, so its results can be looked at but not submitted.

## What a run produces

`<out>/result.json` holds everything: the provenance (viewer commit and whether the checkout was clean, benchmark
protocol, asimov-1 commit, mujoco-js / onnxruntime-web / Chromium versions), the benchmark.yaml and test rows that
ran, the policy (Hub commit, sha256 of the ONNX and env.yaml), and for every **cell** (one test, one repeat) the
seed, the action delay drawn, the commands actually sent if a policy's command range clamped them, and the full
metrics. `<out>/report.html` is the readable report. The run ends by printing how to look at the result
(`npm run benchmark view <out>`, and the path of `report.html` to open directly) and the `npm run hf submit <out>`
command, or why the result cannot be submitted.

To look at a result again later, run `npm run benchmark view <out>` (the folder or its `result.json`; add `no-open` to
skip the browser, `port=<n>` to pick the port). It serves the viewer read-only and opens its results page on that
result until you press Ctrl+C. Any running viewer does the same for the URL `/?result=<folder>/result.json`, for example
`http://localhost:3000/?result=20261012T112354/result.json` on `npm run dev` for a result in `benchmark_results/`.
Result folders are named with letters, digits, `-` and `_`.

The results have three layers, and only the last is squashed into single numbers:

1. **Cells**: raw metrics of each test repeat (`result.json` `cells`).
2. **Per test**: every metric's value for each repeat, and their mean (`perTest`).
3. **Tasks**: the benchmark's leaderboard numbers (`tasks`), e.g. `push_walking_survival_rate_v1`, each with a 95%
   interval over the seeds. Each is one leaderboard on the Hub; a benchmark can define as many as it likes. There is
   no single overall score unless a benchmark defines one.

How repeats and tests combine is part of each metric's versioned definition (see
[Benchmarks](benchmarks.md#metrics-and-repeats)).

The report tells the two ways to fail a test apart: a run that fell shows "fell at T s"; one that stayed upright but
never entered the test's end zone (`goal`) shows "missed end zone by D m". Both score 0 on `survival_rate`, but only
the fall costs `survival_time`.

## Submitting results

```bash
npm run hf submit <out> dry-run   # the files, the target repo and commit, or why not
npm run hf submit <out> [pr]
```

Only results that can be reproduced are submitted: a Hub policy pinned to its commit, a Hub benchmark pinned to its
commit, a viewer checkout with no uncommitted changes whose `BENCHMARK_PROTOCOL` matches the benchmark, the whole
benchmark as specified (no `tests=`, `repeats=`, `force`, unmerged shard) and no failed cell. `submit` decides from
what `result.json` recorded when the run happened, so a result cannot be made submittable afterwards; it lists the
reasons for each policy it refuses.

For each policy, `submit` writes, in one commit to its model repo, `.eval_results/<dataset>.yaml` (one entry per
task; re-runs replace their own task ids and keep the rest) and `eval_logs/<dataset>/v<version>/{result.json,report.html}`
(that policy's part of the result, and the source each entry links to). If you own the model repo's namespace (your
user or one of your orgs) it is committed to `main`; otherwise, or with `pr`, or if a direct commit is refused, it
is opened as a pull request, which the Hub shows as a community result until merged. It needs a write token:
`export HF_TOKEN=hf_...`, or `hf auth login` (the Hugging Face CLI, `pip install -U huggingface_hub`).

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

## In the app

The **Tests & Benchmark** panel runs the benchmark open there (see
[Benchmarks](benchmarks.md#creating-a-new-benchmark)) the way `npm run benchmark` does: double-click a benchmark to run
all its tests, or check some tests and press **Run Benchmark** (like `tests=`). It plans the same cells from
`benchmark.yaml` (its repeats, seeds and randomisation, edited with ⚙ **Benchmark settings**, see
[Benchmarks](benchmarks.md#editing-benchmarkyaml-in-the-viewer)), runs the same checks first, and steps each group of
repeats through the same code, the repeats walking side by side as see-through robots. The confirm dialog shows the
plan and has **Watch at real-time speed**, the in-app `watch`; without it the simulation steps as fast as it can, with the scene still drawn.
Starting a run stops a sequence that is playing.

When it finishes, the server saves `benchmark_results/<timestamp>/{result.json,report.html}`, with the same provenance
the CLI records, and the results page opens. Its cells are the CLI's, seed for seed. The benchmark is recorded as a
local folder, so `npm run hf submit` refuses these results; run `npm run benchmark` on a pinned Hub benchmark for
results to submit.

## Results

`benchmark_results/` (or `HPV_BENCHMARK_RESULTS_DIR`, see [Policy library](policy-library.md)) holds one folder per
result, from `npm run benchmark` and the app alike, each with its `result.json` and `report.html`. The app lists them at
`/api/results`; its results page and `report.html` show the same thing: per policy, each test's outcome on every repeat
(passed, fell at T s, or missed the end zone by D m), the metric means and the tasks with their 95% intervals.
