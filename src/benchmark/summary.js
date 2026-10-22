// Turns per-cell results (one per policy x test x repeat) into
//   1. per-test summaries: every metric's value for each repeat and their mean
//   2. leaderboard task values: one number per benchmark task (plus its uncertainty),
//      which is what goes into a model repo's .eval_results/ file.
// The raw per-cell metrics stay in result.json; nothing here is lossy for them.
//
// Metrics are versioned on their own ("survival_rate@1"): a benchmark task names
// the exact version it scores with, so adding a metric never changes an
// existing number, and changing what a metric means is a new version (and new
// leaderboards) rather than a silent edit. Never change a published version;
// add the next one.
//
// Every metric is a number per cell, and how cells combine is part of its
// definition. Unless a metric says otherwise:
//   - repeats of a test are averaged (repeats differ only by their seeded
//     randomisation, so the mean estimates the expected value for that test);
//   - tests are averaged within their category, then categories are averaged,
//     so each category in scope counts equally however many tests it has;
//   - the uncertainty is the standard error of that weighted mean over the
//     seeds (the tests are fixed, only the randomisation varies), reported with
//     a 95% interval clipped to the metric's range. Each test's spread is
//     smoothed (see variance()), so the interval is never falsely zero-width.
//
// Version 1 of the survival metrics judges a run by its first fall; version 2
// by how it ended, so it also works for tests that start the robot down
// (lying, or limp after drop and settle): it survived if it is up in the last
// frame, and otherwise its time is when it last went down (0 if it never stood).
//
// A cell that errored counts as a failure (fell at t = 0), never as missing
// data, so a crashing policy cannot score well by crashing. On a test with a
// goal (an end zone), a run whose base never entered the zone did not finish
// the test: it fails survival_rate but keeps survival_time 1 (it stayed upright).
// Per-test summaries keep the two apart, judged as version 2 does: fellAt says
// when a repeat that ended down last went down, missedGoal which repeats ended
// up but never got to the end zone.

import { goalOutcome } from '../simulation/metrics.js';

const round = (value, digits = 4) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

/**
 * Per-repeat variance of one test's values. For a bounded metric it is computed
 * as if one more repeat had landed at each end of the range, so a test that
 * gave the same value every time (5 survivals out of 5) still carries
 * uncertainty instead of claiming it can never go otherwise. For a 0/1 metric
 * this is the variance of the smoothed rate (k + 1) / (n + 2). An unbounded
 * metric uses the unbiased sample variance (null with fewer than two values).
 */
function variance(values, [lo, hi] = [-Infinity, Infinity]) {
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    if (!values.length) return null;
    const padded = [...values, lo, hi];
    const m = mean(padded);
    return padded.reduce((sum, v) => sum + (v - m) ** 2, 0) / padded.length;
  }
  if (values.length < 2) return null;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

const failed = (cell) => !!cell.error || !cell.metrics;

/** Seconds into the test of the first fall; null if the cell never fell. Errored cells fell at 0. */
function fallTime(cell) {
  if (failed(cell)) return 0;
  return cell.metrics.fell?.fell ? (cell.metrics.fell.time ?? 0) : null;
}

/**
 * Seconds into the test when a run that ended down last went down: 0 if it never
 * stood (or errored), null if it ended up. A result saved before runs recorded
 * how they ended is judged by its first fall.
 */
function endFallTime(cell) {
  if (failed(cell)) return 0;
  const ending = cell.metrics.ending;
  if (!ending) return fallTime(cell);
  if (!ending.down) return null;
  return ending.stood ? (ending.last_fall_time ?? 0) : 0;
}

/** Whether the robot's base entered the test's end zone (true when the test has none). */
export function reachedGoal(cell, row) {
  if (!row.goal) return true;
  return goalOutcome(cell.metrics?.topDown?.actual, row.goal).reached;
}

/** Ended up but never entered its end zone. */
const missedGoal = (cell, row) => endFallTime(cell) === null && !reachedGoal(cell, row);

