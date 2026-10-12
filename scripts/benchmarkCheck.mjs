// The command-line side of checking a loaded benchmark (loadBenchmarkDir() has
// already validated the row schema and benchmark.yaml); the checks themselves
// are src/benchmark/check.js, shared with the viewer's Run. `npm run benchmark`
// runs them before starting the browser and `npm run hf publish` before uploading.

import { checkTests } from '../src/benchmark/check.js';
import { commandedEnd, goalProblems } from '../src/benchmark/terrainCheck.js';
import { rowToSequence } from '../src/benchmark/testRow.js';

/** Prints the problems; throws if there are errors. */
export function assertTestsRunnable(loaded, { log = console.warn } = {}) {
  const { errors, warnings } = checkTests(loaded);
  for (const warning of warnings) log(`Warning: ${warning}`);
  if (errors.length) throw new Error(`The benchmark has errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return warnings;
}

/**
 * For `npm run benchmark path-end`: per test (all, or those in `ids`), where its
 * commands end the path and how its end zone relates to it.
 */
export function pathEnds(rows, ids = []) {
  const unknown = ids.filter((id) => !rows.some((row) => row.id === id));
  if (unknown.length) throw new Error(`Unknown test id(s): ${unknown.join(', ')}`);
  return rows.filter((r) => !ids.length || ids.includes(r.id)).map((row) => {
    const sequence = rowToSequence(row);
    const end = commandedEnd(sequence);
    const goal = row.goal;
    return {
      id: row.id,
      path_end: end,
      goal,
      goal_contains_end: goal ? (end.x - goal.x) ** 2 + (end.y - goal.y) ** 2 <= goal.radius_m ** 2 : null,
      path_enters_goal: goal ? goalProblems(sequence).length === 0 : null,
    };
  });
}
