# Humanoid Policy Viewer

Single-page Vue 3 + Vuetify app that runs a MuJoCo WebAssembly scene in the
browser and drives it with an ONNX policy. This checkout defaults to a bundled
Asimov policy (`public/examples/checkpoints/asimov/`, configured by
`reference_policy_config.json`), running on the canonical Asimov model from the
`asimov-1` git submodule (see `public/examples/scenes/README.md`).

Demos: [Humanoid Policy Viewer](https://motion-tracking.axell.top/), [GentleHumanoid Web Demo](https://gentle-humanoid.axell.top/)

## Quick start

```bash
# fetch the Asimov robot model (git submodule, sim-model/ only)
./scripts/init-asimov-1.sh

npm install
npm run dev
```

The Vite dev server is configured for localhost only. Open the printed local
URL, usually `http://127.0.0.1:3000/` or the next available port. To also
serve a repo's checkpoint folders, see [Model library](#model-library).

### Run a policy from Hugging Face

```bash
npm install
npm run hf Menlo/asimov1-locomotion-0818
```

This downloads the repo's `.onnx` and `env.yaml`, starts the dev server and
opens the viewer with that policy selected. The first run also fetches the
Asimov robot model if it is missing. A Hub URL works in place of the id.

Options go after a `--`, because npm keeps any flag written before it for
itself: `npm run hf Menlo/asimov1-locomotion-0818 -- --no-open`.

| Option / variable | Meaning |
|---|---|
| `--revision <ref>` | Branch, tag or commit (default `main`) |
| `--port <n>` | Dev server port (default 3000, or the next free one) |
| `--no-open` | Do not open a browser window |
| `HF_TOKEN` | Access token, for private repos |
| `HF_ENDPOINT` | Alternative Hub endpoint (default `https://huggingface.co`) |
| `HPV_CACHE_DIR` | Download cache (default `~/.cache/humanoid-policy-viewer`) |

Downloads are cached per repo and refreshed when the revision's commit changes;
offline, the cached copy is used. The repo should follow the layout of the
policies in [Policy config vs training artifacts](#policy-config-vs-training-artifacts):
an ONNX policy with the training run's `env.yaml` next to it, which supplies the
gains, action scale and torque limits. The page selects the policy through its
`?policy=` query parameter, which the script fills in when it opens the browser.

## Project structure

- `src/views/Demo.vue` - UI controls for the live demo
- `src/simulation/main.js` - bootstraps MuJoCo, Three.js renderer, policy loop, and metric sampling hook
- `src/simulation/mujocoUtils.js` - scene/policy loading utilities and filesystem preloading
- `src/simulation/policyRunner.js` - ONNX inference wrapper and observation pipeline
- `public/sim-metrics.*` - metric recorder UI and browser-side metric calculations
- `public/examples/scenes/` - MJCF files + meshes staged into MuJoCo's MEMFS; the Asimov robot is the `asimov-1/` git submodule (see its `README.md`)
- `public/examples/checkpoints/` - policy config JSON, bundled ONNX files, and motion clips
- an optional model library (see [Model library](#model-library)) served by local Vite middleware under `/model-library/`

## Policy config vs training artifacts

The viewer runs out of the box on a bundled Asimov policy
(`public/examples/checkpoints/asimov/model_aug_18_1/`), no model library needed.
Three kinds of file describe a policy, and they have different owners:

| File | What it is | Who owns it | Read by the viewer? |
|---|---|---|---|
| `reference_policy_config.json` (in `public/examples/checkpoints/asimov/`) | How to run an Asimov velocity policy **in simulation**: observation recipe, joint order, control rate, ONNX input shape, plus fallback values | the viewer | yes, always |
| `env.yaml` (next to the `.onnx`, in `params/` or at its root) | **Training artifact**: snapshot of the Isaac Lab / mjlab environment the policy was trained in | the training run | yes, for the settings below |
| `agent.yaml` (same place) | **Training artifact**: agent / PPO hyperparameters | the training run | no |

### What is recorded where

| Setting | `reference_policy_config.json` | `env.yaml` | What the viewer uses |
|---|---|---|---|
| ONNX path and input shape | yes | - | the JSON (catalog checkpoints swap in their own `.onnx`) |
| Joint order (`policy_joint_names`) | yes | `actions.joint_pos.joint_names` | the JSON (not read from `env.yaml` yet) |
| Observation recipe (`obs_config`) | yes | `observations.policy` | the JSON (not read from `env.yaml` yet) |
| `policy_hz`, `action_lpf_hz`, `kd_ff`, `control_type` | yes | `policy_hz` = 1 / (`dt` x `decimation`) | the JSON |
| `stiffness`, `damping` | fallback only | yes | **`env.yaml`** |
| `action_scale`, `default_joint_pos` | fallback only | yes | **`env.yaml`** |
| Action delay range | fallback only | if declared | `env.yaml` if declared, else the JSON |
| Command limits (`vx`, `vy`, `wz`) | - | if declared | `env.yaml` if declared, else a global default |
| Torque limits | - | `effort_limit` | **`env.yaml`**; without it torque is unclamped and the console warns |

### Precedence rule

**For every setting `env.yaml` records, `env.yaml` wins over the JSON.** It is
never the other way round. The JSON's values for those settings are only a
fallback, used when no `env.yaml` is found beside the `.onnx` (the console warns
for model-library checkpoints). Settings `env.yaml` does not feed the viewer, such as
the observation recipe, joint order and rates, always come from the JSON, so
keep it consistent with the training run (the tests check that the joint order
matches the bundled `env.yaml`).

The robot model itself is not in either file. It comes from the `asimov-1`
submodule, and the viewer adds actuators at load (`src/simulation/sceneOverlay.js`).
Torque limits deliberately follow training, not the robot model, whose limits are
hardware maxima that usually differ.


## Simulation metrics

The viewer includes a **Record Simulation Metrics** button under **Velocity Command**.
The logic is adapted from `asimov-viewer/public/sim-metrics.*` and
`asimov-viewer/README.md`.

When clicked, the recorder runs a fixed scripted evaluation, captures one sample
per policy step, computes summary metrics in the browser, and posts the HTML and JSON report files
to the local Vite endpoint at `/simulation-metrics/report`.

Reports are saved beside the checkpoint's model in the model library (see
[Model library](#model-library)). For a checkpoint in `<root>/<checkpoint>/`,
output is written to:

```
<root>/<checkpoint>/sim_metric.html
<root>/<checkpoint>/sim_metric.json
```

Policy configs that point to bundled files under `public/examples/checkpoints`
can still run in the viewer, but metric report saving is only supported for
models whose `onnx.path` resolves under `/model-library/`.

### Scripted evaluation

The command-tracking portion runs these velocity segments:

| Segment | Command | Duration |
|---|---:|---:|
| Forward slow | `vx = 0.3 m/s` | 5 s |
| Forward fast | `vx = 0.8 m/s` | 8 s |
| Lateral negative | `vy = -0.5 m/s` | 8 s |
| Lateral positive | `vy = 0.5 m/s` | 8 s |
| Turn negative | `wz = -0.6 rad/s` | 8 s |
| Turn positive | `wz = 0.6 rad/s` | 8 s |

After command tracking, it runs push tests from front, back, left, and right
using increasing base-velocity impulses.

### Recorded trace

The JSON report stores the full trace under `trace.samples`. Each sample can
include:

- Time, phase, segment, and push-trial metadata.
- Command velocity and measured root/base linear and angular velocity.
- Root position and orientation.
- Joint positions, joint velocities, policy actions, and action deltas.
- Foot contact/support estimates when available.
- Expected trajectory, actual trajectory, drift, and fallen/tumbling state.

### Metrics summary

- Command tracking RMSE: root-mean-square velocity error for `vx`, `vy`, and `wz`; lower is better.
- Recoverable push: largest injected base velocity impulse survived per direction; higher is better.
- Balance/support margin: approximate root support margin from contacted foot positions when available.
- Gait symmetry: browser-side left/right mirror RMSE plus foot-contact duty asymmetry over the first 13 seconds of x-only walking.
- Action smoothness: policy action delta and jerk-like third-difference estimates; lower is usually smoother.
- Drift: expected X/Y path from command integration versus actual root X/Y path; lower is better.
- Top-down trajectory: HTML plot comparing actual and expected floor-plane paths.

## Headless benchmarking

The in-app **Tests & Benchmark** panel (`src/views/Demo.vue`) runs the
`benchmark/*.json` velocity-command tests against one or more policies and
reports metrics via `src/simulation/benchmarkRunner.js`. To run the same
sweep outside a browser tab:

```bash
# Every discovered checkpoint x every committed benchmark/*.json test
npm run benchmark -- --out benchmark_runs/run.json

# One policy, one test (fast smoke check)
npm run benchmark -- \
  --policies "ckpt:<root>/<model>/policy.onnx" \
  --tests backward_walk.json \
  --out benchmark_runs/run.json
```

"Discovered" means the checkpoints under the model library (see
[Model library](#model-library)); `--policies` skips discovery.

This boots a Vite dev server (the `/api/models`, `/api/sequences`, and
`/api/benchmarks` endpoints only exist under `vite dev`, not `vite build` +
`preview`), drives it with headless Chromium via Playwright, and calls the
same `window.__runHeadlessBenchmark(...)` hook the confirm-dialog-driven UI
flow uses (`Demo.vue`'s `runHeadlessBenchmark()` method). See
`scripts/run-benchmark.mjs`.

A single page can only host one live `MuJoCoDemo` (one canvas, one MuJoCo
WASM instance, one ONNX Runtime session), so policies are benchmarked
sequentially within a run. Parallelism comes from running multiple shards,
each its own OS process with its own dev server + browser; `--policies` and
`--tests` make it straightforward to partition a sweep across shards.

Sharding, merging shard outputs into one report, PR comments and deployment
belong to whatever repo embeds the viewer.

## Model library

Checkpoints that live outside `public/` are served by the dev server under
`/model-library/<root>/...` and listed at `/api/models`. The viewer assumes
nothing about the repo around it; the embedding repo opts in with environment
variables (use absolute paths):

| Variable | Meaning |
|---|---|
| `HPV_MODEL_LIBRARY_DIR` | Directory that contains the model root folders |
| `HPV_MODEL_ROOTS` | Comma-separated folder names under that directory |
| `HPV_BENCHMARK_RUNS_DIR` | Where saved benchmark runs are listed/read/written (default `benchmark_runs/` in this directory) |

With none of them set, there is no model library. For example:

```bash
HPV_MODEL_LIBRARY_DIR=/abs/path/to/repo HPV_MODEL_ROOTS=models npm run dev
```

serves every `.onnx` under `/abs/path/to/repo/models/` at `/model-library/models/...`.

## Add your own robot, policy and motions

1. Add your MJCF + assets.
   - Create `public/examples/scenes/<robot>/`.
   - Put your MJCF as `public/examples/scenes/<robot>/<robot>.xml`.
   - Add all meshes/textures used by the MJCF into the same folder.
   - Append every file path to `public/examples/scenes/files.json` so the
     loader can preload them into `/working/` in the wasm filesystem.

2. Add your policy config and ONNX.
   - Create `public/examples/checkpoints/<robot>/tracking_policy.json`.
   - Place the ONNX model at `public/examples/checkpoints/<robot>/tracking_policy.onnx`, or put it in a model library root (see [Model library](#model-library)) when you want its training artifacts (`env.yaml`) and metric reports beside the model.
   - In the JSON, make sure these fields are correct:
     - `onnx.path` points to your ONNX file, for example `./examples/checkpoints/<robot>/tracking_policy.onnx` or `/model-library/<root>/<checkpoint>/policy.onnx`
     - `policy_joint_names` matches the joint names in your MJCF actuators
     - `obs_config` uses observation names that exist in `src/simulation/observationHelpers.js`
     - `action_scale`, `stiffness`, `damping`, and `default_joint_pos` lengths match `policy_joint_names`
   - For an ONNX file, the viewer reads `params/env.yaml` (or `env.yaml`) from the folder it sits in when loading the policy (for a model-library checkpoint, its `<root>/<model>/` folder). It maps the YAML's joint action scale, actuator stiffness/damping, and initial joint pose to `policy_joint_names`. These values override the matching arrays in `reference_policy_config.json` for that checkpoint (see [Policy config vs training artifacts](#policy-config-vs-training-artifacts)). If there is no `env.yaml`, the JSON arrays are used. The YAML's actuator `effort_limit` is also applied as each joint's torque cap (training's limit, not the robot model's hardware maximum); without it joint torque is unclamped and the console warns.
   - **Recommended for benchmarking**: ship `env.yaml` (and `agent.yaml` as a record of the training run) with every checkpoint you benchmark, and make sure `env.yaml` explicitly declares stiffness, damping and `effort_limit` for every joint in `policy_joint_names`. Otherwise the viewer silently falls back to the JSON's gains and unclamped torque, the shared-gains mistake `benchmark/METHODOLOGY.md` warns about. A CI job can enforce this before running the suite.
   - You need to adapt the observation helper functions in
     `src/simulation/observationHelpers.js` if your policy uses
     different observations than the built-in ones, and modify `src/simulation/policyRunner.js` to control the robot.

3. (Optional) Add tracking motions.
   - Add an index at `public/examples/checkpoints/<robot>/motions.json`.
   - Put per-motion clips in `public/examples/checkpoints/<robot>/motions/`.
   - In `tracking_policy.json`, set `tracking.motions_path` to the index file.
   - The app downloads all motion clips listed in the index when the policy loads.
   - The index uses this shape:
     - `format`: `tracking-motion-index-v1`
     - `base_path`: relative path to the motions folder, for example `./motions`
     - `motions`: list of `{ name, file }` entries
   - Each motion clip file must include a `default` clip overall and each clip contains:
     - `joint_pos` or `jointPos`: per-frame joint arrays
     - `root_pos` or `rootPos`: per-frame root positions
     - `root_quat` or `rootQuat`: per-frame root quaternions `[w, x, y, z]`

4. Point the app to your robot and policy.
   - Update `src/simulation/main.js`:
     - `defaultPolicy = './examples/checkpoints/<robot>/tracking_policy.json'`
     - `await this.reloadScene('<robot>/<robot>.xml')`
     - `await this.reloadPolicy(defaultPolicy)`
   - Update `src/views/Demo.vue` policy entries if the UI selector should expose it.

If you keep multiple robots around, expose them through the selector in
`src/views/Demo.vue` and call `demo.reloadScene(...)` and
`demo.reloadPolicy(...)` from there.

## License and acknowledgements

This repository is a fork of `humanoid-policy-viewer` by
[Qingzhou Lu (Axellwppr)](https://github.com/Axellwppr), a motion-tracking viewer for the Unitree G1, and still carries that viewer's G1
scene and motion-tracking code. The upstream project's demos:
[Humanoid Policy Viewer](https://motion-tracking.axell.top/),
[GentleHumanoid Web Demo](https://gentle-humanoid.axell.top/).

Both the original project and Menlo Research's additions are licensed under the
[BSD 3-Clause License](LICENSE):

- **Original code**, author-created motions, and the author-trained policy
  weights at `public/examples/checkpoints/g1/policy_latest.onnx` — copyright
  © 2026 Qingzhou Lu.
- **Menlo Research modifications** — changes made after upstream commit
  `0490320`, including Asimov support, the benchmark suite, and Hugging Face
  model loading — copyright © 2026 Menlo Research Pte. Ltd.

Third-party code, libraries, robot descriptions, meshes, and third-party motion
data are not relicensed by this grant. They remain subject to their respective
terms; see [Third-party notices](THIRD_PARTY_NOTICES.md) for sources and scope.
This includes the Asimov robot description in the `asimov-1` submodule, which is
licensed under CERN-OHL-S-2.0.

This viewer builds on MuJoCo, the MuJoCo WASM community, Three.js, ONNX Runtime,
Vue, and Vuetify. We also thank Unitree Robotics and the creators of the motion
datasets used in the examples. If you build on this viewer, a link back to this
repository is appreciated.
