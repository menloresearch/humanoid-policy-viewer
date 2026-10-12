import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmarkDir } from '../../scripts/benchmarkDir.mjs';
import {
  RESULT_SCHEMA, cellResult, groupCells, isComplete, mergeResults, planCells, resultForPolicy, sortCells, summarize,
} from './run.js';

const smokeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'smoke-benchmark');

function fakeResult(overrides = {}) {
  const raw = {
    name: 'smoke', version: 1, harness: { protocol: 1 }, requires: {},
    tests: [{ config: 'a' }], tasks: [{ id: 'survival_rate', metric: 'survival_rate@1' }],
  };
  const row = {
    id: 'a/x', config: 'a', schema_version: 1, kind: 'velocity-sequence', name: 'x', description: '', tags: [], duration: 1,
    commands: [{ t: 0, vx: 0, vy: 0, wz: 0 }], events: [], limits: null, foot_friction: null, terrain: null, metrics_opt_in: [],
  };
  return {
    schema: RESULT_SCHEMA,
    generatedAt: '2026-10-02T00:00:00.000Z',
    provenance: { hpv: { commit: 'c'.repeat(40), dirty: false, protocol: 1 }, asimov1: { commit: 'a'.repeat(40) }, runtime: {} },
    benchmark: { source: 'hub', id: 'org/bench', sha: 'd'.repeat(40), raw, problems: [] },
    overrides: { tests: null, repeats: null, force: false },
    shard: null,
    policies: [{ key: 'm0', id: 'org/model', label: 'org/model', source: 'hub', repo: 'org/model', sha: 'e'.repeat(40), files: {} }],
    tests: [row],
    expectedCells: 1,
    cells: [{ policyKey: 'm0', cellId: 'a/x#0', testId: 'a/x', repeat: 0, metrics: { fell: { fell: false } } }],
    ...overrides,
  };
}

test('a benchmark plans one seeded cell per repeat of each selected test', () => {
  const { benchmark, rows } = loadBenchmarkDir(smokeDir);
  const { cells, tests } = planCells(benchmark, rows);
  assert.deepEqual(tests.map((row) => row.id), rows.map((row) => row.id));
  assert.equal(cells.length, rows.length * 2);
  assert.deepEqual(cells.map((cell) => cell.cellId), rows.flatMap((row) => [`${row.id}#0`, `${row.id}#1`]));
  assert.ok(cells.every((cell) => Number.isInteger(cell.seed) && cell.randomize && cell.timeoutS === 300));
  assert.equal(new Set(cells.map((cell) => cell.seed)).size, cells.length);
  // Planning is deterministic, so the CLI and the viewer plan the same seeds.
  assert.deepEqual(planCells(benchmark, rows).cells, cells);
  assert.deepEqual(groupCells(cells).map((group) => group.length), [2, 2]);

  const narrowed = planCells(benchmark, rows, { only: [rows[0].id], repeats: 3 });
  assert.deepEqual(narrowed.tests.map((row) => row.id), [rows[0].id]);
  assert.deepEqual(narrowed.cells.map((cell) => cell.repeat), [0, 1, 2]);
});

test('a cell records what the page returned, with defaults for what it did not', () => {
  const cell = { cellId: 'a/x#1', testId: 'a/x', repeat: 1, seed: 42 };
  assert.deepEqual(cellResult('m0', cell, { frames: 50, metrics: { fell: { fell: false } } }, 1234), {
    policyKey: 'm0', cellId: 'a/x#1', testId: 'a/x', repeat: 1, seed: 42,
    frames: 50, expectedFrames: null, error: null, warning: null, clampedCommands: 0, appliedCommands: null, actionDelayLag: null,
    wallMs: 1234, metrics: { fell: { fell: false } },
  });
  const sorted = sortCells([{ policyKey: 'm1', cellId: 'a#0' }, { policyKey: 'm0', cellId: 'b#0' }, { policyKey: 'm0', cellId: 'a#1' }]);
  assert.deepEqual(sorted.map((c) => `${c.policyKey}|${c.cellId}`), ['m0|a#1', 'm0|b#0', 'm1|a#0']);
});

test('a complete result is summarised per policy; a shard or a short result is not complete', () => {
  const result = fakeResult();
  assert.ok(isComplete(result));
  assert.ok(!isComplete(fakeResult({ cells: [] })));
  assert.ok(!isComplete(fakeResult({ shard: { index: 1, count: 2 } })));
  const { perTest, tasks } = summarize(result);
  assert.deepEqual(Object.keys(perTest), ['m0']);
  assert.equal(tasks.m0[0].value, 1);
});

test('a result splits per policy, one repo each', () => {
  const two = fakeResult({ expectedCells: 2 });
  two.policies.push({ ...two.policies[0], key: 'm1', id: 'org/other', label: 'org/other' });
  two.cells.push({ ...two.cells[0], policyKey: 'm1' });
  Object.assign(two, summarize(two));
  const one = resultForPolicy(two, 'm1');
  assert.deepEqual(one.policies.map((p) => p.key), ['m1']);
  assert.equal(one.expectedCells, 1);
  assert.deepEqual(Object.keys(one.tasks), ['m1']);

});

test('merge needs every shard of the same run exactly once', () => {
  const base = fakeResult({ expectedCells: 2 });
  const s1 = { ...base, shard: { index: 1, count: 2 }, cells: [{ ...base.cells[0], cellId: 'a/x#0' }] };
  const s2 = { ...base, shard: { index: 2, count: 2 }, cells: [{ ...base.cells[0], cellId: 'a/x#1', repeat: 1 }] };
  const merged = mergeResults([s1, s2]);
  assert.equal(merged.cells.length, 2);
  assert.equal(merged.shard, null);
  assert.ok(merged.tasks.m0);
  assert.throws(() => mergeResults([s1]), /shards 1\.\.2|cells/);
  assert.throws(() => mergeResults([s1, s1]), /more than one input/);
  const other = { ...s2, provenance: { ...s2.provenance, hpv: { ...s2.provenance.hpv, commit: 'f'.repeat(40) } } };
  assert.throws(() => mergeResults([s1, other]), /different run/);
});
