# Policy config vs training artifacts

The viewer runs out of the box on a bundled Asimov policy
(`public/examples/checkpoints/asimov/model_aug_18_1/`), no model library needed.
Three kinds of file describe a policy, and they have different owners:

| File | What it is | Who owns it | Read by the viewer? |
|---|---|---|---|
| `reference_policy_config.json` (in `public/examples/checkpoints/asimov/`) | How to run an Asimov velocity policy **in simulation**: observation recipe, joint order, control rate, ONNX input shape, plus fallback values | the viewer | yes, always |
| `env.yaml` (next to the `.onnx`, in `params/` or at its root) | **Training artifact**: snapshot of the Isaac Lab / mjlab environment the policy was trained in | the training run | yes, for the settings below |
| `agent.yaml` (same place) | **Training artifact**: agent / PPO hyperparameters | the training run | no |

## What is recorded where

| Setting | `reference_policy_config.json` | `env.yaml` | What the viewer uses |
|---|---|---|---|
| ONNX path and input shape | yes | - | the JSON (catalog checkpoints swap in their own `.onnx`) |
| Joint order (`policy_joint_names`) | yes | `actions.joint_pos.joint_names` | the JSON (not read from `env.yaml` yet) |
| Observation recipe (`obs_config`) | fallback only | `observations.policy` | **`env.yaml`** when it has `observations.policy` (see [Supported policies](huggingface.md#supported-policies)), else the JSON |
| `policy_hz`, `action_lpf_hz`, `kd_ff`, `control_type` | yes | `policy_hz` = 1 / (`dt` x `decimation`) | the JSON |
| `stiffness`, `damping` | fallback only | yes | **`env.yaml`** |
| `action_scale`, `default_joint_pos` | fallback only | yes | **`env.yaml`** |
| Action delay range | fallback only | if declared | `env.yaml` if declared, else the JSON |
| Command limits (`vx`, `vy`, `wz`) | - | if declared | `env.yaml` if declared, else a global default |
| Torque limits | - | `effort_limit` | **`env.yaml`**; without it torque is unclamped and the console warns |

## Precedence rule

**For every setting `env.yaml` records, `env.yaml` wins over the JSON.** It is
never the other way round. The JSON's values for those settings are only a
fallback, used when no `env.yaml` is found beside the `.onnx` (the console warns
for model-library checkpoints). Settings `env.yaml` does not feed the viewer, such as
the joint order and rates, always come from the JSON, so
keep it consistent with the training run (the tests check that the joint order
matches the bundled `env.yaml`).

## Where `env.yaml` is looked up

In the folder the `.onnx` sits in, as `params/env.yaml` first and then
`env.yaml`. For a [model-library](model-library.md) checkpoint that is its
`<root>/<model>/` folder. The viewer maps the YAML's joint action scale,
actuator stiffness/damping (one value per actuator group, or a map per joint
pattern) and initial joint pose to `policy_joint_names`, builds the observation
recipe from `observations.policy`, and
applies the actuators' `effort_limit` as each joint's torque cap. If there is no
`env.yaml`, the JSON arrays are used and torque is unclamped.

## Per-checkpoint `tracking_policy.json`

A checkpoint may also ship a `tracking_policy.json` (looked up like
`env.yaml`: `params/` first, then the model folder). Its fields replace the
base policy config's, with `onnx` merged one level deep so the ONNX path still
follows the checkpoint. Recurrent policies (LSTM, GRU, frame history) use it to
declare the recurrent interface:

```json
{"onnx": {"meta": {"in_keys": ["policy", "is_init", "adapt_hx"],
                   "out_keys": ["action", "next,adapt_hx"],
                   "in_shapes": [[[1, 78]], [[1]], [[1, 128]]]}}}
```

The viewer maps `in_keys`/`out_keys` to the ONNX inputs and outputs by position,
starts each episode with `is_init = true` and a 128-float `adapt_hx`, then feeds
`next_adapt_hx` back every step, so the carried state may be any width as long
as the ONNX accepts a 128-float first carry. `npm run hf` downloads the file
from a Hugging Face repo when present. Checkpoints without one load as before.

## The robot model is separate

The robot model is in neither file. It comes from the `asimov-1` submodule, and
the viewer adds actuators at load (`src/simulation/sceneOverlay.js`). Torque
limits deliberately follow training, not the robot model, whose limits are
hardware maxima that usually differ. See `public/examples/scenes/README.md`.

## Shipping a checkpoint you want to benchmark

Ship `env.yaml` (and `agent.yaml` as a record of the training run) with every
checkpoint, and make sure `env.yaml` explicitly declares stiffness, damping and
`effort_limit` for every joint in `policy_joint_names`. Otherwise the viewer
silently falls back to the JSON's gains and unclamped torque, the shared-gains
mistake [`benchmark/METHODOLOGY.md`](../benchmark/METHODOLOGY.md) warns about. A
CI job can enforce this before running the suite.
