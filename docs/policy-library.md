# Policy library

Policies that live outside `public/` are served by the dev server under
`/policy-library/<root>/...` and listed at `/api/policies`.

By default the library is the `policies/` folder next to `package.json`: put a
policy folder in it and `npm run dev` lists it (see the layout below and
`policies/README.md`). Everything in `policies/` except its README is git-ignored, and
it sits outside `public/`, so policies there are never committed or copied into
`dist/`.

`npm run dev` also lists every Hugging Face policy already downloaded (by `npm run hf` or `npm run dev <policy>`), labelled
by its repo id and served from the download cache (`~/.cache/humanoid-policy-viewer/hf/`, or `HPV_CACHE_DIR`).
`npm run dev <org>/<name>[@rev]` downloads a policy first if it is not cached; give several for several. For
example `npm run dev Menlo/asimov1-locomotion-0818 benchmark=datasets/<org>/<name>` opens a Hub policy and a
Hub benchmark together. Setting either variable below turns this off: the library is then exactly what they say.

A repo that embeds the viewer can point it elsewhere with environment variables
(use absolute paths):

| Variable | Meaning |
|---|---|
| `HPV_POLICY_LIBRARY_DIR` | Directory that contains the policy root folders (default: this directory) |
| `HPV_POLICY_ROOTS` | Comma-separated folder names under that directory (default: `policies`). Set it empty to turn the library off |
| `HPV_BENCHMARK_RESULTS_DIR` | Where saved benchmark results are listed/read/written (default `benchmark_results/` in this directory) |

For example:

```bash
HPV_POLICY_LIBRARY_DIR=/abs/path/to/repo HPV_POLICY_ROOTS=checkpoints npm run dev
```

serves every `.onnx` under `/abs/path/to/repo/checkpoints/` at `/policy-library/checkpoints/...`,
instead of `policies/`. A root is a single folder name, not a path with slashes.

## Layout

Each policy is a folder `<root>/<policy>/` holding one or more `.onnx` files
(at any depth) and, in the folder itself or its `params/`, the training run's
`env.yaml` and `agent.yaml` (see [Policy config](policy-config.md)). Every `.onnx`
becomes a `lib:<root>/<policy>/...` entry in the policy dropdown and in the
benchmark panel. An `.onnx` placed directly in a root, `<root>/policy.onnx`, is
its own policy and takes its `env.yaml` from the root folder.

`npm run hf` uses this mechanism for its downloads, with its own cache as the
library, and for a local folder, which becomes a root of its own: see
[Run a policy from Hugging Face](huggingface.md). While it runs, `policies/` is
not served.
