# Benchmark suite: SOP mapping, categorization, and how the numbers were chosen

This benchmark suite is built to replicate the physical robot testing SOP
(Long Distance Walking + Static Push Tests) as closely as a MuJoCo-WASM sim
reasonably can, plus one axis the physical SOP doesn't cover yet (floor
friction). It documents: how `benchmark/` is organized, what each category
means, where the push-force numbers came from, and the design tradeoffs
behind the distance test — so a future checkpoint can be compared against a
fixed, reasoned standard instead of an arbitrary one, and so the reasoning
survives past whoever wrote it down.

## Layout — the folder IS the category

```
benchmark/
  locomotion/   pure velocity-command tracking, no pushes (circle, squares, rotation, ...)
  distance/     long-duration endurance/drift walking (the SOP's "Long Distance Walking")
  push/
    standing/   SOP "Static Push Tests" — chest, groin, both shoulders x3 axes — standing
    walking/    same locations, restricted to shoulders/chest/back, while walking straight
    sustained/  SOP's "if immobile, ramp up a sustained force" fallback
  friction/     floor-grip stress (not in the physical SOP; added because it's a cheap,
                high-value robustness axis once you already have a real-force push mechanism)
```

This isn't a separate taxonomy bolted onto the file list — the dev server's
`/api/sequences` endpoint (`vite.config.mjs`'s `humanoidDevPlugin`) and
`scripts/sequenceCatalog.mjs` already walk `benchmark/` recursively and
return each test's `folder`, and `SequenceBrowser.vue` already renders that
as a folder tree in the app's trajectory panel — nested folders were
supported end-to-end before this pass, just unused by the flat file list
that had accumulated. `src/simulation/benchmarkReport.js`'s `categoryOf(file)`
is the one place that turns a test's path back into a category label for
reporting (`categoryOf('push/standing/chest_front.json') === 'push/standing'`),
so reorganizing `benchmark/` further just works — nothing needs a second
edit. A root-level file (no folder) reports as `general`.

Every file here still needs `git add -f` — `benchmark/` is gitignored by
design (`.gitignore`'s comment on that line explains why: keeping a test
definition in git is meant to be an intentional act, not an accident).

## Reporting: same data, grouped by category

Three consumers read `deriveRow()`'s per-test metrics
(`src/simulation/benchmarkReport.js`): the standalone HTML report, the PR
comment, and the README index (the last two are produced by CI tooling in the
repo that embeds the viewer). All three previously only reported
one flat, blended number per policy (e.g. one "Pushes survived: 36/44"
across every push test regardless of location, one "Final drift" averaged
across a 23-second smoke test and — now — a 3-minute distance test). That
hides exactly the thing worth knowing: *where* a policy is weak, and it
actively misleads once a very different kind of test (distance, with drift
naturally in the tens of meters) gets averaged in with tests where drift is
naturally centimeters.

Fix: every consumer now also groups by `categoryOf(file)`:
- The HTML report gets a new "Results by category" table in the aggregate
  view (survived/upright/track-RMSE/drift per category per policy), and its
  tab bar gets a small label divider each time the category changes (tests
  are already sorted by file path, so a category's tests are already
  contiguous — no re-sorting needed).
- The PR comment gets a collapsed `<details>` "By category" table under the
  existing flat one.
- The README's "Pushes survived" cell changed from one flat fraction to a
  per-category breakdown string (`stand 9/10 · walk 7/8 · sustain 2/2`) via
  `PUSH_CATEGORY_TAGS` in `split-report-by-policy.mjs`, so the existing
  README table doesn't need new columns to say more.
- `BenchmarkResults.vue` (the live in-app view) got the same "Results by
  category" table as the HTML report, reusing the same `categoryOf`/
  `categoryLabel` exports so the three never drift apart.

**Known remaining gap**: the *flat* aggregate numbers (top of each report)
are still a blend across every test, including the very different distance
test — that's the pre-existing "Aggregate across N tests" table, left as-is
for continuity. Read the by-category table for real signal; treat the flat
aggregate as a summary-of-summaries, not a number to optimize.

## Static Push Tests → `push/standing/`, `push/walking/`, `push/sustained/`

### Method

A push counts as failed once `hasFailed()` trips (root height < 0.35m, or
torso tilt past ~78.5° from vertical) — see `benchmarkRunner.js`. For each
body location, an escalating, punch-like (0.15s) force was walked up in
100N steps (coarse pass), then refined in 25-50N steps around the boundary
found — one isolated test file per location, so a fall doesn't cascade-skip
later events (see "why one file per location" below). This was run twice
independently against the `model_Aug_18_1` checkpoint (2026-09-24), and the
committed "reasonable" tier is pulled down from the *lower* of the two
observed failure points — see the variance note below for why.

model_Aug_18_1's total mass is ~32.2kg (`pelvis_link` subtree mass, the
whole-robot subtree root).

