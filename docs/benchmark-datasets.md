# Benchmark datasets

A benchmark suite lives in a Hugging Face **dataset** repo, registered as a Hub benchmark through its
`eval.yaml`. The dataset is the only copy of the tests; this repo holds the code that runs them (and a tiny
fixture, `test/fixtures/smoke-suite/`, for its own tests).

```
suite.yaml                 what runs, how often, how it is scored, which numbers are leaderboards
data/<config>/test.jsonl   one test per line; one dataset config per category (locomotion, push_walking, ...)
README.md                  optional notes; becomes the dataset card
METHODOLOGY.md             optional: why the tests are what they are
calibration/, suites/      optional: calibration records, extra suite files (e.g. suites/smoke.yaml)
tools/                     optional: scripts that generate the tests (published, for reviewers)
```

That is all a benchmark needs locally. Publishing adds the Hugging Face files, built from `suite.yaml` and never
kept in the working copy: `eval.yaml` (the Hub benchmark registration, one task per leaderboard) and the card's
front matter (a default `all` config with every test, one config per category, tags). A task scoped to one
category points at that config; any other task points at `all`, so `all` is not a valid category name. `npm run suite publish <dir> dry-run` shows them.

## A test (one row)

A test describes a scenario and nothing else; it does not know how often it runs or how it is scored.

```json
{"id": "push_walking/back", "config": "push_walking", "schema_version": 1, "kind": "velocity-sequence",
 "name": "push: pelvis back (rear handle push) (walking)", "description": "", "tags": [],
 "duration": 12, "commands": [{"t": 0, "vx": 0.6, "vy": 0, "wz": 0}],
 "events": [{"t": 2, "type": "push", "dir": [-1, 0, 0], "force": 450, "duration": 0.15, "targetBody": "pelvis_link",
             "torqueAxis": null, "torqueMag": null, "label": "pelvis back — reasonable (450N)", "tier": "reasonable"}],
 "limits": null, "foot_friction": null, "terrain": null, "metrics_opt_in": []}
```

`id` is `<config>/<name>` and is how results refer to the test. A benchmark without categories puts every test
in the one config `default` (the editor does this when Category is left blank); the Hub treats a config named
`default` as the unnamed one, so `load_dataset(repo)` works without naming it. `tier` is `reasonable` (a policy should
recover), `beyond` (at or past the observed limit) or `null`. `limits` overrides every policy's trained command
range, so leave it `null` unless the test needs it. `foot_friction` overrides the feet's sliding friction (the
scene's is 0.6). `terrain` describes the course the test walks on (below). `metrics_opt_in: ["gait_symmetry"]` turns on
the gait symmetry metric (straight, steady walking only). The full schema is in `src/benchmark/testRow.js`.

### Terrain

A test's `terrain` describes its course with parameters; the viewer builds it (`src/simulation/terrainGen.js`) and
splices it into the default robot scene for that test (`src/simulation/terrainScene.js`), reloading the scene,
keeping the policy, only when it differs from the previous test's. A course is part of the test, so a new one is a
dataset edit, not a viewer change. Every course starts `start_m` in front of the robot and runs along +x, centred on
y = 0. A spec names every parameter of its type:

| `type` | parameters (defaults) |
|---|---|
| `stairs` | `start_m` 1.5, `width_m` 6, `step_height_m` 0.05, `steps` 5 (each way), `tread_m` 0.35, `top_m` 1.5 |
| `slope` | `start_m` 1.5, `width_m` 6, `angle_deg` 10, `height_m` 0.3, `top_m` 1.5 |
| `boxes` | `start_m` 1.5, `width_m` 1.2 (lane), `length_m` 5.8, `count` 14, `min_height_m` 0.03, `max_height_m` 0.07, `min_size_m` 0.2, `max_size_m` 0.4, `seed` 7 |
| `rough` | `start_m` 1.5, `width_m` 6, `length_m` 6.3, `tile_m` 0.3, `min_height_m` 0.005, `max_height_m` 0.04, `seed` 11 |

```json
"terrain": {"type": "stairs", "start_m": 1.5, "width_m": 6, "step_height_m": 0.1, "steps": 5, "tread_m": 0.35, "top_m": 1.5}
```

