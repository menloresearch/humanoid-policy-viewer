# Run-to-run variance in the benchmark suite

Both the original push-force sweep (before the kp/kd merge) and the
recalibration pass (after it) independently hit results that disagreed by
25-100N at the same, unchanged boundary. This documents where that comes
from and how much it actually moves the numbers.

## Source: found, and it's not what `METHODOLOGY.md` originally guessed

`src/simulation/main.js`'s `resetActionDelay()`:

```js
resetActionDelay(seedTarget = null) {
  const span = this.actionDelayMaxLag - this.actionDelayMinLag + 1;
  this.actionDelayLag = this.actionDelayMinLag + Math.floor(Math.random() * Math.max(1, span));
  ...
}
```

`Math.random()`, unseeded. Called from `configureActionDelay()` (on every
policy (re)load) **and** from `resetSimulation()` (line ~912) — which
`benchmarkRunner.js` calls fresh before *every single test file*. So every
benchmark run draws a brand-new random `actionDelayLag` and holds it fixed
for that whole run.

`model_Aug_18_1`'s effective config has `delay_min_lag: 0`, `delay_max_lag:
5` (from `public/examples/checkpoints/asimov_4250/tracking_policy.json`, since renamed `asimov/reference_policy_config.json` —
this mirrors, but isn't actually sourced from, the `min_delay`/`max_delay:
0`/`5` on every actuator group in `env.yaml`'s `DelayedPDActuator` configs;
`envPolicyConfig.js` doesn't currently read those fields at all, so this is
coincidence, not wiring — worth a follow-up but out of scope here). `getDelayedActionTarget()` is
called once per policy tick, and `policyDt = timestep * decimation = 0.005
* 4 = 0.02s`. So `actionDelayLag ∈ {0,1,2,3,4,5}` means the actuator target
can lag the policy's actual output by **0 to 100ms**, drawn uniformly, once
per test run, no seed.

Directly confirmed by resetting the sim 30 times in a row and reading
`demo.actionDelayLag` back: `0,0,3,0,1,5,3,3,1,3,1,1,1,0,5,2,0,2,3,1,3,3,5,1,3,5,5,5,5,2` —
a clean, unseeded uniform draw over `{0..5}`, exactly as the code predicts.

**This is the sole source.** `grep -rn "Math.random" src/simulation/*.js`
returns exactly this one call site — nothing in
`observationHelpers.js`/`policyRunner.js`/`onnxHelper.js`/
`envPolicyConfig.js` adds any other randomness. The original guess (policy
observation-corruption noise, `enable_corruption: true` in `env.yaml`) was
wrong: that flag describes how the policy was *trained* (domain
randomization during training), not anything the browser-side viewer
replicates at inference time — there's no noise-injection code in the
inference path at all.

## Measured spread

8 repeated runs each, same policy, same file, only the random delay draw
differing between runs:

**`push/standing/groin_lateral.json`** (reasonable 450N, beyond 575N):

| tier | outcome across 8 runs | peakInstability range |
|---|---|---|
| reasonable (450N) | **8/8 recovered** | 0.230 – 0.600 |
| beyond (575N) | **5/8 recovered, 3/8 fell** | 0.183 – 1.000 (continuous) |

**`push/standing/shoulder_l_lateral.json`** (reasonable 225N, beyond 375N):

| tier | outcome across 8 runs | peakInstability range |
|---|---|---|
| reasonable (225N) | **8/8 recovered** | (all low, comfortable) |
| beyond (375N) | **0/8 recovered** | pinned at 1.000 every run |

The pattern is precise, not just "there's noise somewhere": **575N sits
inside the ~100ms delay window's recoverability band** — some delay draws
let the policy start correcting in time, some don't, so the outcome flips.
**375N does not sit in that band** — it's decisively beyond what any delay
draw in `{0..5}` can save, so it fails identically every time. Variance is
concentrated exactly at forces close to the real capability boundary, not
spread uniformly across every push. Both **"reasonable" tiers held 8/8**
with real headroom under the full range of delay draws — good evidence the
existing "pull it below the lower of two sweeps" margin is actually
sufficient, at least at these two locations.

**`locomotion/circle.json`** (no push events, pure command tracking):

| metric | range across 8 runs |
|---|---|
| `wz` tracking RMSE | 0.163 – 0.198 (~20% relative spread) |
| `vx` tracking RMSE | 0.637 – 0.661 (~4% relative spread) |
| drift RMSE | 2.03 – 3.18m (one outlier run out of 8) |

Values cluster into a handful of repeated exact matches across the 8 runs
(e.g. two runs land on `wz RMSE = 0.19755` exactly, two others on
`0.18505`) rather than varying continuously — consistent with the sole
randomness being a 6-valued discrete draw (`{0..5}`), not continuous noise.
No falls in any run. Locomotion-only tests are meaningfully less
variance-sensitive than push-recovery tests, because there's no
sharp pass/fail threshold for the delay draw to land on either side of.

**`distance/square_lap_100m.json`**: 2 runs (180s sim each, ~3 min
wall-clock — too expensive for a full 8-repeat sweep). `drift.final_m`:
87.55m vs. 87.43m, <0.2% apart. This confirms the earlier
"~84-87m drift on a nominally-closed 100m loop" finding from the benchmark
build pass is a **real, repeatable policy behavior**, not a one-off noisy
run.

## Recommendation

1. **Don't lower the "reasonable" tiers further based on this finding** —
   both tested locations held 8/8 with genuine margin (peakInstability
   never got close to the 1.0 fall threshold on any reasonable-tier run).
   The existing "pulled below the lower of two independent sweeps" approach
   is doing its job.
2. **Widen future calibration sampling.** A boundary found from *one*
   sweep run is itself a single draw from a variable with up to 100ms of
   swing — the existing "sweep twice, take the more conservative" approach
   is a good start but is still only 2 samples of what can be a genuinely
   bimodal outcome near the boundary (see `groin_lateral`'s 575N: not
   "slightly flaky," literally 5-pass/3-fail out of 8). When a future sweep
   lands a force right at a boundary, running that exact force 3-5 times
   before committing it to a tier would catch this directly instead of
   relying on two independent full sweeps to happen to disagree loudly
   enough to notice.
3. **Fixed** (follow-up pass, after this doc was first written):
   `resetActionDelay()` now unconditionally pins `actionDelayLag` to a fixed,
   reproducible value — `actionDelayMinLag + floor((span - 1) / 2)`, the
   midpoint of the policy's configured delay range, i.e. a "typical" case
   rather than best/worst-case — instead of ever drawing from
   `Math.random()`. This applies everywhere `resetActionDelay()` is called,
   including the live interactive demo, so every run (headless benchmark or
   interactive) is now exactly reproducible run-to-run; there is no more
   random action-delay draw anywhere in the app.

   Chose the midpoint over worst-case deliberately: this suite's main job is
   stable comparison across policy versions (a regression benchmark), not
   adversarial stress-testing — pinning worst-case would make every
   "reasonable" tier a strictly harder bar than the sweep that calibrated
   it was actually measuring against, silently shifting what "reasonable"
   means. The midpoint keeps the fix's scope to "remove the flakiness"
   without also changing what the numbers represent.

   Verified: `push/standing/groin_lateral.json` and
   `push/standing/shoulder_l_lateral.json` (the two tests measured above) run
   3x back-to-back now produce byte-identical `peakInstability` values every
   time (`0.3076`/`0.352` and `0.1461`/`1.0` respectively, all 3 runs) —
   confirms the fix actually eliminates the variance rather than just
   narrowing it. Both "reasonable" tiers still hold at the fixed midpoint
   delay; `groin_lateral`'s 575N "beyond" tier, which flipped 5/8 vs 3/8
   under the random draw, now consistently *passes* under the midpoint delay
   (that tier's flip was legitimately inside the recoverability band, and the
   midpoint happens to land on the passing side — expected, not a bug).
4. Wiring `envPolicyConfig.js` to actually read each policy's own
   `min_delay`/`max_delay` per actuator group from its `env.yaml` (it
   currently doesn't — the 0/5 match with the shared base config is
   coincidence) is a separate, smaller gap worth closing alongside #3, so a
   future checkpoint with a different trained delay range gets tested
   against *its own* delay distribution rather than always inheriting
   `asimov_4250`'s 0-5.
