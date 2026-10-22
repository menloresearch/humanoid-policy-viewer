// What a result.json shows, as the tables both the results page
// (src/views/BenchmarkResults.vue) and report.html (src/simulation/benchmarkReport.js)
// render, so the two never disagree. Per policy:
//   - each test's repeats and how each one ended: passed, fell at T s, stayed
//     upright but missed the end zone by D m, or errored;
//   - each test's metric means over its repeats (tracking, symmetry, drift, ...);
//   - the benchmark's task values with their 95% intervals.
// Outcomes come from summarizeTests (summary.js), the code that scores
// survival_rate, so "passed" here is exactly a 1 there. Pure: no DOM.

import { parseBenchmark, versionedTaskId } from './settings.js';
import { isComplete, summarize } from './run.js';
import { METRICS } from './summary.js';
import { rowToSequence } from './testRow.js';
import { goalOutcome } from '../simulation/metrics.js';

const mean = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : null;
};

/**
 * Per-cell numbers averaged over a test's repeats (errored repeats left out),
 * then over tests for a policy's overall mean.
 */
export const MEANS = [
  {
    key: 'trackRmse', label: 'Track RMSE', unit: '', digits: 3, higherIsBetter: false,
    description: 'Command tracking error, mean of the vx, vy and wz RMSE',
    of: (m) => { const o = m.commandTracking?.overall ?? {}; return mean([o.vx, o.vy, o.wz]); },
  },
  { key: 'symmetry', label: 'Symmetry', unit: '%', digits: 1, higherIsBetter: true, description: 'Gait symmetry score', of: (m) => m.gaitSymmetry?.symmetryScorePercent },
  { key: 'finalDrift', label: 'Final drift', unit: 'm', digits: 2, higherIsBetter: false, description: 'Distance from the canonical path at the end', of: (m) => m.drift?.final_m },
  { key: 'jerk', label: 'Jerk', unit: '', digits: 3, higherIsBetter: false, description: 'Action jerk-like score', of: (m) => m.actionSmoothness?.jerkLikeScore },
  { key: 'rmsDelta', label: 'RMS action Δ', unit: '', digits: 4, higherIsBetter: false, description: 'RMS change of the action between steps', of: (m) => m.actionSmoothness?.rmsDelta },
  { key: 'pushScore', label: 'Push score', unit: '', digits: 2, higherIsBetter: true, description: 'Mean push recovery score', of: (m) => m.perturbations?.meanScore },
];

