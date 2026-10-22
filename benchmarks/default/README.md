# default

A few basic tests to check that the policy is running properly.

This is a benchmark for [humanoid-policy-viewer](https://github.com/menloresearch/humanoid-policy-viewer). Each row of
`data/<config>/test.jsonl` is one test scenario: velocity commands over time, timed pushes and the floor
friction. `benchmark.yaml` says how often each test runs, how runs are randomised and scored, and which numbers
become leaderboard tasks.

## Run it

```
git clone https://github.com/menloresearch/humanoid-policy-viewer && cd humanoid-policy-viewer && npm install
npm run benchmark <your-org>/<your-policy> datasets/<this dataset>@v2
npm run benchmark view benchmark_results/<timestamp>
```

The run stays on your machine: `result.json` and `report.html` in `benchmark_results/<timestamp>`. A policy can
also be a folder on disk, e.g. `npm run benchmark ./my-policy datasets/<this dataset>@v2`. Results are tied to the
viewer commit and protocol that produced them; task ids end in the benchmark version (`_v2`), so numbers from
different benchmark versions never share a leaderboard.

Results are submitted to this benchmark's leaderboards with
[cyclotron](https://github.com/menloresearch/cyclotron), which runs the benchmark the same way and adds the
results to the model repo's `.eval_results/`. The viewer only reads from Hugging Face.

## Change it

Open a local copy in the viewer, edit its tests and settings, and run it:

```
npm run dev benchmark=./my-copy          # a folder with this benchmark.yaml and data/
npm run benchmark <policy> ./my-copy
```

A copy opened straight from the Hub (`npm run dev benchmark=datasets/<this dataset>`) is read-only. Bump `version`
in `benchmark.yaml` whenever a change can move a score. New versions are published with
[cyclotron](https://github.com/menloresearch/cyclotron).
