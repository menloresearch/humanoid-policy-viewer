// The parts of a benchmark run that do not need a browser: which jobs a shard
// runs and in what order, the result.json format, per-policy summaries, whether a
// result may be uploaded, and merging shard outputs. run-benchmark.mjs wires
// these to the browser pool (benchmarkBrowser.mjs).
//
// result.json (schema "hpv-benchmark-result/1") is self-contained: it embeds the
// benchmark.yaml and test rows it ran, so it can be summarised, merged and turned
// into a report without the benchmark or the policies.

import { parseBenchmark, selectTests, versionedTaskId } from '../src/benchmark/settings.js';
import { computeTasks, summarizeTests } from '../src/benchmark/summary.js';
import { rowToSequence } from '../src/benchmark/testRow.js';
import { MAX_ROBOTS } from '../src/simulation/benchmarkRunner.js';

export { MAX_ROBOTS };

export const RESULT_SCHEMA = 'hpv-benchmark-result/1';

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

/** "2/3" -> { index: 2, count: 3 } (1-based index). */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`shard= must look like 1/4 (got "${text}")`);
  return { index, count };
}

/** A deterministic, work-balanced slice of the jobs: every count-th one (whole groups, so every cell once). */
export function shardJobs(jobs, shard) {
  if (!shard) return jobs;
  return jobs.filter((_, i) => i % shard.count === shard.index - 1);
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

/** Per-policy summaries and task values; only meaningful for a complete run. */
export function summarizeRun(run) {
  const benchmark = parseBenchmark(run.benchmark.raw);
  // run.tests holds only the tests that ran (tests=<id> narrows it), so some selectors may match nothing.
  const selected = selectTests(benchmark, run.tests, { requireMatches: false });
  const wanted = new Set(run.tests.map((row) => row.id));
  const perTest = {};
  const tasks = {};
  for (const policy of run.policies) {
    const cells = run.cells.filter((cell) => cell.policyKey === policy.key && wanted.has(cell.testId));
    perTest[policy.key] = summarizeTests(cells, selected.filter(({ row }) => cells.some((cell) => cell.testId === row.id)));
    tasks[policy.key] = computeTasks(benchmark, perTest[policy.key]);
  }
  return { perTest, tasks };
}

export function isComplete(run) {
  return run.cells.length === run.expectedCells && !run.shard;
}

/**
 * Why the results of `policyKey` may not be submitted (empty = they may), from
 * what result.json recorded at run time. Results are shared only when they can be
 * reproduced: a Hub benchmark pinned to a commit, a Hub policy, a clean viewer
 * commit implementing the benchmark's protocol, the whole benchmark as specified,
 * and no errors.
 */
export function uploadBlockers(run, policyKey) {
  const reasons = [];
  const policy = run.policies.find((p) => p.key === policyKey);
  if (run.benchmark.source !== 'hub') reasons.push('the benchmark is a local folder, not a Hugging Face benchmark dataset');
  else if (!run.benchmark.sha) reasons.push('the benchmark is not pinned to a dataset commit');
  if (policy?.source !== 'hub') reasons.push('the policy is a local folder, not a Hugging Face model repo');
  else if (!policy.sha) reasons.push(`${policy.label} is not pinned to a model commit`);
  const protocol = run.benchmark.raw?.harness?.protocol;
  if (protocol !== run.provenance.hpv.protocol) reasons.push(`the benchmark needs protocol ${protocol}, the viewer that ran it implements ${run.provenance.hpv.protocol}`);
  if (run.benchmark.problems?.length) reasons.push(`this viewer cannot run the benchmark as published: ${run.benchmark.problems.join('; ')}`);
  if (!run.provenance.hpv.commit) reasons.push('the viewer commit is unknown (not a git checkout)');
  else if (run.provenance.hpv.dirty !== false) reasons.push('the viewer checkout has uncommitted changes, so the commit does not identify the code that ran');
  if (run.overrides.tests) reasons.push('only some tests were run (tests=)');
  if (run.overrides.repeats) reasons.push('the repeat count was overridden (repeats=)');
  if (run.overrides.force) reasons.push('the run was forced past a compatibility check (force)');
  if (run.shard) reasons.push(`this is shard ${run.shard.index}/${run.shard.count}; merge the shards first (npm run benchmark merge ...)`);
  else if (run.cells.length !== run.expectedCells) reasons.push(`${run.expectedCells - run.cells.length} of ${run.expectedCells} cells are missing`);
  const errors = run.cells.filter((cell) => cell.policyKey === policyKey && cell.error);
  if (errors.length) reasons.push(`${errors.length} cell(s) failed to run, e.g. ${errors[0].cellId}: ${errors[0].error}`);
  return reasons;
}

/**
 * What to tell the user at the end of a run in `dir`: the `npm run hf submit`
 * command when some policy's results can be submitted, and why not for the rest
 * (a reason every policy shares is listed once).
 */
export function submitHint(run, dir) {
  const blockers = new Map(run.policies.map((policy) => [policy, uploadBlockers(run, policy.key)]));
  const shared = [...blockers.values()].reduce((common, reasons) => common.filter((r) => reasons.includes(r)));
  const lines = [];
  if ([...blockers.values()].some((reasons) => !reasons.length)) lines.push(`Submit to the Hub with: npm run hf submit ${dir} [pr] [dry-run]`);
  const own = [...blockers].flatMap(([policy, reasons]) => reasons.filter((r) => !shared.includes(r)).map((r) => `${policy.label}: ${r}`));
  if (shared.length || own.length) {
    lines.push(`${lines.length ? 'Not submittable' : 'Cannot be submitted to the Hub'}:`, ...[...shared, ...own].map((r) => `  - ${r}`));
  }
  return lines;
}

/** Fields that must be identical across shards for them to be merged. */
function mergeIdentity(run) {
  return JSON.stringify({
    schema: run.schema,
    hpv: run.provenance.hpv,
    asimov1: run.provenance.asimov1,
    benchmark: { source: run.benchmark.source, id: run.benchmark.id, sha: run.benchmark.sha, path: run.benchmark.path, raw: run.benchmark.raw },
    tests: run.tests.map((row) => row.id),
    overrides: run.overrides,
    policies: run.policies.map(({ key, id, sha, files }) => ({ key, id, sha, files })),
    expectedCells: run.expectedCells,
  });
}

/** Merges the shard results of one run; refuses mismatched runs or missing cells. */
export function mergeResults(runs) {
  if (!runs.length) throw new Error('Nothing to merge');
  const identity = mergeIdentity(runs[0]);
  runs.forEach((run, i) => {
    if (run.schema !== RESULT_SCHEMA) throw new Error(`input ${i + 1} is not a ${RESULT_SCHEMA} file`);
    if (mergeIdentity(run) !== identity) {
      throw new Error(`input ${i + 1} is from a different run (viewer commit, benchmark, policies or options differ) and cannot be merged`);
    }
  });
  const byKey = new Map();
  for (const run of runs) {
    for (const cell of run.cells) {
      const key = cellKey(cell.policyKey, cell.cellId);
      if (byKey.has(key)) throw new Error(`cell ${key} appears in more than one input`);
      byKey.set(key, cell);
    }
  }
  const shards = runs.map((run) => run.shard).filter(Boolean);
  if (shards.length !== runs.length) throw new Error('only shard outputs (shard=i/n) can be merged');
  const count = shards[0].count;
  const indices = new Set(shards.map((shard) => shard.index));
  if (shards.some((shard) => shard.count !== count) || indices.size !== count) {
    throw new Error(`expected shards 1..${count} exactly once each, got ${shards.map((s) => `${s.index}/${s.count}`).join(', ')}`);
  }
  const merged = { ...runs[0], generatedAt: new Date().toISOString(), shard: null, mergedFrom: shards, cells: [...byKey.values()] };
  if (merged.cells.length !== merged.expectedCells) {
    throw new Error(`merged run has ${merged.cells.length} of ${merged.expectedCells} cells`);
  }
  return { ...merged, ...summarizeRun(merged) };
}

/** A copy of the result with only one policy's cells and summaries, for that policy's repo. */
export function resultForPolicy(run, policyKey) {
  return {
    ...run,
    policies: run.policies.filter((policy) => policy.key === policyKey),
    cells: run.cells.filter((cell) => cell.policyKey === policyKey),
    expectedCells: run.expectedCells / run.policies.length,
    perTest: run.perTest ? { [policyKey]: run.perTest[policyKey] } : undefined,
    tasks: run.tasks ? { [policyKey]: run.tasks[policyKey] } : undefined,
  };
}

/**
 * The shape src/simulation/benchmarkReport.js renders ({ policies, tests,
 * results }). Each repeat becomes its own report row ("<test id> #<repeat>")
 * when a test runs more than once.
 */
export function toReportRun(run) {
  const repeated = new Set(run.cells.filter((cell) => cell.repeat > 0).map((cell) => cell.testId));
  const label = (cell) => (repeated.has(cell.testId) ? `${cell.testId} #${cell.repeat}` : cell.testId);
  const rowsById = new Map(run.tests.map((row) => [row.id, row]));
  const tests = new Map();
  for (const cell of [...run.cells].sort((a, b) => a.cellId.localeCompare(b.cellId))) {
    const file = label(cell);
    if (tests.has(file)) continue;
    const row = rowsById.get(cell.testId);
    tests.set(file, { file, name: repeated.has(cell.testId) ? `${row.name} #${cell.repeat}` : row.name, duration: row.duration, sequence: rowToSequence(row) });
  }
  return {
    generatedAt: run.generatedAt,
    policies: run.policies.map((policy) => ({ id: policy.key, label: policy.label, configPath: null, onnxPath: null })),
    tests: [...tests.values()],
    results: run.cells.map((cell) => ({
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

/** Task values of one policy as `task: value` lines, for the console. */
export function formatTasks(run, policyKey) {
  const benchmark = parseBenchmark(run.benchmark.raw);
  return (run.tasks?.[policyKey] ?? []).map((task) => {
    const definition = benchmark.tasks.find((t) => versionedTaskId(benchmark, t) === task.taskId);
    const direction = task.higherIsBetter ? '' : ' (lower is better)';
    const value = task.value === null ? 'n/a (nothing in scope)' : `${task.value}${task.ci95 ? `  [${task.ci95[0]}, ${task.ci95[1]}]` : ''}`;
    const counts = task.value === null ? '' : `  (${task.tests} tests, ${task.cells} runs)`;
    return `${task.taskId.padEnd(40)} ${value}${direction}${counts}${definition?.description ? `  ${definition.description}` : ''}`;
  });
}

/** How one policy's runs ended, keeping a fall apart from staying upright but missing the end zone. */
export function formatOutcomes(run, policyKey) {
  const tests = run.perTest?.[policyKey] ?? [];
  const runs = tests.reduce((sum, test) => sum + test.repeats, 0);
  if (!runs) return null;
  const errors = tests.reduce((sum, test) => sum + test.errors, 0);
  const fell = tests.reduce((sum, test) => sum + test.fellAt.filter((t) => t !== null).length, 0) - errors;
  const missed = tests.flatMap((test) => (test.missedGoal ?? []).some(Boolean) ? [`${test.testId} ${test.missedGoal.filter(Boolean).length}/${test.repeats}`] : []);
  const missedRuns = tests.reduce((sum, test) => sum + (test.missedGoal ?? []).filter(Boolean).length, 0);
  const passed = runs - errors - fell - missedRuns;
  return `Outcomes: ${passed}/${runs} passed, ${fell} fell, ${missedRuns} upright but missed the end zone${missed.length ? ` (${missed.join(', ')})` : ''}${errors ? `, ${errors} errored` : ''}`;
}
