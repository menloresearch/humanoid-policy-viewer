# Benchmarks

A **benchmark** is a folder: a `benchmark.yaml` (what runs, how often, how it is scored) and its **tests**. You work
on one locally, under `./benchmarks/` or anywhere else, and publish it to a Hugging Face **dataset** repo, registered
as a Hub benchmark through its `eval.yaml`. The published dataset is the copy everyone runs and the leaderboards
refer to; this repo holds the code that runs benchmarks, the example `benchmarks/default/`, and a tiny fixture,
`test/fixtures/smoke-benchmark/`, for its own tests.

```
benchmark.yaml             what runs, how often, how it is scored, which numbers are leaderboards
data/<config>/test.jsonl   one test per line; one dataset config per category (locomotion, push_walking, ...)
README.md                  optional notes; becomes the dataset card
METHODOLOGY.md             optional: why the tests are what they are
LICENSE                    optional: your own license text, if benchmark.yaml's license: points at it
calibration/               optional: calibration records
tools/                     optional: scripts that generate the tests (published, for reviewers)
```

That is all a benchmark needs locally. Publishing adds the Hugging Face files, built from `benchmark.yaml` and never
kept in the working copy: `eval.yaml` (the Hub benchmark registration, one task per leaderboard) and the card's
front matter (a default `all` config with every test, one config per category, the declared column types, the
`humanoid-policy-viewer` tag plus `benchmark.yaml`'s `tags`, and its `license`). A task scoped to one
category points at that config; any other task points at `all`, so `all` is not a valid category name. `npm run hf publish <dir> dry-run` shows them.

## A test (one row)

A test describes a scenario and nothing else; it does not know how often it runs or how it is scored.

```json
{"id": "push_walking/back", "config": "push_walking", "schema_version": 1, "kind": "velocity-sequence",
 "name": "push: pelvis back (rear handle push) (walking)", "description": "", "tags": [],
 "duration": 12, "commands": [{"t": 0, "vx": 0.6, "vy": 0, "wz": 0}],
 "events": [{"t": 2, "type": "push", "dir": [-1, 0, 0], "force": 450, "duration": 0.15, "targetBody": "pelvis_link",
             "torqueAxis": null, "torqueMag": null, "label": "pelvis back (450N)"}],
 "limits": null, "foot_friction": null, "terrain": null, "goal": null, "metrics_opt_in": []}
```

`id` is `<config>/<name>` and is how results refer to the test. A benchmark without categories puts every test
in the one config `default` (the editor does this when Category is left blank); the Hub treats a config named
`default` as the unnamed one, so `load_dataset(repo)` works without naming it. A push starts at least 1 s into the test (the robot
settles first) and ends at least 2 s before the test does (time to recover), so `t >= 1` and
`t + duration <= <test duration> - 2`; the dataset check refuses rows that break this. `limits` overrides every policy's trained command
range, so leave it `null` unless the test needs it. `foot_friction` overrides the feet's sliding friction (the
scene's is 0.6). `terrain` describes the course the test walks on (below). `goal` is an optional end zone,
`{"x": 7, "y": 0, "radius_m": 1}` in metres from the robot's start (+x ahead, +y to its left, radius at least
0.25 m): a run counts as surviving only if the robot's base entered that circle and it never fell. Without one, a
policy could "survive" a course by stopping in front of it. Missing the zone fails `survival_rate` but not
`survival_time` (the robot stayed upright the whole time). Results keep the two failures apart: a run that fell
shows "fell at T s", one that stayed upright but never got there shows "missed end zone by D m" (amber in the
report), and each run records `metrics.goal` (`reached`, `miss_m`). `x` and `y` have at most 2 decimals (1 cm). In the
editor's Environment tab, drag the zone in the top view (hold Shift to move along one axis); it snaps to the end of
the commanded path (the ✕), as does **Snap to path end**. From a script or an agent:
`npm run benchmark path-end <dir> [<test id>...]` prints one JSON line per test with `path_end` (where the velocity
commands, integrated exactly, leave the robot), its `goal`, and whether the path enters it; the checks before a run
warn when the commanded path never enters a test's end zone. `metrics_opt_in: ["gait_symmetry"]` turns on
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

What a spec builds is part of `BENCHMARK_PROTOCOL`.

## The settings (`benchmark.yaml`)

```yaml
name: asimov-locomotion
title: Asimov Locomotion Benchmark
version: 1                         # bump when anything that can change a score changes
license: bsd-3-clause              # a Hugging Face license id, or a file in this folder (license: LICENSE)
tags: [humanoid, locomotion]       # added to the card after humanoid-policy-viewer
harness:
  repo: https://github.com/menloresearch/humanoid-policy-viewer
  protocol: 1                      # the viewer's BENCHMARK_PROTOCOL this benchmark was validated with
  tested_commit: <viewer commit>   # set by `npm run hf publish`: the viewer commit that checked this benchmark
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
  - { id: push_walking_survival_rate, metric: survival_rate@1, scope: { config: push_walking } }
reference_policies: [menloresearch/asimov1-loco]   # used by `npm run hf baseline`
```

