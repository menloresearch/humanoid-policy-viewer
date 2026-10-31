# Policy config vs training artifacts

The viewer runs out of the box on a bundled Asimov policy
(`public/examples/checkpoints/asimov/model_aug_18_1/`), no policy library needed.
Three kinds of file describe a policy, and they have different owners:

| File | What it is | Who owns it | Read by the viewer? |
|---|---|---|---|
| `reference_policy_config.json` (in `public/examples/checkpoints/asimov/`) | How to run an Asimov velocity policy **in simulation**: observation recipe, joint order, control rate, ONNX input shape, plus fallback values | the viewer | yes, always |
| `env.yaml` (next to the `.onnx`, in `params/` or at its root) | **Training artifact**: snapshot of the Isaac Lab / mjlab environment the policy was trained in | the training run | yes, for the settings below |
| `agent.yaml` (same place) | **Training artifact**: agent / PPO hyperparameters | the training run | no |

## What is recorded where

| Setting | `reference_policy_config.json` | `env.yaml` | What the viewer uses |
|---|---|---|---|
| ONNX path and input shape | yes | - | the JSON (library policies swap in their own `.onnx`) |
| Joint order (`policy_joint_names`) | yes | `actions.joint_pos.joint_names` | the JSON; a policy whose `env.yaml` lists the action joints in another order is refused |
| Observation recipe (`obs_config`) | fallback only | `observations.policy` | **`env.yaml`** when it has `observations.policy` (see [Supported policies](huggingface.md#supported-policies)), else the JSON |
| `policy_hz`, `action_lpf_hz`, `kd_ff`, `control_type` | yes | `policy_hz` = 1 / (`dt` x `decimation`) | the JSON; the policy always runs at 50 Hz, and one trained at another rate is refused |
| `stiffness`, `damping` | fallback only | yes | **`env.yaml`** |
| `action_scale`, `default_joint_pos` | fallback only | yes | **`env.yaml`** |
| Joint position target clip | - | `actions.joint_pos.clip` | **`env.yaml`**: each joint's target is clipped as in training; without it, targets are not clipped |
| Action delay range | fallback only | if declared | `env.yaml` if declared, else the JSON |
| Command limits (`vx`, `vy`, `wz`) | - | if declared | `env.yaml` if declared, else a global default |
| Torque limits | - | `effort_limit` (`actuator_effort_limit` since Isaac Lab 3.0) | **`env.yaml`**; without it torque is unclamped and the console warns |
| Start pose (base `pos`, `rot`, velocities, joint velocities) | - | `scene.robot.init_state` | **`env.yaml`**; without it the robot starts upright at 0.614 m. Isaac Lab 3.0 writes `rot` as [x, y, z, w], which the viewer reorders to MuJoCo's [w, x, y, z]. A benchmark test's `start`, or the viewer's Start pose, replaces parts of it |

## Precedence rule

**For every setting `env.yaml` records, `env.yaml` wins over the JSON.** It is
never the other way round. The JSON's values for those settings are only a
fallback, used when no `env.yaml` is found beside the `.onnx` (the console warns
for policy-library policies). Settings `env.yaml` does not feed the viewer, such as
the joint order and rates, always come from the JSON. They are checked against
`env.yaml` instead: a policy trained at another rate (`sim.dt` x `decimation`
other than 0.02 s), or whose `actions.joint_pos` lists the joints in another
order, without `preserve_order` or without `use_default_offset`, is refused
when it loads, naming the difference.

## Where `env.yaml` is looked up

In the folder the `.onnx` sits in, as `params/env.yaml` first and then
`env.yaml`. For a [policy-library](policy-library.md) policy that is its
`<root>/<policy>/` folder. The viewer maps the YAML's joint action scale,
actuator stiffness/damping (one value per actuator group, or a map per joint
pattern) and initial joint pose to `policy_joint_names`, builds the observation
recipe from `observations.policy`, and
applies the actuators' `effort_limit` (Isaac Lab 3.0: `actuator_effort_limit`)
as each joint's torque cap. If there is no
`env.yaml`, the JSON arrays are used and torque is unclamped.

## Per-policy `tracking_policy.json`

A policy may also ship a `tracking_policy.json` (looked up like
`env.yaml`: `params/` first, then the policy folder). Its fields replace the
base policy config's, with `onnx` merged one level deep so the ONNX path still
follows the policy. `npm run hf` downloads the file from a Hugging Face repo
when present. Policies without one load as before.

Recurrent policies (LSTM, GRU, frame history) do not need one: the viewer finds
their state inputs and the outputs that feed them in the ONNX itself (see
[Supported policies](huggingface.md#supported-policies)). Older exports whose
`tracking_policy.json` declares `"in_keys": ["policy", "is_init", "adapt_hx"]`
still load; only the first `in_keys` entry, the observation, is used to feed the
ONNX.

## The robot model is separate

The robot model is in neither file. It comes from the `asimov-1` submodule, and
the viewer adds actuators at load (`src/simulation/sceneOverlay.js`). Torque
limits deliberately follow training, not the robot model, whose limits are
hardware maxima that usually differ. See `public/examples/scenes/README.md`.

## Shipping a policy you want to benchmark

Ship `env.yaml` (and `agent.yaml` as a record of the training run) with every
policy, and make sure `env.yaml` explicitly declares stiffness, damping and
`effort_limit` (or `actuator_effort_limit`) for every joint in `policy_joint_names`. Otherwise the viewer
silently falls back to the JSON's gains and unclamped torque, so every
policy would be benchmarked with the same gains. A
CI job can enforce this before running the benchmark.