### This suite was recalibrated once already — read this if the numbers look "off"

The first pass at this suite (superseded) was measured while every
checkpoint shared one PD-gain config (`asimov_4250/tracking_policy.json`, since renamed `asimov/reference_policy_config.json`)
regardless of which ONNX weights were loaded — a bug, fixed by merging in
`user/ariel/auto-read-env-yaml`, which makes each checkpoint load its own
kp/kd/armature/friction from its own `env.yaml`. That changed
`model_Aug_18_1`'s actual control gains substantially — kp down 25-68%, kd
down ~60-67% across every leg/hip/knee/ankle/waist joint group, versus what
the first pass was measured against. **Every number below is from a second,
full re-sweep run after that fix**, so it reflects the policy's real trained
behavior. If `auto-read-env-yaml`-style per-policy gains ever regress (back
to one shared config, or a future checkpoint's `env.yaml` isn't being
picked up), these numbers are no longer meaningful and need re-measuring —
see "Regenerating / extending" below for how.

**In the original setup this can no longer happen silently for a CI-benchmarked
checkpoint.** The CI of the repo that embeds the viewer runs a validation step
before its benchmark matrix and fails the run if a checkpoint in scope is
missing `env.yaml` or `agent.yaml`, or if `env.yaml` doesn't explicitly declare
stiffness/damping for every joint — the exact failure mode that produced the
shared-config bug above. Note the scope, though: it only validates the
checkpoint(s) the run actually decided to benchmark (changed `.onnx` files on a
PR, or every checkpoint on a full sweep) — an existing checkpoint that's never
touched again stays grandfathered. As of this writing, one mjlab test checkpoint
there is exactly such a case: it has no `env.yaml`/`agent.yaml` at all, so its
committed benchmark numbers are still measured against the shared base config's
gains, not its own — the gate will only catch this the next time that
checkpoint (or its config) changes.

### Other places a bad config used to fail silently — now fail loud instead

A handful of other spots in the push-benchmark pipeline had the same shape of
bug as the shared-gains one above: given bad or missing input, they'd
silently substitute a plausible-looking default and keep going, rather than
erroring. Each of these now fails loud (a thrown error that becomes that
test's `result.error`, or a warning folded into `result.warning` — both
surface in the HTML/PR-summary report, and both fail the CI job):

- **A push event's `targetBody` mass.** `MuJoCoDemo.getBodyMass()` used to
  return a hardcoded 30kg fallback whenever a body's mass couldn't be
  resolved — including the case where a resolved body's real mass is
  legitimately `0` (a massless attachment/frame body), which `||`-based
  fallback logic in `metrics.js` mistook for "missing." It now throws instead
  of guessing, which only matters because of the next point:
- **A push event's `targetBody` name.** `MuJoCoDemo.resolveBodyId()` silently
  redirects an unrecognized `targetBody` to the pelvis (deliberately kept —
  it's what lets a test authored against one scene degrade gracefully on
  another), but a *typo'd* name used to get the exact same silent treatment
  as a deliberate cross-scene mismatch — the test would "complete" and report
  a plausible score for the wrong body location. This fallback is now loud:
  it's logged and folded into that test's `result.warning`, so a typo'd
  `left_shouler_pitch_link` shows up in the report instead of silently
  scoring as a pelvis push.
- **Floor-friction stress tests.** `MuJoCoDemo.setFootFriction()` used to
  silently no-op (return an empty override map) if no model was loaded or if
  zero geoms matched the `foot\d*_collision$` naming convention — a
  `footFriction`-tagged test would then run at the scene's *default* grip
  with no sign the requested slicker/grippier floor was never actually
  applied. It now throws in both cases.
