// The parts of a benchmark run that need neither a browser page nor Node: which
// cells a benchmark plans, how they are grouped into jobs and in what order, the
// result.json format, per-policy summaries, merging shard outputs and the report
// shape. `npm run benchmark` (scripts/run-benchmark.mjs) and the viewer's own
// Run (Demo.vue) both build their result.json with these, so the two agree.
//
// result.json (schema "hpv-benchmark-result/1") is self-contained: it embeds the
// benchmark.yaml and test rows it ran, so it can be summarised, merged and turned
// into a report without the benchmark or the policies.

import { expandCells, parseBenchmark, selectTests } from './settings.js';
import { computeTasks, summarizeTests } from './summary.js';
import { rowToSequence } from './testRow.js';
import { MAX_ROBOTS } from '../simulation/benchmarkRunner.js';

export { MAX_ROBOTS };

export const RESULT_SCHEMA = 'hpv-benchmark-result/1';

/**
 * The cells a benchmark runs ({ cellId, testId, repeat, seed, ... } per repeat
 * of each selected test) and the test rows they come from. `only` and `repeats`
 * narrow or override the benchmark, as tests= and repeats= do.
 */
export function planCells(benchmark, rows, { only = null, repeats = null } = {}) {
  const selected = selectTests(benchmark, rows);
  const cells = expandCells(selected, { only, repeats });
  const tests = selected.map(({ row }) => row).filter((row) => cells.some((cell) => cell.testId === row.id));
  return { cells, tests };
}

/**
 * The repeats of each test in groups of at most `maxRobots`, in repeat order
 * (12 repeats with 5 robots: 5, 5, 2). A page runs a group as that many robots
 * at once (runBenchmarkGroup); each cell keeps its own seed and result.
 */
export function groupCells(cells, maxRobots = MAX_ROBOTS) {
  const byTest = new Map();
  for (const cell of cells) {
    if (!byTest.has(cell.testId)) byTest.set(cell.testId, []);
    byTest.get(cell.testId).push(cell);
  }
  const groups = [];
  for (const testCells of byTest.values()) {
    testCells.sort((a, b) => a.repeat - b.repeat);
    for (let i = 0; i < testCells.length; i += maxRobots) groups.push(testCells.slice(i, i + maxRobots));
  }
  return groups;
}

/**
 * Every (policy, group of cells) job, in the order a shard partition and the
 * queue use. A job runs one test's repeats (up to `maxRobots`) on one page.
 */
export function buildJobs(policies, cells, { maxRobots = MAX_ROBOTS } = {}) {
  const jobs = [];
  for (const policy of policies) for (const group of groupCells(cells, maxRobots)) jobs.push({ policyKey: policy.key, cells: group });
  // Most work first (test length x robots), so a long job never starts last
  // and holds up the whole run.
  const work = (job) => job.cells[0].duration * job.cells.length;
  return jobs.sort((a, b) => work(b) - work(a)
    || a.policyKey.localeCompare(b.policyKey)
    || a.cells[0].cellId.localeCompare(b.cells[0].cellId));
}

/** Next job for a page that last ran `lastPolicyKey`; prefers the same policy to avoid a reload. */
export function takeNextJob(queue, lastPolicyKey) {
  if (!queue.length) return null;
  let index = queue.findIndex((job) => job.policyKey === lastPolicyKey);
  if (index < 0) index = 0;
  return queue.splice(index, 1)[0];
}

export function cellKey(policyKey, cellId) {
  return `${policyKey}|${cellId}`;
}

/** One result.json cell: what runBenchmarkGroup returned for `cell`, run by policy `policyKey`. */
export function cellResult(policyKey, cell, result, wallMs) {
  return {
    policyKey,
    cellId: cell.cellId,
    testId: cell.testId,
    repeat: cell.repeat,
    seed: cell.seed,
    frames: result.frames ?? 0,
    expectedFrames: result.expectedFrames ?? null,
    error: result.error ?? null,
    warning: result.warning ?? null,
    clampedCommands: result.clampedCommands ?? 0,
    appliedCommands: result.appliedCommands ?? null,
    actionDelayLag: result.actionDelayLag ?? null,
    wallMs,
    metrics: result.metrics ?? null,
  };
}

/** Cells in result.json order: by policy, then cell id. */
export function sortCells(cells) {
  return cells.sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.cellId.localeCompare(b.cellId));
}

/** Per-policy summaries and task values; only meaningful for a complete result. */
export function summarize(result) {
  const benchmark = parseBenchmark(result.benchmark.raw);
  // result.tests holds only the tests that ran (tests=<id> narrows it), so some selectors may match nothing.
  const selected = selectTests(benchmark, result.tests, { requireMatches: false });
  const wanted = new Set(result.tests.map((row) => row.id));
  const perTest = {};
  const tasks = {};
  for (const policy of result.policies) {
    const cells = result.cells.filter((cell) => cell.policyKey === policy.key && wanted.has(cell.testId));
    perTest[policy.key] = summarizeTests(cells, selected.filter(({ row }) => cells.some((cell) => cell.testId === row.id)));
    tasks[policy.key] = computeTasks(benchmark, perTest[policy.key]);
  }
  return { perTest, tasks };
}

