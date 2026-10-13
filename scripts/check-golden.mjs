#!/usr/bin/env node
// npm run benchmark:golden [update]
//
// Guards BENCHMARK_PROTOCOL (src/benchmark/protocol.js): runs the smoke benchmark
// (test/fixtures/smoke-benchmark) on the bundled policy and compares the key
// per-cell numbers with test/fixtures/smoke-benchmark/golden.json. Run it before
// merging any change to the sim, the metrics or the runner. If per-run numbers
// moved on purpose, bump BENCHMARK_PROTOCOL and refresh the file with `update`;
// if only task values moved (a new metric or metric version), just `update`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = join(appDir, 'test/fixtures/smoke-benchmark');
const GOLDEN = join(BENCHMARK, 'golden.json');
const POLICY = join(appDir, 'public/examples/checkpoints/asimov/model_aug_18_1');

/** The numbers that must not move without a protocol bump. */
export function goldenView(run) {
  return {
    protocol: run.provenance.hpv.protocol,
    cells: Object.fromEntries([...run.cells].sort((a, b) => a.cellId.localeCompare(b.cellId)).map((cell) => [cell.cellId, {
      frames: cell.frames,
      actionDelayLag: cell.actionDelayLag,
      fell: cell.metrics?.fell ?? null,
      tracking: cell.metrics?.commandTracking?.overall ?? null,
      drift: cell.metrics?.drift ?? null,
      pushes: (cell.metrics?.perturbations?.events ?? []).map((event) => ({ recovered: event.recovered, peakInstability: event.peakInstability })),
    }])),
    tasks: run.tasks?.m0 ?? null,
  };
}

function main() {
  const out = mkdtempSync(join(tmpdir(), 'hpv-golden-'));
  process.on('exit', () => rmSync(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [join(appDir, 'scripts/run-benchmark.mjs'), POLICY, BENCHMARK, 'jobs=1', `out=${out}`], { cwd: appDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('The smoke run failed; see above.');
    process.exit(1);
  }
  const view = goldenView(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')));
  if (process.argv.includes('update')) {
    writeFileSync(GOLDEN, JSON.stringify(view, null, 2) + '\n');
    console.log(`Updated ${GOLDEN}`);
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  if (JSON.stringify(golden) === JSON.stringify(view)) {
    console.log(`Golden check passed (protocol ${BENCHMARK_PROTOCOL}).`);
    return;
  }
  const changed = Object.keys(view.cells).filter((id) => JSON.stringify(view.cells[id]) !== JSON.stringify(golden.cells?.[id]));
  if (!changed.length && Object.keys(golden.cells ?? {}).length === Object.keys(view.cells).length) {
    // Per-run numbers held; only the smoke benchmark's tasks or a metric definition moved.
    console.error('Only leaderboard task values changed; every per-run number is unchanged, so no protocol bump.');
    console.error('Adding a metric (or a new @version) is fine: npm run benchmark:golden update.');
    console.error('Never change what a published metric version computes; add the next version instead.');
    process.exit(1);
  }
  console.error(`Benchmark numbers changed (${changed.join(', ')}).`);
  if (golden.protocol === BENCHMARK_PROTOCOL) {
    console.error('If this is intended, bump BENCHMARK_PROTOCOL in src/benchmark/protocol.js and run: npm run benchmark:golden update');
  } else {
    console.error(`Protocol is now ${BENCHMARK_PROTOCOL} (golden is ${golden.protocol}); refresh it: npm run benchmark:golden update`);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