- **A checkpoint's `env.yaml` in the interactive viewer and static site
  build.** The CI gate above only covers checkpoints actually passed to the
  benchmark script; `envPolicyConfig.js` (used by the live demo) and
  `build-static-catalog.mjs` (used by the static-site build) each have their
  own independent "checkpoint has no env.yaml" path that isn't covered by
  that gate, and both used to hit it in total silence. Both now log a console
  warning naming the checkpoint when this happens.

### Measured envelope (model_Aug_18_1, standing, rapid 0.15s push, own gains)

| Location | Direction | First observed fail (run 1 / run 2) |
|---|---|---|
| `pelvis_link` (groin/hips) | front | 600N / passed to 600N |
| `pelvis_link` (groin/hips) | back | 600N / passed to 600N |
| `pelvis_link` (groin/hips) | lateral | 600N / 575N |
| `waist_yaw_link` (chest) | front | 400N / 375N |
| `left_shoulder_pitch_link` | front (horizontal) | 400N / 325N |
| `left_shoulder_pitch_link` | lateral (horizontal) | 500N / 400N |
| `left_shoulder_pitch_link` | vertical (downward) | 1300N / passed to 1300N |
| `right_shoulder_pitch_link` | front (horizontal) | 300N / passed to 300N |
| `right_shoulder_pitch_link` | lateral (horizontal) | 400N / 325N |
| `right_shoulder_pitch_link` | vertical (downward) | 1300N / 1250N |
| `waist_yaw_link` (chest), walking | front | 400N / 375N |
| `pelvis_link`, walking | back | 700N / 625N |
| `left_shoulder_pitch_link`, walking | front | 300N / 275N |
| `left_shoulder_pitch_link`, walking | lateral | 300N / 250N |

Same two things that shaped the original design still hold under the real
gains:

1. **Leverage dominates, not just force.** Chest/shoulder pushes destabilize
   at roughly half the force needed at the pelvis — moment arm from the
   ground contact matters more than raw Newtons.
2. **A push straight down through the shoulder barely destabilizes** —
   mostly loads the leg. Vertical shoulder pushes get their own, much
   higher, force tier (~3-4x the horizontal tier).

### Chosen tiers (committed test files)

Each `push/standing/*.json` / `push/walking/*.json` file fires exactly two
events at one location, 6s apart — a "reasonable" then a "beyond" push, so
a fall on the first doesn't waste the second:

| Category | Location | reasonable (N) | beyond (N) |
|---|---|---|---|
| standing | groin front/back/lateral | 450 | 575 |
| standing | chest front | 250 | 350 |
| standing | shoulder front (L/R) | 225 / 175 | 300 / 275 |
| standing | shoulder lateral (L/R) | 225 | 375 / 300 |
| standing | shoulder vertical (L/R) | 850 | 1200 |
| walking | chest front | 225 | 325 |
| walking | back (pelvis, rear handle) | 450 | 575 |
| walking | shoulder front (L/R) | 175 | 250 |
| walking | shoulder lateral (L/R) | 150 | 225 |
| walking | shoulder vertical (L/R) | 850 | 1200 |

- **reasonable**: pulled well below the lower of the two observed failure
  points — the level a shipped locomotion policy should pass cleanly, with
  real margin. Verified: a fresh validation run passed **20/20** reasonable
  pushes (0 failures) for `model_Aug_18_1`.
- **beyond**: close to or past the observed failure point, deliberately
  *not* required to pass. It's a regression signal, not a gate — if a
  future checkpoint's margin between reasonable/beyond shrinks, or
  "reasonable" itself starts failing, that shows up in the per-push
  `recovered`/`peakInstability`/`score` fields even though the headline
  "beyond" push failing is expected and fine.
- Walking-vertical tiers reuse the standing-vertical numbers (not
  independently re-measured this pass) — vertical pushes are far less
  about balance/footing than horizontal ones, so the standing/walking
  distinction matters much less there. Flagged as a lower-confidence
  simplification, not a measured result.
- Right-side walking tiers mirror the left-side walking numbers (not
  independently swept) — same simplification the original design used, and
  standing L/R turned out close enough (225/300 vs 175/275) to support it.

`push/walking/*` restricts locations to shoulders, chest (front), and back
per the physical protocol, which only pushes those while the robot walks a
straight line; groin/lateral-pelvis pushes are standing-only. Walking speed
is `vx=0.6`, matching the suite's other walking-baseline tests
(`locomotion/square_medium.json`, `distance/square_lap_100m.json`) — these
files previously commanded `vx=0.8` with no documented reason for the
mismatch; changed for consistency.

