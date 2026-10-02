# Model library

Checkpoints that live outside `public/` are served by the dev server under
`/model-library/<root>/...` and listed at `/api/models`.

By default the library is the `models/` folder next to `package.json`: put a
checkpoint folder in it and `npm run dev` lists it (see the layout below and
`models/README.md`). Everything in `models/` except its README is git-ignored, and
it sits outside `public/`, so checkpoints there are never committed or copied into
`dist/`.

A repo that embeds the viewer can point it elsewhere with environment variables
(use absolute paths):

| Variable | Meaning |
|---|---|
| `HPV_MODEL_LIBRARY_DIR` | Directory that contains the model root folders (default: this directory) |
| `HPV_MODEL_ROOTS` | Comma-separated folder names under that directory (default: `models`). Set it empty to turn the library off |
| `HPV_BENCHMARK_RUNS_DIR` | Where saved benchmark runs are listed/read/written (default `benchmark_runs/` in this directory) |

For example:

```bash
HPV_MODEL_LIBRARY_DIR=/abs/path/to/repo HPV_MODEL_ROOTS=checkpoints npm run dev
```

serves every `.onnx` under `/abs/path/to/repo/checkpoints/` at `/model-library/checkpoints/...`,
instead of `models/`. A root is a single folder name, not a path with slashes.

## Layout

Each checkpoint is a folder `<root>/<model>/` holding one or more `.onnx` files
(at any depth) and, in the folder itself or its `params/`, the training run's
`env.yaml` and `agent.yaml` (see [Policy config](policy-config.md)). Every `.onnx`
becomes a `ckpt:<root>/<model>/...` entry in the policy dropdown and in the
benchmark panel. An `.onnx` placed directly in a root, `<root>/policy.onnx`, is
its own checkpoint and takes its `env.yaml` from the root folder.

`npm run hf` uses this mechanism for its downloads, with its own cache as the
library, and for a local folder, which becomes a root of its own: see
[Run a policy from Hugging Face](huggingface.md). While it runs, `models/` is
not served.