export function fmt(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

/** "0.75 [0.41, 0.93]", or "n/a" for a task with nothing in scope. */
export function formatTask(task, digits = 2) {
  if (!task || task.value === null) return 'n/a';
  return task.ci95 ? `${fmt(task.value, digits)} [${fmt(task.ci95[0], digits)}, ${fmt(task.ci95[1], digits)}]` : fmt(task.value, digits);
}

/**
 * How one repeat ended. kind is passed | fell | missed | error; text is what a
 * table cell shows, detail the error or capture warning behind it.
 */
function outcomeOf(cell, fellAt, missed, row) {
  const base = { repeat: cell.repeat, seed: cell.seed, cell, detail: cell.warning || null };
  if (cell.error || !cell.metrics) return { ...base, kind: 'error', text: 'error', detail: cell.error || 'no metrics recorded' };
  if (fellAt !== null) {
    const text = cell.metrics.ending?.stood === false ? 'never stood up' : `fell at ${fmt(fellAt, 1)} s`;
    return { ...base, kind: 'fell', text, fellAt };
  }
  if (missed) {
    const missBy = cell.metrics.goal?.miss_m ?? goalOutcome(cell.metrics.topDown?.actual, row.goal).miss_m;
    return { ...base, kind: 'missed', text: missBy === null ? 'missed end zone' : `missed end zone by ${fmt(missBy, 2)} m`, missBy };
  }
  return { ...base, kind: 'passed', text: 'passed' };
}

const countKinds = (outcomes) => {
  const counts = { passed: 0, fell: 0, missed: 0, error: 0, total: 0 };
  for (const outcome of outcomes) if (outcome) { counts[outcome.kind] += 1; counts.total += 1; }
  return counts;
};

function pushTotals(cells) {
  const pushes = cells.map((cell) => cell.metrics?.perturbations).filter((p) => p?.total);
  return pushes.length ? { survived: pushes.reduce((s, p) => s + p.survived, 0), total: pushes.reduce((s, p) => s + p.total, 0) } : null;
}

/**
 * @returns {{ benchmark, generatedAt, complete, shard, expectedCells, cellCount, tests, policies }}
 *   tests:    [{ id, name, config, duration, goal, sequence, repeats: [{ repeat, seed }] }]
 *   policies: [{ key, label, id, counts, means, pushes, tasks, tests: [{ testId, outcomes, counts, means, pushes }] }]
 *   A policy test's outcomes line up with its test's repeats (null where a
 *   partial result has no cell). tasks is null unless the result is complete.
 */
export function resultView(result) {
  const benchmark = parseBenchmark(result.benchmark.raw);
  const complete = isComplete(result);
  const { perTest, tasks } = summarize(result);

  const tests = result.tests.map((row) => {
    const repeats = new Map();
    for (const cell of result.cells) if (cell.testId === row.id && !repeats.has(cell.repeat)) repeats.set(cell.repeat, cell.seed);
    return {
      id: row.id,
      name: row.name || row.id,
      config: row.config,
      duration: row.duration,
      goal: row.goal ?? null,
      sequence: rowToSequence(row),
      repeats: [...repeats].sort((a, b) => a[0] - b[0]).map(([repeat, seed]) => ({ repeat, seed })),
    };
  });
  const rowsById = new Map(result.tests.map((row) => [row.id, row]));

  const policies = result.policies.map((policy) => {
    const summaries = new Map(perTest[policy.key].map((summary) => [summary.testId, summary]));
    const policyTests = tests.map((test) => {
      const row = rowsById.get(test.id);
      const cells = result.cells.filter((cell) => cell.policyKey === policy.key && cell.testId === test.id).sort((a, b) => a.repeat - b.repeat);
      const summary = summaries.get(test.id);
      const outcomes = test.repeats.map(({ repeat }) => {
        const i = cells.findIndex((cell) => cell.repeat === repeat);
        return i < 0 ? null : outcomeOf(cells[i], summary.fellAt[i], summary.missedGoal[i], row);
      });
      const scored = cells.filter((cell) => !cell.error && cell.metrics);
      return {
        testId: test.id,
        outcomes,
        counts: countKinds(outcomes),
        means: Object.fromEntries(MEANS.map((m) => [m.key, mean(scored.map((cell) => m.of(cell.metrics)))])),
        pushes: pushTotals(scored),
      };
    });
    const ran = policyTests.filter((test) => test.counts.total);
    const pushes = pushTotals(result.cells.filter((cell) => cell.policyKey === policy.key && !cell.error));
    return {
      key: policy.key,
      label: policy.label,
      id: policy.id,
      counts: countKinds(policyTests.flatMap((test) => test.outcomes)),
      means: Object.fromEntries(MEANS.map((m) => [m.key, mean(ran.map((test) => test.means[m.key]))])),
      pushes,
      tasks: complete ? tasks[policy.key].map((task) => {
        const definition = benchmark.tasks.find((t) => versionedTaskId(benchmark, t) === task.taskId);
        return { ...task, id: definition?.id ?? task.taskId, description: definition?.description ?? METRICS[task.metric]?.description ?? '' };
      }) : null,
      tests: policyTests,
    };
  });

  return {
    benchmark: { name: benchmark.name, title: benchmark.title || benchmark.name, version: benchmark.version, id: result.benchmark.id ?? null },
    generatedAt: result.generatedAt ?? null,
    complete,
    shard: result.shard ?? null,
    expectedCells: result.expectedCells,
    cellCount: result.cells.length,
    tests,
    policies,
  };
}
