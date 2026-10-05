// Checks a loaded benchmark (loadSuiteDir() has already validated the row
// schema and suite.yaml) before anything runs: every test must load in the
// command player, the suite's selection must work, and a few likely mistakes
// are flagged. `npm run benchmark` runs this before starting the browser and
// `npm run suite publish` before uploading.

import { commandSequencer, setActiveCommandLimits } from '../src/simulation/commandSequencer.js';
import { expandCells, selectTests } from '../src/benchmark/suite.js';
import { rowToSequence } from '../src/benchmark/testRow.js';

/** Returns { errors, warnings }; errors mean the benchmark cannot run as written. */
export function checkTests({ suite, rows }) {
  const errors = [];
  const warnings = [];
  try {
    const cells = expandCells(selectTests(suite, rows));
    const unused = rows.filter((row) => !cells.some((cell) => cell.testId === row.id));
    if (unused.length) warnings.push(`not selected by suite.yaml tests, so never run: ${unused.map((row) => row.id).join(', ')}`);
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
    const untiered = row.events.filter((event) => event.type === 'push' && !event.tier);
    if (untiered.length && row.events.some((event) => event.tier)) {
      warnings.push(`${row.id}: ${untiered.length} push(es) without a tier, next to tiered ones`);
    }
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
