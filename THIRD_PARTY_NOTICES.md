# Third-party notices

Thanks to the projects and dataset creators that make this viewer possible.
Third-party components and assets retain their respective licenses.

## Code and libraries

- **[Three.js](https://github.com/mrdoob/three.js/tree/r151)** — MIT,
  copyright © 2010–2023 three.js authors. The viewer includes a modified
  `Reflector.js`. See [license](LICENSES/Three.js-MIT.txt).
- **[MuJoCo](https://github.com/google-deepmind/mujoco)** / `mujoco-js` —
  [Apache-2.0](LICENSES/Apache-2.0.txt).
- **MuJoCo WASM community** — acknowledgements to
  [zalo/mujoco_wasm](https://github.com/zalo/mujoco_wasm) and
  [stillonearth/MuJoCo-WASM](https://github.com/stillonearth/MuJoCo-WASM).
  See the [zalo/mujoco_wasm MIT license](LICENSES/MuJoCo-WASM-MIT.txt).

Other direct dependencies are listed below. Preserve the applicable license
and NOTICE files when redistributing bundled dependencies.

| Packages | License |
| --- | --- |
| `onnxruntime-web`, `vue`, `vuetify`, `chart.js`, `vue-chartjs`, `katex`, `vatex`, `vue-mathjax` | MIT |
| `mathjax-vue3`, `vue-mathjax-next` | ISC |
| `@mdi/font`, `@playwright/test` | Apache-2.0 |
| `@fontsource/roboto` | SIL Open Font License 1.1 |
| `@vitejs/plugin-vue`, `globals`, `sass-embedded`, `unplugin-fonts`, `unplugin-vue-components`, `vite`, `vite-plugin-vuetify` | MIT |

## Robot assets

The G1 robot description and meshes in `public/examples/scenes/g1/` are from
Unitree Robotics, with scene adaptations for this viewer. See
[Unitree's robot descriptions](https://github.com/unitreerobotics/unitree_ros)
and the [upstream BSD-3-Clause notice](LICENSES/Unitree-BSD-3-Clause.txt).

The Asimov robot description and meshes in `public/examples/scenes/asimov-1/`
are a git submodule of
[menloresearch/asimov-1](https://github.com/menloresearch/asimov-1), licensed
under CERN-OHL-S-2.0. They are not covered by this project's BSD-3-Clause
license; see the license in that repository.

## Motion examples

Third-party motion data remains subject to its original dataset licenses.

## Policy weights

`public/examples/checkpoints/g1/policy_latest.onnx` was trained by Qingzhou Lu
and is released under the project's [BSD-3-Clause license](LICENSE).
This does not change the terms of the source datasets.

`public/examples/checkpoints/asimov/model_aug_18_1/` was trained by Menlo
Research Pte. Ltd. and is released under the project's
[BSD-3-Clause license](LICENSE).
