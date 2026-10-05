import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellSeed, mulberry32 } from './rng.js';
import { rowToSequence, sequenceToRow, validateTestRow } from './testRow.js';
import { buildEvalYaml, compatibilityProblems, expandCells, parseSuite, selectTests } from './suite.js';
import { computeTasks, summarizeTests } from './summary.js';
import { BENCHMARK_PROTOCOL } from './protocol.js';

const FIXTURE = new URL('../../test/fixtures/smoke-suite/', import.meta.url).pathname;

function row(id, extra = {}) {
  const [config] = id.split('/');
  return {
    id, config, schema_version: 1, kind: 'velocity-sequence', name: id, description: '', tags: [],
    duration: 4, commands: [{ t: 0, vx: 0.5, vy: 0, wz: 0 }], events: [], limits: null,
    foot_friction: null, metrics_opt_in: [], ...extra,
  };
}

const push = (t, force, tier) => ({
  t, type: 'push', dir: [1, 0], force, duration: 0.15, targetBody: null, torqueAxis: null, torqueMag: null, label: null, tier,
});

function suite(extra = {}) {
  return parseSuite({
    suite: 's', version: 2, harness: { protocol: BENCHMARK_PROTOCOL }, requires: { robot: { name: 'asimov-1' } },
    tests: [{ config: 'loco' }, { config: 'push' }],
    tasks: [{ id: 'upright_rate', metric: 'upright_rate' }],
    ...extra,
  });
}

test('seeds depend only on suite seed, test id and repeat', () => {
  assert.equal(cellSeed(0, 'a/b', 1), cellSeed(0, 'a/b', 1));
  assert.notEqual(cellSeed(0, 'a/b', 1), cellSeed(0, 'a/b', 2));
  assert.notEqual(cellSeed(0, 'a/b', 1), cellSeed(1, 'a/b', 1));
  const a = mulberry32(42);
  const b = mulberry32(42);
  const draws = Array.from({ length: 5 }, () => a());
  assert.deepEqual(draws, Array.from({ length: 5 }, () => b()));
  assert.ok(draws.every((x) => x >= 0 && x < 1));
});

test('a row survives the editor round trip (row -> sequence -> row)', async () => {
  const { readRows } = await import('../../scripts/suiteDir.mjs');
  const { rows } = readRows(FIXTURE);
  assert.ok(rows.length >= 2);
  for (const original of rows) {
    const sequence = rowToSequence(original);
    assert.equal(sequence.events?.[0]?.tier ?? null, original.events[0]?.tier ?? null);
    assert.equal(sequence.gaitSymmetry === true, original.metrics_opt_in.includes('gait_symmetry'));
    assert.deepEqual(sequenceToRow(original.id, sequence, original), original);
  }
});

test('a new category is just a new id prefix', () => {
  const created = sequenceToRow('stairs/up_10cm', { name: 'stairs', duration: 3, commands: [{ t: 0, vx: 0.3 }], footFriction: 0.5 });
  assert.equal(created.config, 'stairs');
  assert.deepEqual(validateTestRow(created), []);
});

test('row validation catches bad rows', () => {
  assert.deepEqual(validateTestRow(row('loco/a')), []);
  assert.ok(validateTestRow(row('loco/a', { config: 'other' })).length);
  assert.ok(validateTestRow(row('loco/a', { events: [push(1, 100, 'hard')] })).some((e) => e.includes('tier')));
  assert.ok(validateTestRow(row('loco/a', { kind: 'motion-tracking' })).some((e) => e.includes('kind')));
});

test('suite validation lists every problem at once', () => {
  assert.throws(
    () => parseSuite({ suite: 's', version: 0, harness: {}, requires: {}, tests: [], tasks: [{ id: 'x_v1', metric: 'nope' }] }),
    (error) => ['version', 'protocol', 'tests', '_v<n>', 'nope'].every((part) => error.message.includes(part)),
  );
});

test('protocol and robot mismatches are reported', () => {
  const s = suite({ harness: { protocol: BENCHMARK_PROTOCOL + 1, tested_commit: 'abc' }, requires: { robot: { name: 'g1' } } });
  const problems = compatibilityProblems(s);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /abc/);
});

test('{ all: true } selects every test, including new categories', () => {
  const rows = [row('loco/a'), row('brand_new/b')];
  const s = suite({ tests: [{ all: true }] });
  assert.deepEqual(selectTests(s, rows).map(({ row: r }) => r.id), ['loco/a', 'brand_new/b']);
  assert.throws(() => suite({ tests: [{ all: true, config: 'loco' }] }), /exactly one of id, config or all/);
});

