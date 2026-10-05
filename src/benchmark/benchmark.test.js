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
    foot_friction: null, terrain: null, metrics_opt_in: [], ...extra,
  };
}

const push = (t, force, tier) => ({
  t, type: 'push', dir: [1, 0], force, duration: 0.15, targetBody: null, torqueAxis: null, torqueMag: null, label: null, tier,
});

function suite(extra = {}) {
  return parseSuite({
    suite: 's', version: 2, harness: { protocol: BENCHMARK_PROTOCOL }, requires: { robot: { name: 'asimov-1' } },
    tests: [{ config: 'loco' }, { config: 'push' }],
    tasks: [{ id: 'survival_rate', metric: 'survival_rate@1' }],
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

test('a terrain test keeps its course through the editor and is checked before a run', async () => {
  const { checkTests } = await import('../../scripts/suiteCheck.mjs');
  const { defaultTerrain } = await import('../simulation/terrainGen.js');
  const stairs = defaultTerrain('stairs');
  const onStairs = row('loco/stairs', { terrain: stairs });
  assert.deepEqual(validateTestRow(onStairs), []);
  assert.deepEqual(rowToSequence(onStairs).terrain, stairs);
  assert.equal('terrain' in rowToSequence(row('loco/a')), false);
  assert.deepEqual(sequenceToRow(onStairs.id, rowToSequence(onStairs), onStairs), onStairs);
  assert.ok(validateTestRow(row('loco/a', { terrain: 'terrain/stairs_5cm.xml' })).some((e) => e.includes('terrain')));
  assert.ok(validateTestRow(row('loco/a', { terrain: { ...stairs, steps: 0 } })).some((e) => e.includes('terrain: steps')));

  const s = suite({ tests: [{ config: 'loco' }] });
  const onSpawn = row('loco/spawn', { terrain: { ...stairs, start_m: 0 } });
  const { errors, warnings } = checkTests({ suite: s, rows: [onStairs, onSpawn] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^loco\/spawn: the course reaches x = 0\.00 m, inside the spawn area/);
  // row() walks 0.5 m/s for 4 s: it reaches the stairs but not their end; that is not a warning
  assert.deepEqual(warnings.filter((w) => w.startsWith('loco/stairs')), []);
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

const ran = (fellAt = null) => ({ fell: { fell: fellAt !== null, time: fellAt } });

test('survival metrics: repeats are averaged, categories weigh equally, errors count as falls', () => {
  // loco: 2 tests; push: 1 test with a tier and a tag. duration is 4 s.
  const rows = [row('loco/a'), row('loco/b'), row('push/c', { tags: ['walking'], events: [push(1, 100, 'reasonable')] })];
  const s = suite({
    defaults: { repeats: 4, randomize: { action_delay: 'env_range' } },
    tasks: [
      { id: 'survival_rate', metric: 'survival_rate@1' },
      { id: 'survival_time', metric: 'survival_time@1' },
      { id: 'loco_survival', metric: 'survival_rate@1', scope: { config: 'loco' } },
      { id: 'reasonable', metric: 'survival_rate@1', scope: { tier: 'reasonable' } },
      { id: 'walking', metric: 'survival_rate@1', scope: { tag: 'walking' } },
      { id: 'friction', metric: 'survival_rate@1', scope: { config: 'friction' } },
    ],
  });
  const cells = [
    ...[0, 1, 2, 3].map((repeat) => ({ testId: 'loco/a', repeat, metrics: ran() })),
    ...[0, 1, 2, 3].map((repeat) => ({ testId: 'loco/b', repeat, metrics: ran(repeat < 2 ? 2 : null) })),
    { testId: 'push/c', repeat: 0, metrics: ran(1) },
    { testId: 'push/c', repeat: 1, metrics: ran() },
    { testId: 'push/c', repeat: 2, metrics: ran() },
    { testId: 'push/c', repeat: 3, error: 'boom', metrics: null },
  ];
  const perTest = summarizeTests(cells, selectTests(s, rows));
  const rate = (id) => perTest.find((t) => t.testId === id).metrics['survival_rate@1'];
  assert.deepEqual([rate('loco/a').value, rate('loco/b').value, rate('push/c').value], [1, 0.5, 0.5]);
  assert.deepEqual(perTest.find((t) => t.testId === 'push/c').metrics['survival_time@1'].values, [0.25, 1, 1, 0]);
  assert.deepEqual(perTest.find((t) => t.testId === 'push/c').fellAt, [1, null, null, 0]);
  assert.equal(perTest.find((t) => t.testId === 'push/c').errors, 1);

  const tasks = Object.fromEntries(computeTasks(s, perTest).map((t) => [t.taskId, t]));
  // (mean(loco) + mean(push)) / 2 = ((1 + 0.5) / 2 + 0.5) / 2, not the plain mean over 3 tests
  assert.equal(tasks.survival_rate_v2.value, 0.625);
  // loco = (1 + 0.75) / 2 = 0.875 (loco/b fell at 2 s of 4 in two repeats), push/c = (0.25 + 1 + 1 + 0) / 4
  assert.equal(tasks.survival_time_v2.value, 0.7188);
  assert.equal(tasks.loco_survival_v2.value, 0.75);
  assert.equal(tasks.reasonable_v2.value, 0.5);
  assert.equal(tasks.walking_v2.value, 0.5);
  assert.equal(tasks.friction_v2.value, null);
  assert.equal(tasks.friction_v2.ci95, null);
  assert.deepEqual([tasks.survival_rate_v2.tests, tasks.survival_rate_v2.cells], [3, 12]);
  const [lo, hi] = tasks.survival_rate_v2.ci95;
  assert.ok(lo < 0.625 && hi > 0.625 && lo >= 0 && hi <= 1);
});

test('a test survived on every repeat still has an uncertainty', () => {
  const s = suite({ defaults: { repeats: 5, randomize: { action_delay: 'env_range' } }, tests: [{ config: 'loco' }] });
  const cells = [0, 1, 2, 3, 4].map((repeat) => ({ testId: 'loco/a', repeat, metrics: ran() }));
  const [task] = computeTasks(s, summarizeTests(cells, selectTests(s, [row('loco/a')])));
  assert.equal(task.value, 1);
  assert.ok(task.stderr > 0.1, `stderr ${task.stderr}`);
  assert.equal(task.ci95[1], 1);
});

test('metrics must name a version; aggregate and pass_rule are no longer settings', () => {
  assert.throws(() => suite({ tasks: [{ id: 'x', metric: 'survival_rate' }] }), /must name a version, e\.g\. "survival_rate@1"/);
  assert.throws(() => suite({ tasks: [{ id: 'x', metric: 'upright_rate@1' }] }), /unknown; known: survival_rate@1/);
  assert.throws(() => suite({ defaults: { pass_rule: 'fraction' } }), /defaults\.pass_rule is not a setting.*part of each metric/);
  assert.throws(() => suite({ tests: [{ config: 'loco', aggregate: 'mean' }] }), /tests\[0\]\.aggregate is not a setting/);
  assert.throws(() => suite({ tasks: [{ id: 'x', metric: 'survival_rate@1', scope: { body: 'pelvis' } }] }), /scope\.body is unknown/);
});

test('eval.yaml tasks carry the version and their dataset config', () => {
  const s = suite({ tasks: [{ id: 'survival_rate', metric: 'survival_rate@1' }, { id: 'push', metric: 'survival_rate@1', scope: { config: 'push' } }] });
  assert.deepEqual(buildEvalYaml(s, { name: 'N', description: 'D' }).tasks, [
    { id: 'survival_rate_v2', config: 'all', split: 'test' },
    { id: 'push_v2', config: 'push', split: 'test' },
  ]);
  assert.ok(validateTestRow(row('all/x')).some((e) => e.includes('reserved')));
});

test('suite init writes a valid starter benchmark', async () => {
  const { initSuite } = await import('../../scripts/suite.mjs');
  const { loadSuiteDir } = await import('../../scripts/suiteDir.mjs');
  const dir = join(mkdtempSync(join(tmpdir(), 'hpv-init-')), 'my-bench');
  initSuite(dir, { log: () => {} });
  const loaded = loadSuiteDir(dir);
  assert.equal(loaded.suite.suite, 'my-bench');
  assert.deepEqual(compatibilityProblems(loaded.suite), []);
  assert.equal(expandCells(selectTests(loaded.suite, loaded.rows)).length, 5);
  assert.throws(() => initSuite(dir, { log: () => {} }), /not empty/);
});

test('checkTests: player errors stop a run, unselected tests are flagged', async () => {
  const { checkTests } = await import('../../scripts/suiteCheck.mjs');
  const s = suite({ tests: [{ config: 'loco' }] });
  const late = push(1, 100, 'reasonable');
  late.dir = [0, 0];
  const result = checkTests({ suite: s, rows: [row('loco/a'), row('loco/b', { events: [late] }), row('other/c')] });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /loco\/b: .*dir/);
  assert.match(result.warnings.join('\n'), /never run: other\/c/);
});

test('the smoke-suite fixture is valid', async () => {
  const { loadSuiteDir } = await import('../../scripts/suiteDir.mjs');
  const loaded = loadSuiteDir(FIXTURE);
  assert.ok(loaded.rows.length >= 2);
  assert.deepEqual(compatibilityProblems(loaded.suite), []);
  assert.ok(expandCells(selectTests(loaded.suite, loaded.rows)).length >= 2);
});
