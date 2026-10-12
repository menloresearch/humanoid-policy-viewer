// Checks a loaded benchmark (loadBenchmarkDir() has already validated the row
// schema and benchmark.yaml) before anything runs: every test must load in the
// command player, no terrain course may overlap the spawn area, the
// benchmark's selection must work, and a few likely mistakes
// are flagged. `npm run benchmark` runs this before starting the browser and
// `npm run hf publish` before uploading.

import { commandSequencer, setActiveCommandLimits } from '../src/simulation/commandSequencer.js';
import { expandCells, selectTests } from '../src/benchmark/settings.js';
import { commandedEnd, goalProblems, terrainProblems } from '../src/benchmark/terrainCheck.js';
import { rowToSequence } from '../src/benchmark/testRow.js';

/** Returns { errors, warnings }; errors mean the benchmark cannot run as written. */
export function checkTests({ benchmark, rows }) {
  const errors = [];
  const warnings = [];
  try {
    const cells = expandCells(selectTests(benchmark, rows));
    const unused = rows.filter((row) => !cells.some((cell) => cell.testId === row.id));
    if (unused.length) warnings.push(`not selected by benchmark.yaml tests, so never run: ${unused.map((row) => row.id).join(', ')}`);
  } catch (error) {
    errors.push(error.message);
  }
  // The player's own checks (event shapes, times, directions). No policy is
  // loaded here, so command values are compared with the default range.
  setActiveCommandLimits(null);
  for (const row of rows) {
    try {
      const { warning } = commandSequencer.loadSequence(rowToSequence(row), row.name);
      if (warning) warnings.push(`${row.id}: ${warning} (default command range)`);
    } catch (error) {
      errors.push(`${row.id}: ${error.message}`);
    }
    commandSequencer.stop({ zero: true });
    if (row.terrain) {
      const terrain = terrainProblems(rowToSequence(row));
      errors.push(...terrain.errors.map((e) => `${row.id}: ${e}`));
      warnings.push(...terrain.warnings.map((w) => `${row.id}: ${w}`));
    }
    warnings.push(...goalProblems(rowToSequence(row)).map((w) => `${row.id}: ${w}`));
  }
  return { errors, warnings };
}

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
