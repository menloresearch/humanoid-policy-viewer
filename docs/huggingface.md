# Run a policy from Hugging Face

```bash
npm run hf <model>

# example
npm run hf Menlo/asimov1-locomotion-0818
```

`<model>` is the Hugging Face repo id (`org/name`) or its URL, for example
`https://huggingface.co/Menlo/asimov1-locomotion-0818`. Capitalisation does not
matter.

This works from a fresh clone. On the first run it installs the npm dependencies
(`npm ci`) and fetches the Asimov robot model submodule if either is missing (it
needs `git` and `bash` for the latter). Then it downloads the repo's `.onnx`,
`env.yaml` and `agent.yaml`, [checks them](#checks), starts the dev server and
opens the viewer with that policy selected.

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

## What the repo needs to contain

- An ONNX policy. Every `.onnx` in the repo is downloaded; `policy.onnx` is the
  one selected when present, otherwise the first by name. A repo with no `.onnx`
  is an error.
- The training run's `env.yaml`, at the repo root or under `params/`. Required.
  It supplies the gains, action scale and torque limits; see
  [Policy config](policy-config.md).
- The training run's `agent.yaml`, same places. Recommended: the viewer does not
  read it, but it records the training run.
- `library_name: asimov` in the model card metadata.

## Supported policies

The viewer runs Asimov velocity-tracking policies with one fixed interface,
the one `cyclotron` trains. A policy whose ONNX input or output size does
not match is refused when it loads, with a message saying which size differs.

**Output:** 23 joint position actions, in this order. The target for each
joint is `default_joint_pos + action_scale * action`, with both read from
`env.yaml`.

```
left_hip_pitch   left_hip_roll   left_hip_yaw   left_knee   left_ankle_pitch   left_ankle_roll
right_hip_pitch  right_hip_roll  right_hip_yaw  right_knee  right_ankle_pitch  right_ankle_roll
waist_yaw
right_shoulder_pitch  right_shoulder_roll  right_shoulder_yaw  right_elbow  right_wrist_yaw
left_shoulder_pitch   left_shoulder_roll   left_shoulder_yaw   left_elbow   left_wrist_yaw
```

**Input:** 78 values per step at 50 Hz, in this order:

| Values | Observation | Scale |
|---|---|---|
| 3 | Base angular velocity (IMU gyro, body frame) | 0.25 |
| 3 | Projected gravity (body frame) | 1 |
| 3 | Velocity command `vx, vy, wz` | 1 |
| 23 | Joint positions relative to `default_joint_pos`, in motor-slot order (below) | 1 |
| 23 | Joint velocities, in motor-slot order | 0.1 |
| 23 | Previous action, in the output order above | 1 |

Joint positions and velocities are grouped by motor slot rather than in the
output order. Each group lists output indices from the order above:

| Slot | Output indices |
|---|---|
| 0-1 | 0, 1, 6, 7, 12, 13, 14, 18, 19 |
| 2-3 | 2, 3, 8, 9, 15, 16, 20, 21 |
| 4-5 | 4, 5, 10, 11, 17, 22 |

The recipe lives in `public/examples/checkpoints/asimov/reference_policy_config.json`
and is not read from `env.yaml` yet, so a policy trained on a different
recipe of the same size would load but behave wrongly. Base linear velocity,
foot contacts and other quantities the real robot cannot measure are not
inputs; a policy that needs them has to estimate them inside the ONNX.

## Checks

After downloading, the script checks the repo the way model-checkpoint's CI gate
(`ci/validate-checkpoint-configs.mjs`) checks a checkpoint before benchmarking it:

| Check | If it fails |
|---|---|
| `env.yaml` is present | **Error**: the run is refused and nothing starts. `env.yaml` supplies the policy's gains, action scale and torque limits, and guessing them gives a simulation that does not match the trained policy |
| `env.yaml` is complete | Warning. It is parsed against the Asimov joint list; missing actuators, gains, action scale or default pose are reported |
| `env.yaml` declares a numeric `effort_limit` | Warning: joint torque would be unclamped |
| `agent.yaml` is present and is real YAML | Warning. Not empty, no tab indentation, has top-level keys; the viewer never reads it |
| Model card has `library_name: asimov` | Warning: the repo may not be an Asimov policy |

Warnings are printed and the viewer still starts. An error exits with status 1
before the dev server starts; the download stays cached. When everything passes
it prints `Checked env.yaml and agent.yaml: OK`. Unlike the CI gate, a
checkpoint's own `tracking_policy.json` is not consulted: the joint list always
comes from `reference_policy_config.json`.

When the viewer loads the policy, it also checks the ONNX model's input and
output sizes against the [supported interface](#supported-policies) (78 in,
23 out). A mismatch is shown as an error in the policy panel and the policy is
not run.

## Where downloads go

Outside the repo, so they are never committed or built into `dist/`:

```
~/.cache/humanoid-policy-viewer/hf/<org>__<name>/
├── policy.onnx
├── env.yaml
├── agent.yaml
└── .hf-meta.json      (the pinned commit and file list, used to decide when to re-download)
```

Downloads are cached per repo and refreshed when the revision's commit changes;
offline, the cached copy is used. Delete the folder to clear it.

## How it works

`npm run hf` (`scripts/run-hf-model.mjs`, download logic in `scripts/hfModel.mjs`,
checks in `scripts/checkpointChecks.mjs`) treats the cache as a
[model library](model-library.md), so the download is served under
`/model-library/hf/<org>__<name>/` and listed in the policy dropdown like any
other checkpoint. It then opens the page with a
`?policy=ckpt:hf/<org>__<name>/policy.onnx` query parameter, which
`selectPolicyFromUrl` in `src/views/Demo.vue` uses to select that entry once the
catalog has loaded. The parameter only resolves on a server started this way.
