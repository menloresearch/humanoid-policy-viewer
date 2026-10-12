# default

A few basic tests to check that the policy is running properly.

This is a benchmark for [humanoid-policy-viewer](https://github.com/menloresearch/humanoid-policy-viewer). Each row of
`data/<config>/test.jsonl` is one test scenario: velocity commands over time, timed pushes and the floor
friction. `benchmark.yaml` says how often each test runs, how runs are randomised and scored, and which numbers
become leaderboard tasks.

## Run it

```
git clone https://github.com/menloresearch/humanoid-policy-viewer && cd humanoid-policy-viewer && npm ci
npm run benchmark <your-org>/<your-policy> datasets/<this dataset>
```

Results go to the model repo's `.eval_results/` (directly if you own it, otherwise as a pull request) and
show up on this benchmark's leaderboards. Results are tied to the viewer commit and protocol that produced them;
task ids end in the benchmark version (`_v1`), so numbers from different benchmark versions never share a
leaderboard.

## Change it

```
npm run hf pull datasets/<this dataset> ./bench && npm run dev benchmark=./bench    # edit
npm run hf baseline ./bench
npm run hf publish ./bench pr
```