`license` goes on the dataset card. Use one of the Hub's
[license ids](https://huggingface.co/docs/hub/repositories-licenses) (`bsd-3-clause`, `apache-2.0`, `mit`,
`cc-by-4.0`, ...), or name a file in the benchmark folder (`LICENSE`, `LICENSE.md`, `COPYING`, ...): it is uploaded
and the card says `license: other`, linking to it. `license` and `tags` only change the card, so they never need a
version bump.

A new benchmark (`npm run benchmark init`, **New benchmark**) starts with no `license:` line, so that its first
`hf publish` asks. If `license:` is missing, `hf publish` warns and asks `Use bsd-3-clause instead? [y/N]`: yes publishes with
`bsd-3-clause`, no cancels before anything is uploaded (with no terminal to ask on, it cancels too). A blank
`license:` means no license on purpose: it warns and asks the same question, but no (or no terminal) publishes without
one. `dry-run` never asks.

The simulation is deterministic, so `repeats > 1` only makes sense with something randomised; the runner refuses
otherwise. A scope narrows a task to `config`, `id` and/or `tag` (a test's tags);
each may be a list. To score a difficulty level on its own, give it its own category.

Keys left out of `defaults` take these values:

| key | when left out | values |
|---|---|---|
| `repeats` | 1 | an integer >= 1 |
| `seed` | 0 | any integer |
| `timeout_s` | 600 | wall-clock seconds per cell |
| `randomize.action_delay` | `midpoint` (the middle of the policy's range) | `midpoint`, or `env_range` (drawn per repeat from the range in the policy's `env.yaml`) |
| `randomize.initial_joint_noise_rad` | 0 (none) | a number >= 0 |

`npm run benchmark init` (and a new benchmark in the viewer) starts from `repeats: 5`, `seed: 0`,
`randomize: { action_delay: env_range, initial_joint_noise_rad: 0.02 }`, `timeout_s: 600`, `tests: [{ all: true }]`,
the tasks `survival_rate` and `survival_time`, `version: 1` and `requires: { robot: asimov-1, policy_interface:
velocity-command }`. A test entry can override `repeats`; a later entry wins over an earlier one.

### Metrics and repeats

Metrics live in `src/benchmark/summary.js` and are named with a version, `<name>@<version>`:

| metric | one run (test × repeat) | |
|---|---|---|
| `survival_rate@1` | 1 if it never fell (and reached the end zone, if the test has one), else 0 | probability of finishing a test upright |
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
   `result.json`, printed by `npm run benchmark`, and written into each `.eval_results` entry's `notes` (the Hub has
   no field for it).

More repeats narrow the interval roughly as 1/√repeats; 5 is a reasonable default. A metric's version fixes how
it is computed and combined: adding a metric or a new version needs no `BENCHMARK_PROTOCOL` bump, but a published
version is never changed. Using a metric in a benchmark (or switching versions) is a benchmark `version` bump. The other
numbers `result.json` keeps per run (tracking error, drift, push recovery, gait symmetry, smoothness) feed no
leaderboard yet; each can become a metric when it is trustworthy.

## Workflow

```bash
npm run hf pull datasets/<org>/<name> ./bench   # working copy (+ .hpv-benchmark.json, which records the dataset)
npm run dev benchmark=./bench                   # edit tests in the trajectory editor (or edit data/*/test.jsonl)
npm run hf diff ./bench                         # what changed compared with the dataset's main, and whether scores can move
npm run hf baseline ./bench                     # run reference policies on main and on the folder -> ./bench/baseline.md
npm run hf publish ./bench dry-run              # the files, eval.yaml and the description, without writing
npm run hf publish ./bench [pr]                 # commit + tag v<version> (owners) or pull request; description = diff + baseline
```

`diff`, `baseline` and `publish` always compare with the dataset's current `main` on the Hub, not with the revision
that was pulled, so a change someone published in the meantime is not hidden. `base=<rev>` compares with another
revision instead; `publish` refuses a `base=` that is no longer `main` (it would publish on top of a stale
revision). A folder that was not pulled names its dataset with `repo=<org>/<name>`.

`npm run dev benchmark=datasets/<org>/<name>[@rev]` does the pull for you: the first time it pulls the dataset into
`./benchmarks/<org>__<name>` (gitignored), an ordinary working copy like `./bench` above; later runs open
that copy as it is, edits included (delete the folder to pull afresh).

There is no separate check step. `npm run benchmark` checks the tests before it starts a browser: every row loads
in the command player, the benchmark's selection works, and it warns about tests no selector picks. `publish` runs
the same checks plus "a change that can move a score needs a new `version`" (compared with `main`).

`publish` also refuses a viewer checkout with uncommitted changes, or one whose commit is not on a branch of
`menloresearch/humanoid-policy-viewer` (push it and `git fetch` first), since nobody else could check out the code
that checked the benchmark. It records that commit as `harness.tested_commit` in the uploaded `benchmark.yaml` (your
folder is left as it is). The commit is a record, not a requirement: any viewer implementing the benchmark's
`harness.protocol` runs it, and each result records the viewer commit it actually ran on.