export function isComplete(result) {
  return result.cells.length === result.expectedCells && !result.shard;
}

/** Fields that must be identical across shards for them to be merged. */
function mergeIdentity(result) {
  return JSON.stringify({
    schema: result.schema,
    hpv: result.provenance.hpv,
    asimov1: result.provenance.asimov1,
    benchmark: { source: result.benchmark.source, id: result.benchmark.id, sha: result.benchmark.sha, path: result.benchmark.path, raw: result.benchmark.raw },
    tests: result.tests.map((row) => row.id),
    overrides: result.overrides,
    policies: result.policies.map(({ key, id, sha, files }) => ({ key, id, sha, files })),
    expectedCells: result.expectedCells,
  });
}

/** Merges the shard results of one run; refuses mismatched runs or missing cells. */
export function mergeResults(results) {
  if (!results.length) throw new Error('Nothing to merge');
  const identity = mergeIdentity(results[0]);
  results.forEach((result, i) => {
    if (result.schema !== RESULT_SCHEMA) throw new Error(`input ${i + 1} is not a ${RESULT_SCHEMA} file`);
    if (mergeIdentity(result) !== identity) {
      throw new Error(`input ${i + 1} is from a different run (viewer commit, benchmark, policies or options differ) and cannot be merged`);
    }
  });
  const byKey = new Map();
  for (const result of results) {
    for (const cell of result.cells) {
      const key = cellKey(cell.policyKey, cell.cellId);
      if (byKey.has(key)) throw new Error(`cell ${key} appears in more than one input`);
      byKey.set(key, cell);
    }
  }
  const shards = results.map((result) => result.shard).filter(Boolean);
  if (shards.length !== results.length) throw new Error('only shard outputs (shard=i/n) can be merged');
  const count = shards[0].count;
  const indices = new Set(shards.map((shard) => shard.index));
  if (shards.some((shard) => shard.count !== count) || indices.size !== count) {
    throw new Error(`expected shards 1..${count} exactly once each, got ${shards.map((s) => `${s.index}/${s.count}`).join(', ')}`);
  }
  const merged = { ...results[0], generatedAt: new Date().toISOString(), shard: null, mergedFrom: shards, cells: [...byKey.values()] };
  if (merged.cells.length !== merged.expectedCells) {
    throw new Error(`merged run has ${merged.cells.length} of ${merged.expectedCells} cells`);
  }
  return { ...merged, ...summarize(merged) };
}

/** A copy of the result with only one policy's cells and summaries, for that policy's repo. */
export function resultForPolicy(result, policyKey) {
  return {
    ...result,
    policies: result.policies.filter((policy) => policy.key === policyKey),
    cells: result.cells.filter((cell) => cell.policyKey === policyKey),
    expectedCells: result.expectedCells / result.policies.length,
    perTest: result.perTest ? { [policyKey]: result.perTest[policyKey] } : undefined,
    tasks: result.tasks ? { [policyKey]: result.tasks[policyKey] } : undefined,
  };
}

/**
 * The shape src/simulation/benchmarkReport.js and the results view render
 * ({ policies, tests, results }). Each repeat becomes its own report row
 * ("<test id> #<repeat>") when a test runs more than once.
 */
export function toReport(result) {
  const repeated = new Set(result.cells.filter((cell) => cell.repeat > 0).map((cell) => cell.testId));
  const label = (cell) => (repeated.has(cell.testId) ? `${cell.testId} #${cell.repeat}` : cell.testId);
  const rowsById = new Map(result.tests.map((row) => [row.id, row]));
  const tests = new Map();
  for (const cell of [...result.cells].sort((a, b) => a.cellId.localeCompare(b.cellId))) {
    const file = label(cell);
    if (tests.has(file)) continue;
    const row = rowsById.get(cell.testId);
    tests.set(file, { file, name: repeated.has(cell.testId) ? `${row.name} #${cell.repeat}` : row.name, duration: row.duration, sequence: rowToSequence(row) });
  }
  return {
    generatedAt: result.generatedAt,
    policies: result.policies.map((policy) => ({ id: policy.key, label: policy.label, configPath: null, onnxPath: null })),
    tests: [...tests.values()],
    results: result.cells.map((cell) => ({
      policyId: cell.policyKey,
      testFile: label(cell),
      frames: cell.frames,
      expectedFrames: cell.expectedFrames,
      warning: cell.warning,
      ...(cell.error ? { error: cell.error } : {}),
      metrics: cell.metrics,
    })),
  };
}
