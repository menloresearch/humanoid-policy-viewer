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
```

That is all a benchmark needs locally. Publishing adds the Hugging Face files, built from `suite.yaml` and never
kept in the working copy: `eval.yaml` (the Hub benchmark registration, one task per leaderboard) and the card's
front matter (one dataset config per category, tags). `npm run suite publish <dir> dry-run` shows them.

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
  aggregate: mean                  # mean | median | worst, for continuous metrics over repeats
  pass_rule: all_repeats           # all_repeats | fraction, for upright / push recovered
  timeout_s: 600                   # wall-clock budget per cell
tests:                             # { all: true }, { config: … } or { id: … }; later entries override earlier ones
  - { config: locomotion }
  - { config: push_walking }
  - { id: distance/square_lap_100m, repeats: 1 }
tasks:                             # leaderboard numbers; ids get _v<version> appended
  - { id: upright_rate, metric: upright_rate }
  - { id: push_walking_reasonable_pass, metric: push_pass_rate, scope: { config: push_walking, tier: reasonable } }
  - { id: push_walking_max_force_n, metric: max_force_survived_n, scope: { config: push_walking } }
reference_models: [menloresearch/asimov1-loco]   # used by `npm run suite baseline`
```

The simulation is deterministic, so `repeats > 1` only makes sense with something randomised; the runner refuses
otherwise. Metrics (`src/benchmark/summary.js`): `upright_rate`, `push_pass_rate`, `max_force_survived_n`,
`tracking_rmse` / `tracking_score`, `drift_final_m` / `drift_score`. The Hub's leaderboards rank higher values
first, so prefer the `_score` forms for leaderboards. A scope narrows a task to `config`, `id` (either may be a list)
and, for push metrics, `tier`. A new metric or randomisation is a viewer change (and a protocol bump); using it is
a suite change (a version bump).

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