### Removed: `push/envelope/`

An earlier, pre-SOP-mapping push suite (`feature_coverage.json`,
`full_envelope_push.json`, `recovery_ladder.json`) chained several
different-location push events into one file. That's exactly the pattern
"Why one file per location" (below) explains is broken: `benchmarkRunner.js`
only calls `resetSimulation()` between *files*, not between events within
one, so a fall on an early event in a chained file skips every later,
different-location event (`fallenBeforePush`, no data) — these three files
carried that risk in every run without it showing up unless you went
looking. They also fully overlapped, location- and force-wise, with the
better-designed `push/standing/`/`push/walking/` suite once that suite
existed. Removed rather than fixed, since fixing them would just mean
re-deriving `push/standing/`/`push/walking/` a second time under a different
name.

### Why one file per location, not one big checklist file

An earlier draft chained every location into 2-3 large files (all standing
locations in sequence, etc.) to mirror how a physical tester would actually
run down a checklist without resetting the robot between items. That broke
in an important way: `benchmarkRunner.js` calls `demo.resetSimulation()`
fresh before every *test file*, but not between events inside one file — so
the first fall in a chained file cascades every later, different-location
event to `fallenBeforePush` (skipped, no data). Across a 20-event chained
file, only 2-3 locations ever actually got exercised per run. Splitting to
one file per location means every location gets a real, fresh-reset trial
every run, at the cost of losing the "cumulative fatigue" realism of a
tester never resetting the robot between checklist items. Given the choice
between "every location tested, cleanly" and "realistic cumulative fatigue
but most locations silently untested," this suite chose the former.

### Observed run-to-run variance — read before trusting a single run

The two independent sweeps above disagree by 25-100N at several boundaries
(e.g. `pelvis_link` lateral: 600N fail vs. 575N fail; `left_shoulder_pitch`
lateral: 500N fail vs. 400N fail) despite identical inputs. Every
"reasonable" tier above was set from the *more conservative* (lower) of the
two runs, specifically to absorb this. If a future run of these files
starts flaking at the reasonable tier, that's worth another empirical
sweep, not just re-running until it's green.

**Correction**: this was originally guessed to be the policy's own
observation noise (`enable_corruption: true` in `env.yaml`). That's wrong —
see `benchmark/VARIANCE_ANALYSIS.md` for the actual, confirmed source (an
unseeded action-delay draw in `main.js`, nothing to do with observation
noise) and measured spread per test category.

### `push/sustained/` — the SOP's "if immobile, ramp up" fallback

Models the physical protocol's fallback for a push that doesn't visibly
displace the robot: hold the push and ramp it up, rather than one rapid
strike. Approximated as a 0.6s hold instead of 0.15s. **Not independently
re-swept this pass** — forces were scaled down ~25% from the recalibrated
rapid-push tiers (impulse = force × duration, so 0.6s at the same Newtons
delivers ~4x the momentum of 0.15s; the ~25% cut is a conservative estimate,
not a measured boundary). Validated only for "doesn't obviously break":
`groin_lateral` passed its first 3 of 4 escalating steps, `shoulder_lateral`
passed its first 2 of 4 — consistent with a real, if imprecise, tier.
Flagged as lower-confidence; re-sweep before leaning on these numbers hard.

### No sim analog

No location stands in for "push the robot while talking" (human-interaction
scenario) or the literal handle at the back of the robot (no such body in
the MJCF — `pelvis_link` pushed from behind stands in for it, per the
original design).

## Gait symmetry — what it measures, and why it's opt-in

