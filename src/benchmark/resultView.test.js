import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_SCHEMA } from './run.js';
import { formatTask, resultView } from './resultView.js';

const row = {
  id: 'a/walk', config: 'a', schema_version: 1, kind: 'velocity-sequence', name: 'walk', description: '', tags: [], duration: 4,
  commands: [{ t: 0, vx: 0.5, vy: 0, wz: 0 }], events: [], limits: null, foot_friction: null, terrain: null, metrics_opt_in: [],
  goal: { x: 2, y: 0, radius_m: 0.5 },
};

const metrics = (overrides = {}) => ({
  fell: { fell: false, time: null },
  topDown: { actual: [[0, 0], [2, 0]] },
  goal: { reached: true, miss_m: 0 },
  commandTracking: { overall: { vx: 0.1, vy: 0.2, wz: 0.3 } },
  drift: { final_m: 0.4 },
  perturbations: { survived: 1, total: 2, meanScore: 0.5 },
  ...overrides,
});

function fakeResult(cells, overrides = {}) {
  return {
    schema: RESULT_SCHEMA,
    generatedAt: '2026-10-12T00:00:00.000Z',
    benchmark: {
      id: 'org/bench',
      raw: {
        name: 'smoke', title: 'Smoke', version: 3, harness: { protocol: 1 }, requires: {}, tests: [{ config: 'a' }],
        tasks: [
          { id: 'survival_rate', metric: 'survival_rate@1', description: 'Finished upright' },
          { id: 'survival_time', metric: 'survival_time@1' },
        ],
      },
    },
    shard: null,
    policies: [{ key: 'm0', id: 'org/model', label: 'org/model' }],
    tests: [row],
    expectedCells: cells.length,
    cells: cells.map((cell, repeat) => ({ policyKey: 'm0', cellId: `a/walk#${repeat}`, testId: 'a/walk', repeat, seed: 100 + repeat, error: null, warning: null, ...cell })),
    ...overrides,
  };
}

const fourWays = [
  { metrics: metrics() },
  { metrics: metrics({ fell: { fell: true, time: 1.234 } }), warning: 'short capture' },
  { metrics: metrics({ topDown: { actual: [[0, 0], [1, 0]] }, goal: { reached: false, miss_m: 0.5 } }) },
  { error: 'policy crashed', metrics: null },
];

test('each repeat is passed, fell, missed the end zone or errored, with its seed', () => {
  const view = resultView(fakeResult(fourWays));
  assert.deepEqual(view.tests[0].repeats, [0, 1, 2, 3].map((repeat) => ({ repeat, seed: 100 + repeat })));
  const [policy] = view.policies;
  const outcomes = policy.tests[0].outcomes;
  assert.deepEqual(outcomes.map((o) => o.kind), ['passed', 'fell', 'missed', 'error']);
  assert.deepEqual(outcomes.map((o) => o.text), ['passed', 'fell at 1.2 s', 'missed end zone by 0.50 m', 'error']);
  assert.equal(outcomes[1].detail, 'short capture');
  assert.equal(outcomes[3].detail, 'policy crashed');
  assert.deepEqual(policy.counts, { passed: 1, fell: 1, missed: 1, error: 1, total: 4 });
  assert.ok(view.tests[0].sequence.commands.length);
});

test('the miss distance falls back to the path when the cell has no goal metric', () => {
  const view = resultView(fakeResult([{ metrics: metrics({ topDown: { actual: [[0, 0], [1, 0]] }, goal: undefined }) }]));
  assert.equal(view.policies[0].tests[0].outcomes[0].text, 'missed end zone by 0.50 m');
});

test('means leave errored repeats out; pushes add up', () => {
  const { tests, means, pushes } = resultView(fakeResult(fourWays)).policies[0];
  assert.ok(Math.abs(tests[0].means.trackRmse - 0.2) < 1e-9);
  assert.ok(Math.abs(tests[0].means.finalDrift - 0.4) < 1e-9);
  assert.equal(tests[0].means.symmetry, null);
  assert.deepEqual(tests[0].pushes, { survived: 3, total: 6 });
  assert.equal(means.finalDrift, tests[0].means.finalDrift);
  assert.deepEqual(pushes, { survived: 3, total: 6 });
});

test('tasks agree with the outcomes and carry their interval and description', () => {
  const [policy] = resultView(fakeResult(fourWays)).policies;
  const [rate, time] = policy.tasks;
  assert.equal(rate.taskId, 'survival_rate_v3');
  assert.equal(rate.id, 'survival_rate');
  assert.equal(rate.description, 'Finished upright');
  assert.equal(rate.value, policy.counts.passed / policy.counts.total);
  assert.ok(rate.ci95[0] < rate.value && rate.value < rate.ci95[1]);
  assert.match(time.description, /Fraction of each test/);
  assert.equal(formatTask(rate), `0.25 [${rate.ci95[0].toFixed(2)}, ${rate.ci95[1].toFixed(2)}]`);
  assert.equal(formatTask({ value: null }), 'n/a');
});

test('a partial result shows the cells it has and no tasks', () => {
  const shard = fakeResult(fourWays.slice(0, 2), { expectedCells: 8, shard: { index: 1, count: 2 } });
  shard.policies.push({ key: 'm1', id: 'org/other', label: 'org/other' });
  const view = resultView(shard);
  assert.equal(view.complete, false);
  assert.deepEqual(view.policies.map((p) => p.tasks), [null, null]);
  assert.deepEqual(view.policies[1].tests[0].outcomes, [null, null]);
  assert.equal(view.policies[1].counts.total, 0);
});