When you own the dataset's namespace, `publish` commits to `main` and tags the commit `v<version>`; it does not tag
when the version did not change (nothing that affects scores changed). Otherwise, or with `pr`, it opens a pull
request and prints the release command. Hub dataset pull requests have no CI, so the reviewer reproduces the
checks: `npm run hf pull datasets/<id>@refs/pr/<n> ./review`, then `baseline`. After merging, a maintainer tags
the release:

```bash
npm run hf release datasets/<org>/<name> rev=<merged commit>   # tags v<version>
```

and re-runs `npm run benchmark <policy> datasets/<org>/<name>@v<version>` for the reference policies, then
`npm run hf submit` for each result, so the new leaderboards are not empty.

### When the viewer changes

A change that moves numbers bumps `BENCHMARK_PROTOCOL` (and `npm run benchmark:golden update`). Benchmarks validated
with the old protocol are then refused by `npm run hf submit` until they are re-validated: set `harness.protocol`, bump
`version`, publish (which records the new `tested_commit`), release. Old results keep their old task ids.

### Creating a new benchmark

Everything happens locally until `publish`:

```bash
npm run benchmark init ./new-bench                         # a copy of ./benchmarks/default: benchmark.yaml + three example tests
npm run dev benchmark=./new-bench                          # add tests; type a new Category in the editor to start a category
npm run benchmark <policy> ./new-bench                     # real runs, results stay local
npm run hf publish ./new-bench repo=<org>/<name> dry-run   # what would be uploaded (works before the repo exists)
npm run hf publish ./new-bench repo=<org>/<name> create    # creates a PRIVATE dataset repo first, then commits and tags v1
```

Plain `npm run dev` uses `./benchmarks/default`, the example benchmark kept in this repo for trying things out: a
forward walk, a 1 m radius circle walk, and one test with four 100 N chest pushes (front, back, left, right).
`npm run benchmark init` starts every new benchmark as a copy of it.

Or start in the viewer: the **Tests & Benchmark** panel lists every benchmark the dev server knows (the one
`npm run dev` opened and each folder under `./benchmarks/`). **New benchmark** asks for a
folder name and an optional title and creates an empty `./benchmarks/<name>/` (gitignored) (`HPV_BENCHMARKS_DIR` moves that
folder); **Add test** inside an open benchmark opens the editor, and Save writes into that benchmark. Click a
benchmark to open it, double-click it to run its tests. The folder is the same working copy `npm run benchmark init` makes, so
`npm run benchmark <policy> ./benchmarks/<name>` and `npm run hf publish` work on it as above.

#### Editing `benchmark.yaml` in the viewer

The gear on a benchmark's row in **Tests & Benchmark** opens **Benchmark settings** (not shown in static builds):

- **Settings** tab: title, description, version, the `defaults` (repeats, seed, timeout, action delay, initial joint
  noise), the `tests` selection (all tests, a category or one test, each with an optional repeats override) and the
  leaderboard `tasks` (id, metric, an optional category or tag scope). A scope that is not a plain category or tag
  is shown read-only and kept as written.
- **benchmark.yaml** tab: the file itself, for anything the form does not cover (`harness`, `requires`,
  `reference_policies`). Saving here replaces the file with this text, so form changes not yet saved are dropped.
- Saving applies the same checks as `npm run benchmark`. An invalid result is not written and every problem is
  listed. A selector that matches no test in the benchmark is a warning: the file is written and the dialog stays
  open to show it. If the file changed on disk after the dialog loaded it, the save is refused; reopen the dialog.
- The form changes only the keys you edit, so the file's comments and layout stay. When an edit can move a score
  (repeats, seed, timeout, randomisation, tests or tasks), the dialog offers **Bump to N+1**: task ids end in `_v<version>`, so old and
  new numbers never share a leaderboard.

These settings drive both `npm run benchmark` and the app's **Run Benchmark**
([Benchmarking](benchmarking.md#in-the-app)).

In the editor a test is saved as **Category / Test name** (the test id `<category>/<name>`). A new category
gets its own `data/<category>/test.jsonl` (and, once published, its own dataset config). Deleting a category's last test removes it. A category only runs if `benchmark.yaml` selects it (the
starter's `{ all: true }` selects everything) and only gets a leaderboard if a task scopes it.

The editor's **Environment** panel sets a test's terrain (type and parameters), foot friction (scene default, wet,
icy or custom) and the gait-symmetry opt-in. A terrain test shows a top view (course, spawn area, commanded path)
and a side profile, with the same spawn error and path warnings `npm run benchmark` gives; Save is disabled while
the course overlaps the spawn. **Apply to viewer** loads the course into the 3D view.

To appear as a Hub benchmark, `eval.yaml`'s `evaluation_framework: humanoid-policy-viewer` must be in the Hub's
list of frameworks (a pull request to `huggingface/huggingface.js`, `packages/tasks/src/eval.ts`), and the
dataset must be allow-listed by Hugging Face (beta). Until then results still land in model repos; they just are
not aggregated into a leaderboard.