`metrics.js`'s `computeGaitSymmetry()` mirrors every `left_X`/`right_X` joint
pair (`left − sign·right`, RMSE'd over the run) and combines that with how
unevenly the two feet share ground-contact time
(`contactDutyAsymmetry`) into one `symmetryScorePercent` — 100% is a
perfectly mirrored gait, lower means more limp-like.

**This is only a meaningful measurement while the robot is walking straight
at a roughly constant commanded velocity** (`wz ≈ 0`, steady `vx`/`vy`). The
mirror assumption it's built on — left and right should be doing the same
thing, offset by half a stride — is a "walking in a straight line" assumption,
and it's legitimately violated any time the robot is doing something that
*should* look asymmetric:

- **Turning.** During a real turn, the inside and outside leg travel
  different arc lengths and load differently by physical necessity —
  `locomotion/circle.json` and `locomotion/rotation_360.json` command a
  nonzero `wz` for essentially their entire duration, so their symmetry
  score would mostly measure turning kinematics, not gait quality.
- **Push recovery.** The correct response to a lateral push is often a
  single asymmetric catch-step (weight-shift onto one leg), not a mirrored
  motion — every `push/*` test would otherwise score that appropriate
  recovery as if it were a limp.

Because of this, `computeMetrics()` only computes `gaitSymmetry` when a
test's sequence JSON explicitly opts in with a top-level flag:

```json
{ "name": "diagonal_walk", "gaitSymmetry": true, "commands": [...] }
```

Leaving the field out (the default for every test shipped today) turns the
metric off entirely — `metrics.gaitSymmetry` is `null`, no per-joint chart is
rendered, and the KPI/aggregate tables show `n/a` for that test. Only enable
it on tests that are pure, sustained straight-line walking with no turns and
no push events; a test that mixes straight walking with a turn or a push
will still corrupt the score even with the flag on, since the metric has no
way to exclude just the disrupted samples — see the discussion this section
summarizes for the reasoning.

`locomotion/backward_walk.json` and `locomotion/forward_walk.json` are the
only two tests that qualify and opt in today. Before `forward_walk.json` was
added, no plain straight-line *forward* walk existed at all — every other
`locomotion/*` test turns, moves diagonally, or reverses, so there was no
baseline gait-symmetry reading for a policy's primary (forward) gait to
compare `backward_walk`'s against.

The README's per-checkpoint summary table
(generated by the embedding repo's CI tooling) still has no Symmetry column — it's a
per-test, not per-policy-aggregate, metric, so it stays in the standalone
HTML report and the in-app benchmark view (as `n/a` for every test that
doesn't set the flag).

## Long Distance Walking → `distance/square_lap_100m.json`

### The tradeoff, and why a literal 400m test isn't in the default suite

The physical SOP walks one ~400m square lap. Naively porting that: at the
existing locomotion tests' walking speed (vx=0.6 m/s), 400m takes ~667s of
*simulated* time. Measured wall-clock overhead in this environment: a 23.2s
sim test took 65s real time (~1.9x real-time once fixed per-test overhead —
model/policy load, ~20s — is subtracted). At that ratio, a 667s sim test is
~1270s (21 minutes) wall-clock — past `benchmarkRunner.js`'s
`waitForTestCompletion` 20-minute hard cap (`hardCapMs`), meaning it would
very likely get cut off mid-run and report a truncated, misleading result
rather than a real 400m pass/fail. Multiplied across a CI matrix of several
checkpoints, it would also make every benchmark run take 20+ extra minutes
per checkpoint for one test.

**Decision**: `distance/square_lap_100m.json` is a 1/4-scale proxy — a
100m square lap (4×25m sides at vx=0.6 m/s, 90° turns via wz=0.6 for 2.618s
per corner — the exact duration for 90° at that rate, not the original 2.6s
which undershot by ~0.6° per corner and left the ideal path ~0.8m short of
closing the loop; `locomotion/square_medium.json` uses the same corrected
recipe), 180s sim duration. Measured at 179.98s sim / ~9000 frames captured,
comfortably within the time and hard-cap budget. This preserves the core
signal the physical test is after — sustained multi-corner walking over a
duration an order of magnitude longer than the existing 23-26s locomotion
smoke tests — while staying CI-practical. A literal 400m version can be
built the same way (multiply every side length and duration by 4) if
someone wants to run it manually/nightly; it just isn't part of the default
suite given the runtime math above.

### What it found (this is the headline result, not a footnote)

Run against `model_Aug_18_1`: the robot did **not fall** over the full 180s,
but drifted **83.9m** from its dead-reckoned expected position by the end
of a nominally-100m closed loop (`drift.final_m`) — the actual path is
essentially a long, gently-curving line, not a closed square: `x` grew
monotonically from 0 to ~82m over the whole test while `y` stayed in a
narrow -19m..0m band, meaning the commanded 90° turns at each corner did
not durably change the robot's actual long-run heading. This is *exactly*
the class of failure mode a long-distance test exists to catch and the
existing 23-26s `locomotion/*` smoke tests structurally cannot: they're too
short for a slow heading-hold weakness to accumulate into something
visible. Whether the cause is gait-asymmetry-driven heading drift during
long straight-line segments, or the turn command's effect not persisting
through a long subsequent straight segment, is a policy-training question
this benchmark surfaces but doesn't diagnose — worth raising with whoever
owns `model_Aug_18_1`'s training run. This is not a bug in the test to be
"fixed" by adjusting turn timing; forcing the actual path to match the
expected square would hide the finding, not correct it.

## Friction stress → `friction/`

Not part of the physical SOP, added because the push-force mechanism
already existed and a floor-grip axis is cheap to add on top of it.

The floor geom's own `friction` attribute in `asimov_1.xml` is inert: MuJoCo
combines a contact's parameters by taking *all* of them from whichever geom
has the higher `priority`, and the foot collision geoms carry `priority="1"`
against the floor's default 0. So `MuJoCoDemo.setFootFriction()`
(`src/simulation/main.js`) overrides the sliding-friction coefficient on the
foot geoms instead — the physically-correct lever — driven by an optional
`footFriction` field read directly off a test's raw JSON in
`benchmarkRunner.js` (restored to the scene default after the test).

Scene's nominal foot friction: 0.6 (rubber-like). Two tiers:

- `friction/wet_floor.json` — 0.3 (wet tile / polished floor)
- `friction/icy_floor.json` — 0.08 (icy)

Sanity-checked (pre-recalibration, on a walking-and-turning pattern): at
0.08 the turn-rate tracking RMSE roughly quadrupled and drift RMSE grew
~35% versus nominal friction, without an outright fall — degrades
locomotion quality well before it causes a fall, the right kind of
early-warning signal. Not re-verified against the corrected kp/kd this
pass; re-run before trusting the exact magnitude.

## CI time budget: sharding by (policy, test-group), not just policy

Each policy's tests used to run as one long sequence in one CI shard (one
vite dev server + one headless browser, since a page can only host one live
`MuJoCoDemo`). That doesn't scale: as the committed suite grows, the wall
time a PR waits on the whole `push/`/`locomotion/`/etc. suite grows with it,
even though GitHub Actions already runs the policy matrix in parallel.

The embedding repo's CI fixes this by expanding each policy
into *several* shards — first-fit-decreasing bin-packing the committed
`benchmark/*.json` tests by estimated wall-clock cost
(`FIXED_OVERHEAD_S + duration * SIM_TO_WALL_RATIO`, both measured in this
doc's own numbers above) so no shard's estimate exceeds a shard budget
(210s, a real-margin target under a 5-minute-per-shard goal). A discovery step
runs once per benchmark run to build the job matrix; `run-benchmark.mjs --tests`
(supported for manual/local single-test runs too) is what each shard actually
uses to run just its assigned subset.

This costs more total runner-minutes (each shard re-pays the ~20s cold
WASM/ONNX boot instead of amortizing it across every test for that policy),
in exchange for wall-clock time bounded by one shard's budget rather than a
policy's whole test-suite total — the tradeoff only makes sense because CI
shards run in parallel; it would be a straightforward regression for a local
non-parallel run.

**`distance/square_lap_100m.json` is the one deliberate exception.** Its own
estimated cost (180s × 1.94 + 20s ≈ 369s) is already past the 210s shard
budget, so it always gets a solo shard rather than being merged with
anything else or force-shortened to fit — same "some things just take
longer, and that's fine given the 20-minute hard cap backstop" tradeoff this
doc's "Long Distance Walking" section already made for its own duration.

## Regenerating / extending

`scripts/run-benchmark.mjs --policies "ckpt:<path>" --tests "<file>.json"`
runs a single test file headlessly against one checkpoint (nested paths
like `push/standing/chest_front.json` work — see Layout above). A force
sweep for a new location or a different robot's mass distribution is a
small script (not checked in — throwaway tooling each pass) that emits
several isolated `push_*.json` files with an escalating `force`, 6s apart
(a coarse sweep finishes in one sim run per location), reads back
`metrics.perturbations.events[].recovered` / `.peakInstability`, then
refines in 25-50N steps around whatever boundary it finds. Do this **twice
independently** and take the more conservative boundary — see the variance
note above for why a single sweep isn't trustworthy on its own.
