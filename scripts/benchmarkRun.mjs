// The command-line half of a benchmark run: shard slicing, whether a result may
// be submitted to the Hub, and console summaries. The rest (planning, job order,
// the result.json format, summaries, merging, the report shape) is
// src/benchmark/run.js, which the viewer's Run shares.

import { parseBenchmark, versionedTaskId } from '../src/benchmark/settings.js';

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
