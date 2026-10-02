// The parts of a benchmark run that do not need a browser: which jobs a shard
// runs and in what order, the run.json format, per-model summaries, whether a
// result may be uploaded, and merging shard outputs. run-benchmark.mjs wires
// these to the browser pool (benchmarkBrowser.mjs).
//
// run.json (schema "hpv-benchmark-run/1") is self-contained: it embeds the
// suite.yaml and test rows it ran, so it can be summarised, merged and turned
// into a report without the dataset or the models.

import { parseSuite, selectTests, versionedTaskId } from '../src/benchmark/suite.js';
import { computeTasks, summarizeTests } from '../src/benchmark/summary.js';
import { rowToSequence } from '../src/benchmark/testRow.js';

export const RUN_SCHEMA = 'hpv-benchmark-run/1';

/** Every (model, cell) job, in the order a shard partition and the queue use. */
export function buildJobs(models, cells) {
  const jobs = [];
  for (const model of models) for (const cell of cells) jobs.push({ modelKey: model.key, cell });
  // Longest first, so a long test never starts last and holds up the whole run.
  return jobs.sort((a, b) => b.cell.duration - a.cell.duration
    || a.modelKey.localeCompare(b.modelKey)
    || a.cell.cellId.localeCompare(b.cell.cellId));
}

/** "2/3" -> { index: 2, count: 3 } (1-based index). */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`shard= must look like 1/4 (got "${text}")`);
  return { index, count };
}

/** A deterministic, duration-balanced slice of the jobs: every count-th one. */
export function shardJobs(jobs, shard) {
  if (!shard) return jobs;
  return jobs.filter((_, i) => i % shard.count === shard.index - 1);
}

/** Next job for a page that last ran `lastModelKey`; prefers the same model to avoid a reload. */
export function takeNextJob(queue, lastModelKey) {
  if (!queue.length) return null;
  let index = queue.findIndex((job) => job.modelKey === lastModelKey);
  if (index < 0) index = 0;
  return queue.splice(index, 1)[0];
}

export function cellKey(modelKey, cellId) {
  return `${modelKey}|${cellId}`;
}

/** Per-model summaries and task values; only meaningful for a complete run. */
export function summarizeRun(run) {
  const suite = parseSuite(run.suite.raw);
  const selected = selectTests(suite, run.tests);
  const wanted = new Set(run.tests.map((row) => row.id));
  const perTest = {};
  const tasks = {};
  for (const model of run.models) {
    const cells = run.cells.filter((cell) => cell.modelKey === model.key && wanted.has(cell.testId));
    perTest[model.key] = summarizeTests(cells, selected.filter(({ row }) => cells.some((cell) => cell.testId === row.id)));
    tasks[model.key] = computeTasks(suite, perTest[model.key]);
  }
  return { perTest, tasks };
}

export function isComplete(run) {
  return run.cells.length === run.expectedCells && !run.shard;
}

/**
 * Why the results of `modelKey` may not be uploaded (empty = they may).
 * Results are shared only when they can be reproduced: a released suite, a Hub
 * model, a clean viewer commit implementing the suite's protocol, the whole
 * suite as specified, and no errors.
 */
export function uploadBlockers(run, modelKey) {
  const reasons = [];
  const model = run.models.find((m) => m.key === modelKey);
  if (run.suite.source !== 'hub') reasons.push('the suite is a local folder, not a Hugging Face benchmark dataset');
  if (model?.source !== 'hub') reasons.push('the model is a local folder, not a Hugging Face model repo');
  if (run.suite.problems?.length) reasons.push(`this viewer cannot run the suite as published: ${run.suite.problems.join('; ')}`);
  if (run.provenance.hpv.dirty) reasons.push('the viewer checkout has uncommitted changes, so the commit does not identify the code that ran');
  if (!run.provenance.hpv.commit) reasons.push('the viewer commit is unknown (not a git checkout)');
  if (run.overrides.tests) reasons.push('only some tests were run (tests=)');
  if (run.overrides.repeats) reasons.push('the repeat count was overridden (repeats=)');
  if (run.overrides.force) reasons.push('the run was forced past a compatibility check (force)');
  if (run.shard) reasons.push(`this is shard ${run.shard.index}/${run.shard.count}; merge the shards first (npm run benchmark merge ...)`);
  else if (run.cells.length !== run.expectedCells) reasons.push(`${run.expectedCells - run.cells.length} of ${run.expectedCells} cells are missing`);
  const errors = run.cells.filter((cell) => cell.modelKey === modelKey && cell.error);
  if (errors.length) reasons.push(`${errors.length} cell(s) failed to run, e.g. ${errors[0].cellId}: ${errors[0].error}`);
  return reasons;
}

/** Fields that must be identical across shards for them to be merged. */
function mergeIdentity(run) {
  return JSON.stringify({
    schema: run.schema,
    hpv: run.provenance.hpv,
    asimov1: run.provenance.asimov1,
    suite: { source: run.suite.source, id: run.suite.id, sha: run.suite.sha, path: run.suite.path, suiteFile: run.suite.suiteFile, raw: run.suite.raw },
    tests: run.tests.map((row) => row.id),
    overrides: run.overrides,
    models: run.models.map(({ key, id, sha, files }) => ({ key, id, sha, files })),
    expectedCells: run.expectedCells,
  });
}

/** Merges shard outputs of one run; refuses mismatched runs or missing cells. */
export function mergeRuns(runs) {
  if (!runs.length) throw new Error('Nothing to merge');
  const identity = mergeIdentity(runs[0]);
  runs.forEach((run, i) => {
    if (run.schema !== RUN_SCHEMA) throw new Error(`input ${i + 1} is not a ${RUN_SCHEMA} file`);
    if (mergeIdentity(run) !== identity) {
      throw new Error(`input ${i + 1} is from a different run (viewer commit, suite, models or options differ) and cannot be merged`);
    }
  });
  const byKey = new Map();
  for (const run of runs) {
    for (const cell of run.cells) {
      const key = cellKey(cell.modelKey, cell.cellId);
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

/** A copy of the run with only one model's cells and summaries, for that model's repo. */
export function runForModel(run, modelKey) {
  return {
    ...run,
    models: run.models.filter((model) => model.key === modelKey),
    cells: run.cells.filter((cell) => cell.modelKey === modelKey),
    expectedCells: run.expectedCells / run.models.length,
    perTest: run.perTest ? { [modelKey]: run.perTest[modelKey] } : undefined,
    tasks: run.tasks ? { [modelKey]: run.tasks[modelKey] } : undefined,
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
    policies: run.models.map((model) => ({ id: model.key, label: model.label, configPath: null, onnxPath: null })),
    tests: [...tests.values()],
    results: run.cells.map((cell) => ({
      policyId: cell.modelKey,
      testFile: label(cell),
      frames: cell.frames,
      expectedFrames: cell.expectedFrames,
      warning: cell.warning,
      ...(cell.error ? { error: cell.error } : {}),
      metrics: cell.metrics,
    })),
  };
}

/** Task values of one model as `task: value` lines, for the console. */
export function formatTasks(run, modelKey) {
  const suite = parseSuite(run.suite.raw);
  return (run.tasks?.[modelKey] ?? []).map((task) => {
    const definition = suite.tasks.find((t) => versionedTaskId(suite, t) === task.taskId);
    const direction = task.higherIsBetter ? '' : ' (lower is better)';
    return `${task.taskId.padEnd(40)} ${task.value === null ? 'n/a (nothing in scope)' : task.value}${direction}${definition?.description ? `  ${definition.description}` : ''}`;
  });
}