How terrain interacts with the rest of a test:

- **Falls** are judged by the base's height above the ground under it (and tilt), so a robot slumped on a 0.5 m
  platform counts as fallen, as it would on the floor. Push instability uses the same height.
- **Spawn**: the robot always starts at the origin facing +x. `npm run benchmark` refuses a course that comes within
  0.5 m of it.
- **Commands**: courses run along +x, so a turning or sideways test can walk off one. `npm run benchmark` and the
  editor warn when the commanded path never reaches the course or leaves it sideways (the path is the commands
  integrated, not what a policy walks).
- **`foot_friction`** applies on terrain too: the feet's contact priority makes their friction win against course
  geoms as against the floor.
- Random layouts (`boxes`, `rough`) come from the spec's `seed`, so a test always builds the same course.

What a spec builds is part of `BENCHMARK_PROTOCOL`. `npm run terrain-tests [<benchmark dir>]` writes seven starter
tests (stairs 5 and 10 cm, ramps 10° and 15°, the 10° ramp with shoulder pushes, boxes, rough tiles), each walked
at 0.4 m/s for 20 s, to `data/terrain/test.jsonl` (default `./benchmark`).

## The suite (`suite.yaml`)

```yaml
suite: asimov-locomotion
title: Asimov Locomotion Benchmark
version: 1                         # bump when anything that can change a score changes
harness:
  repo: https://github.com/menloresearch/humanoid-policy-viewer
  protocol: 1                      # the viewer's BENCHMARK_PROTOCOL this suite was validated with
  tested_commit: <viewer commit>
requires: { robot: { name: asimov-1 }, policy_interface: velocity-command }
defaults:
  repeats: 5
  seed: 0                          # repeat i of test t runs with a seed derived from (seed, t, i)
  randomize: { action_delay: env_range, initial_joint_noise_rad: 0.02 }
  timeout_s: 600                   # wall-clock budget per cell
tests:                             # { all: true }, { config: … } or { id: … }; later entries override earlier ones
  - { config: locomotion }
  - { config: push_walking }
  - { id: distance/square_lap_100m, repeats: 2 }
tasks:                             # leaderboard numbers; ids get _v<version> appended
  - { id: survival_rate, metric: survival_rate@1 }
  - { id: survival_time, metric: survival_time@1 }
  - { id: push_walking_reasonable_survival_rate, metric: survival_rate@1, scope: { config: push_walking, tier: reasonable } }
reference_models: [menloresearch/asimov1-loco]   # used by `npm run suite baseline`
```

The simulation is deterministic, so `repeats > 1` only makes sense with something randomised; the runner refuses
otherwise. A scope narrows a task to `config`, `id`, `tag` (a test's tags) and/or `tier` (a test's push tiers);
each may be a list.

### Metrics and repeats

Metrics live in `src/benchmark/summary.js` and are named with a version, `<name>@<version>`:

| metric | one run (test × repeat) | |
|---|---|---|
| `survival_rate@1` | 1 if it never fell, else 0 | probability of finishing a test upright |
| `survival_time@1` | fraction of the test completed before the first fall (1 = never fell) | separates "fell at 1 s" from "fell at 9 s" |

A fall is the base below 0.35 m, the torso tilted past 78.5°, or a tumble (`src/simulation/benchmarkRunner.js`);
it is part of `BENCHMARK_PROTOCOL`. A run that errored counts as a fall at t = 0.

Repeats differ only by their seeded randomisation (the action delay drawn from the policy's `env.yaml` range,
initial joint noise), which moves a policy's limit by tens of Newtons near a push boundary. So outcomes there are
genuinely probabilistic, and every metric is combined the same way:

1. **Repeats → test**: the mean. For `survival_rate` that is the estimated probability of surviving the test,
   not a pass/fail.
2. **Tests → task**: the mean within each category, then the mean of the categories in the task's scope, so a
   category of 30 push tests does not drown out one of 9 locomotion tests.
