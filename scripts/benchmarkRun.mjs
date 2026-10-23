// The command-line half of a benchmark run: shard slicing and console summaries. The rest (planning, job order,
// the result.json format, summaries, merging, the report shape) is
// src/benchmark/run.js, which the viewer's Run shares.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseBenchmark, versionedTaskId } from '../src/benchmark/settings.js';

/** "2/3" -> { index: 2, count: 3 } (1-based index). */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`shard= must look like 1/4 (got "${text}")`);
  return { index, count };
}

/** tests=<id,id> as a list of ids, or null when not given; a list with no ids is an error. */
export function parseTests(text) {
  if (text === undefined) return null;
  const ids = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`tests= names no test ids (got "${text}")`);
  return ids;
}

/** A deterministic, work-balanced slice of the jobs: every count-th one (whole groups, so every cell once). */
export function shardJobs(jobs, shard) {
  if (!shard) return jobs;
  return jobs.filter((_, i) => i % shard.count === shard.index - 1);
}

/**
 * The result `npm run benchmark view` was given: a result folder or its result.json.
 * The viewer reads results as <folder>/result.json under one directory, so that
 * directory is the folder's parent, and the folder name is limited to what it lists.
 */
export function resultTarget(word) {
  const path = resolve(word);
  const file = basename(path) === 'result.json' ? path : join(path, 'result.json');
  if (!existsSync(file)) throw new Error(`${word} has no result.json; give a result folder written by npm run benchmark (benchmark_results/<timestamp>) or its result.json`);
  const dir = dirname(file);
  const name = basename(dir);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`The viewer opens result folders named with letters, digits, - and _ only; rename ${dir}`);
  return { dir, name, resultsDir: dirname(dir), file: `${name}/result.json` };
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
