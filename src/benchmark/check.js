// Checks a benchmark's settings and rows (already schema-validated) before
// anything runs: every test must load in the command player, no terrain course
// may overlap the spawn area, the benchmark's selection must work, and a few
// likely mistakes are flagged. `npm run benchmark` and the viewer's Run both run
// this first; the inspect command (scripts/inspect.mjs) reports it to publishers.

import { commandSequencer, getActiveCommandLimits, setActiveCommandLimits } from '../simulation/commandSequencer.js';
import { expandCells, selectTests } from './settings.js';
import { goalProblems, terrainProblems } from './terrainCheck.js';
import { rowToSequence } from './testRow.js';

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
  // The player's own checks (event shapes, times, directions). Command values
  // are compared with the default range, not the loaded policy's, which is put
  // back afterwards (in the viewer a policy may be loaded).
  const policyLimits = getActiveCommandLimits();
  setActiveCommandLimits(null);
  try {
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
  } finally {
    setActiveCommandLimits(policyLimits);
  }
  return { errors, warnings };
}