3. **Uncertainty**: the standard error of that mean over the seeds (the tests are fixed; only the randomisation is
   random) and a 95% interval, clipped to the metric's range. Each test's spread is smoothed as if one more repeat
   had landed at each end of the range, so 5 survivals out of 5 still show uncertainty. The interval is in
   `run.json`, printed by `npm run benchmark`, and written into each `.eval_results` entry's `notes` (the Hub has
   no field for it).

More repeats narrow the interval roughly as 1/√repeats; 5 is a reasonable default. A metric's version fixes how
it is computed and combined: adding a metric or a new version needs no `BENCHMARK_PROTOCOL` bump, but a published
version is never changed. Using a metric in a suite (or switching versions) is a suite `version` bump. The other
numbers `run.json` keeps per run (tracking error, drift, push recovery, balance, gait symmetry, smoothness) feed no
leaderboard yet; each can become a metric when it is trustworthy.

## Workflow

```bash
npm run suite pull datasets/menloresearch/asimov-locomotion-bench ./bench   # working copy (+ .hpv-suite.json)
npm run dev suite=./bench          # edit tests in the trajectory editor (or edit data/*/test.jsonl)
npm run suite diff ./bench         # what changed since the pulled revision, and whether scores can move
npm run suite baseline ./bench     # run reference models on the old and new suite -> ./bench/baseline.md
npm run suite publish ./bench pr   # commit (owners) or pull request; description = diff + baseline
```

There is no separate check step. `npm run benchmark` checks the tests before it starts a browser: every row loads
in the command player, the suite's selection works, and it warns about tests no selector picks. `publish` runs
the same checks plus "a change that can move a score needs a new `version`".

Hub dataset pull requests have no CI, so the reviewer reproduces the checks:
`npm run suite pull datasets/<id>@refs/pr/<n> ./review`, then `baseline`. After merging, a
maintainer tags the release and points the viewer at it:

```bash
npm run suite release datasets/menloresearch/asimov-locomotion-bench rev=<merged commit>   # tags v<version>
# then, in this repo: src/benchmark/default-suite.json -> "revision": "v<version>"
```

and re-runs `npm run benchmark` for the reference models so the new leaderboards are not empty.

### When the viewer changes

A change that moves numbers bumps `BENCHMARK_PROTOCOL` (and `npm run benchmark:golden update`). Suites validated
with the old protocol are then refused for upload until they are re-validated: set `harness.protocol` and
`tested_commit`, bump `version`, publish, release. Old results keep their old task ids.

### Creating a new benchmark

Everything happens locally until `publish`:

```bash
npm run suite init ./new-bench          # starter suite.yaml (tests: [{ all: true }]) + one example test
npm run dev suite=./new-bench           # add tests; type a new Category in the editor to start a category
npm run benchmark <model> ./new-bench   # real runs, results stay local
npm run suite publish ./new-bench repo=<org>/<name> dry-run    # what would be uploaded
npm run suite publish ./new-bench repo=<org>/<name> create     # creates a PRIVATE dataset repo first
```

Plain `npm run dev` uses `./benchmark` (gitignored) and creates a starter benchmark there on first run.

In the editor a test is saved as **Category / Test name** (the test id `<category>/<name>`). A new category
gets its own `data/<category>/test.jsonl` (and, once published, its own dataset config). Deleting a category's last test removes it. A category only runs if `suite.yaml` selects it (the
starter's `{ all: true }` selects everything) and only gets a leaderboard if a task scopes it.

The editor's **Environment** panel sets a test's terrain (type and parameters), foot friction (scene default, wet,
icy or custom) and the gait-symmetry opt-in. A terrain test shows a top view (course, spawn area, commanded path)
and a side profile, with the same spawn error and path warnings `npm run benchmark` gives; Save is disabled while
the course overlaps the spawn. **Apply to viewer** loads the course into the 3D view. A push's benchmark tier is set
in its push dialog.

To appear as a Hub benchmark, `eval.yaml`'s `evaluation_framework: humanoid-policy-viewer` must be in the Hub's
list of frameworks (a pull request to `huggingface/huggingface.js`, `packages/tasks/src/eval.ts`), and the
dataset must be allow-listed by Hugging Face (beta). Until then results still land in model repos; they just are
not aggregated into a leaderboard.
