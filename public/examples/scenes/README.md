# Scenes

MJCF files + meshes staged into MuJoCo's in-browser filesystem. Every file
used by a scene must be listed in `files.json` (regenerate it with
`python3 generate_index.py` after adding files) or the loader won't fetch it.

## `asimov-1/` — the Asimov robot (git submodule)

The canonical Asimov v1 model, from
[`menloresearch/asimov-1`](https://github.com/menloresearch/asimov-1)
(`sim-model/xmls/asimov_1.xml` + `sim-model/assets/meshes/`). It is a submodule
so the viewer always runs the robot's source-of-truth model instead of a copy
that can drift. Never edit it here; change it upstream and bump the submodule.

Only `sim-model/` is needed, so check it out sparsely (the repo also carries CAD
and electrical files that would otherwise end up in `dist/`). `scripts/init-asimov-1.sh`
does this; `generate_index.py` only indexes `sim-model/`
either way.

`asimov_1.xml` defines no actuators (the training sim adds them in Python).
`src/simulation/sceneOverlay.js` splices one torque motor per `class="motor"`
joint into the XML in memory just before it is compiled. Those motors start
unclamped: each checkpoint's torque limits come from the `effort_limit` in its
training `env.yaml` (applied on policy load), because the robot model's own
limits are hardware maxima that usually differ from what a policy trained with.

This is the scene `MuJoCoDemo.init()` loads by default (`src/simulation/main.js`)
and what the "Asimov (bundled example)" entry in the policy dropdown (`src/views/Demo.vue`)
loads via its `scenePath`.

## `g1/`

Unitree G1 scene. Not currently wired to any policy entry in
`src/views/Demo.vue` — present as a reference asset only.
