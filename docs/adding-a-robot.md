# Add your own robot, policy and motions

## 1. Add the MJCF and assets

- Create `public/examples/scenes/<robot>/`.
- Put your MJCF as `public/examples/scenes/<robot>/<robot>.xml`.
- Add all meshes/textures used by the MJCF into the same folder.
- Regenerate the file index with `python3 public/examples/scenes/generate_index.py`
  so every file is listed in `public/examples/scenes/files.json`. The loader only
  preloads listed files into `/working/` in the wasm filesystem. (The script
  indexes `.xml`, `.png`, `.stl` and `.obj`, and for the `asimov-1` submodule only
  its `sim-model/` folder.)

## 2. Add the policy config and ONNX

- Create `public/examples/checkpoints/<robot>/tracking_policy.json`.
- Place the ONNX model at `public/examples/checkpoints/<robot>/tracking_policy.onnx`,
  or put it in a [model library](model-library.md) root when you want its
  training artifacts (`env.yaml`) and benchmark runs beside the model.
- In the JSON, make sure these fields are correct:
  - `onnx.path` points to your ONNX file, for example
    `./examples/checkpoints/<robot>/tracking_policy.onnx` or
    `/model-library/<root>/<checkpoint>/policy.onnx`
  - `policy_joint_names` matches the joint names in your MJCF actuators
  - `obs_config` uses observation names that exist in `src/simulation/observationHelpers.js`
  - `action_scale`, `stiffness`, `damping`, and `default_joint_pos` lengths match `policy_joint_names`
- If your policy uses different observations than the built-in ones, adapt
  `src/simulation/observationHelpers.js`, and modify `src/simulation/policyRunner.js`
  to control the robot.

### Training artifacts

Next to the ONNX, ship the training run's `env.yaml` (and `agent.yaml` as a
record). The viewer reads it when loading the policy and it overrides the
matching values in the JSON, including torque limits. How that works, and what
`env.yaml` must declare for benchmarking, is in [Policy config](policy-config.md).

## 3. (Optional) Add tracking motions

- Add an index at `public/examples/checkpoints/<robot>/motions.json`.
- Put per-motion clips in `public/examples/checkpoints/<robot>/motions/`.
- In `tracking_policy.json`, set `tracking.motions_path` to the index file.
- The app downloads all motion clips listed in the index when the policy loads.

The index has this shape:

- `format`: `tracking-motion-index-v1`
- `base_path`: relative path to the motions folder, for example `./motions`
- `motions`: list of `{ name, file }` entries

Each motion clip file must include a `default` clip overall, and each clip contains:

- `joint_pos` or `jointPos`: per-frame joint arrays
- `root_pos` or `rootPos`: per-frame root positions
- `root_quat` or `rootQuat`: per-frame root quaternions `[w, x, y, z]`

## 4. Point the app at your robot and policy

Update `src/simulation/main.js`:

- `defaultPolicy = './examples/checkpoints/<robot>/tracking_policy.json'`
- `await this.reloadScene('<robot>/<robot>.xml')`
- `await this.reloadPolicy(defaultPolicy)`

Update the policy entries in `src/views/Demo.vue` if the UI selector should expose
it. If you keep multiple robots around, expose them through that selector and call
`demo.reloadScene(...)` and `demo.reloadPolicy(...)` from there.