// Every metric a benchmark task may name, by "<name>@<version>".
//   perCell(cell, row) -> number   the value of one (test, repeat)
//   range                          bounds of the value: smooths the spread, clips the interval
export const METRICS = {
  'survival_rate@1': {
    higherIsBetter: true,
    range: [0, 1],
    description: 'Probability of finishing a test without falling, and reaching its end zone if it has one (1 = always)',
    perCell: (cell, row) => (fallTime(cell) === null && reachedGoal(cell, row) ? 1 : 0),
  },
  'survival_time@1': {
    higherIsBetter: true,
    range: [0, 1],
    description: 'Fraction of each test completed before the first fall (1 = never fell)',
    perCell: (cell, row) => {
      const t = fallTime(cell);
      if (t === null) return 1;
      return row.duration > 0 ? Math.min(1, Math.max(0, t / row.duration)) : 0;
    },
  },
  'survival_rate@2': {
    higherIsBetter: true,
    range: [0, 1],
    description: 'Probability of being up at the end of a test, and having reached its end zone if it has one (1 = always)',
    perCell: (cell, row) => (endFallTime(cell) === null && reachedGoal(cell, row) ? 1 : 0),
  },
  'survival_time@2': {
    higherIsBetter: true,
    range: [0, 1],
    description: 'Fraction of each test before the robot last went down (1 = up at the end, 0 = never stood)',
    perCell: (cell, row) => {
      const t = endFallTime(cell);
      if (t === null) return 1;
      return row.duration > 0 ? Math.min(1, Math.max(0, t / row.duration)) : 0;
    },
  },
};

/** "survival_rate" -> the latest version's key, for error messages. */
export function latestMetricVersion(name) {
  const versions = Object.keys(METRICS).filter((key) => key.split('@')[0] === name);
  return versions.sort((a, b) => Number(b.split('@')[1]) - Number(a.split('@')[1]))[0] ?? null;
}

/**
 * @param cells    cell results for ONE policy (any order)
 * @param selected selectTests() output: [{ row, settings }]
 */
export function summarizeTests(cells, selected) {
  return selected.map(({ row }) => {
    const mine = cells.filter((cell) => cell.testId === row.id).sort((a, b) => a.repeat - b.repeat);
    const metrics = {};
    for (const [key, metric] of Object.entries(METRICS)) {
      const values = mine.map((cell) => metric.perCell(cell, row));
      metrics[key] = { value: round(mean(values)), variance: variance(values, metric.range), values: values.map((v) => round(v)) };
    }
    return {
      testId: row.id,
      config: row.config,
      tags: row.tags,
      repeats: mine.length,
      errors: mine.filter(failed).length,
      fellAt: mine.map(endFallTime),
      missedGoal: mine.map((cell) => missedGoal(cell, row)),
      metrics,
    };
  });
}

const inList = (value, wanted) => wanted === undefined || (Array.isArray(wanted) ? wanted.includes(value) : value === wanted);
const anyInList = (values, wanted) => wanted === undefined || values.some((value) => inList(value, wanted));

/** Tests a task scope covers: config and id match the test; tag matches any of its tags. */
export function scopedTests(perTest, scope = {}) {
  return perTest.filter((test) => inList(test.config, scope.config)
    && inList(test.testId, scope.id)
    && anyInList(test.tags ?? [], scope.tag));
}

/**
 * The value of one metric over a scope: the category-balanced mean of per-test
 * means, with its standard error over the seeds. null when nothing is in scope.
 */
export function combineTests(tests, key) {
  const scored = tests.filter((test) => Number.isFinite(test.metrics[key]?.value));
  if (!scored.length) return null;
  const byConfig = new Map();
  for (const test of scored) byConfig.set(test.config, [...(byConfig.get(test.config) ?? []), test]);
  let value = 0;
  let errorVariance = 0;
  let unknownSpread = false;
  for (const group of byConfig.values()) {
    const weight = 1 / (byConfig.size * group.length);
    for (const test of group) {
      const m = test.metrics[key];
      value += weight * m.value;
      if (m.variance === null) unknownSpread = true;
      else errorVariance += weight ** 2 * m.variance / test.repeats;
    }
  }
  const [lo, hi] = METRICS[key].range ?? [-Infinity, Infinity];
  const stderr = unknownSpread ? null : Math.sqrt(errorVariance);
  return {
    value,
    stderr,
    ci95: stderr === null ? null : [Math.max(lo, value - 1.96 * stderr), Math.min(hi, value + 1.96 * stderr)],
    tests: scored.length,
    configs: byConfig.size,
    cells: scored.reduce((sum, test) => sum + test.repeats, 0),
  };
}

/** One value per benchmark task for one policy; tasks with nothing to measure get value null. */
export function computeTasks(benchmark, perTest) {
  return benchmark.tasks.map((task) => {
    const metric = METRICS[task.metric];
    const result = combineTests(scopedTests(perTest, task.scope), task.metric);
    return {
      taskId: `${task.id}_v${benchmark.version}`,
      metric: task.metric,
      higherIsBetter: metric.higherIsBetter,
      value: round(result?.value ?? null),
      stderr: round(result?.stderr ?? null),
      ci95: result?.ci95 ? result.ci95.map((v) => round(v)) : null,
      tests: result?.tests ?? 0,
      cells: result?.cells ?? 0,
    };
  });
}