test('selection merges overrides and refuses identical repeats', () => {
  const rows = [row('loco/a'), row('loco/b'), row('push/c', { events: [push(1, 100, 'reasonable')] })];
  const s = suite({
    defaults: { repeats: 3, randomize: { action_delay: 'env_range' } },
    tests: [{ config: 'loco' }, { id: 'loco/b', repeats: 1 }, { config: 'push' }],
  });
  const selected = selectTests(s, rows);
  assert.deepEqual(selected.map((s) => [s.row.id, s.settings.repeats]), [['loco/a', 3], ['loco/b', 1], ['push/c', 3]]);
  const cells = expandCells(selected);
  assert.equal(cells.length, 7);
  assert.equal(new Set(cells.map((c) => c.seed)).size, 7);
  assert.equal(expandCells(selected, { only: ['loco/b'], repeats: 2 }).length, 2);
  assert.throws(() => expandCells(selected, { only: ['loco/zzz'] }), /Unknown test/);

  const noRandom = suite({ defaults: { repeats: 2 } });
  assert.throws(() => selectTests(noRandom, rows), /identical/);
  assert.throws(() => selectTests(suite({ tests: [{ config: 'missing' }] }), rows), /matches no test/);
});

test('summary combines repeats and computes tasks', () => {
  const rows = [row('loco/a'), row('push/c', { events: [push(1, 100, 'reasonable'), push(3, 300, 'beyond')] })];
  const s = suite({
    defaults: { repeats: 2, randomize: { action_delay: 'env_range' } },
    tasks: [
      { id: 'upright_rate', metric: 'upright_rate' },
      { id: 'push_reasonable', metric: 'push_pass_rate', scope: { tier: 'reasonable' } },
      { id: 'push_beyond', metric: 'push_pass_rate', scope: { tier: 'beyond' } },
      { id: 'max_force', metric: 'max_force_survived_n', scope: { config: 'push' } },
      { id: 'tracking', metric: 'tracking_rmse', scope: { config: 'loco' } },
      { id: 'friction', metric: 'upright_rate', scope: { config: 'friction' } },
    ],
  });
  const selected = selectTests(s, rows);
  const metrics = (fell, recovered, rmse) => ({
    fell: { fell, time: fell ? 3.2 : null },
    commandTracking: { overall: { vx: rmse, vy: rmse, wz: rmse } },
    drift: { final_m: 1 },
    perturbations: { events: recovered.map((r) => ({ recovered: r })) },
  });
  const cells = [
    { testId: 'loco/a', repeat: 0, metrics: metrics(false, [], 0.1) },
    { testId: 'loco/a', repeat: 1, metrics: metrics(false, [], 0.3) },
    { testId: 'push/c', repeat: 0, metrics: metrics(true, [true, false], 0.2) },
    { testId: 'push/c', repeat: 1, error: 'boom', metrics: null },
  ];
  const perTest = summarizeTests(cells, selected);
  assert.equal(perTest[0].upright.value, 1);
  assert.equal(perTest[0].trackingRmse, 0.2);
  assert.equal(perTest[1].errors, 1);
  assert.equal(perTest[1].events[0].recovered, 1);
  assert.equal(perTest[1].events[0].value, 0); // all_repeats: the errored repeat fails it

  const tasks = Object.fromEntries(computeTasks(s, perTest).map((t) => [t.taskId, t.value]));
  assert.deepEqual(tasks, {
    upright_rate_v2: 0.5,
    push_reasonable_v2: 0,
    push_beyond_v2: 0,
    max_force_v2: 0,
    tracking_v2: 0.2,
    friction_v2: null,
  });

  const fraction = suite({ ...s, defaults: { ...s.defaults, pass_rule: 'fraction' }, tasks: s.tasks });
  const tasksFraction = computeTasks(fraction, summarizeTests(cells, selectTests(fraction, rows)));
  assert.equal(tasksFraction.find((t) => t.taskId === 'push_reasonable_v2').value, 0.5);
  assert.equal(tasksFraction.find((t) => t.taskId === 'max_force_v2').value, 100);
});

test('eval.yaml tasks carry the version and their dataset config', () => {
  const s = suite({ tasks: [{ id: 'upright_rate', metric: 'upright_rate' }, { id: 'push', metric: 'push_pass_rate', scope: { config: 'push' } }] });
  assert.deepEqual(buildEvalYaml(s, { name: 'N', description: 'D' }).tasks, [
    { id: 'upright_rate_v2' },
    { id: 'push_v2', config: 'push', split: 'test' },
  ]);
});

test('suite init writes a valid starter benchmark', async () => {
  const { initSuite } = await import('../../scripts/suite.mjs');
  const { loadSuiteDir } = await import('../../scripts/suiteDir.mjs');
  const dir = join(mkdtempSync(join(tmpdir(), 'hpv-init-')), 'my-bench');
  initSuite(dir, { log: () => {} });
  const loaded = loadSuiteDir(dir);
  assert.equal(loaded.suite.suite, 'my-bench');
  assert.deepEqual(compatibilityProblems(loaded.suite), []);
  assert.equal(expandCells(selectTests(loaded.suite, loaded.rows)).length, 1);
  assert.throws(() => initSuite(dir, { log: () => {} }), /not empty/);
});

test('the smoke-suite fixture is valid', async () => {
  const { loadSuiteDir } = await import('../../scripts/suiteDir.mjs');
  const loaded = loadSuiteDir(FIXTURE);
  assert.ok(loaded.rows.length >= 2);
  assert.deepEqual(compatibilityProblems(loaded.suite), []);
  assert.ok(expandCells(selectTests(loaded.suite, loaded.rows)).length >= 2);
});
