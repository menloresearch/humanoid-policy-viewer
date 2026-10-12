import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_SCHEMA } from '../benchmark/run.js';
import { buildBenchmarkReportHtml } from './benchmarkReport.js';

const row = {
  id: 'a/walk', config: 'a', schema_version: 1, kind: 'velocity-sequence', name: 'walk', description: '', tags: [], duration: 4,
  commands: [{ t: 0, vx: 0.5, vy: 0, wz: 0 }], events: [], limits: null, foot_friction: null, terrain: null, metrics_opt_in: [],
};

function fakeResult(overrides = {}) {
  const metrics = (fell) => ({ fell, topDown: { actual: [[0, 0], [2, 0]] }, series: { time: [0, 1], actual: { vx: [0, 0.5] }, error: {}, drift: [0, 0.1] } });
  return {
    schema: RESULT_SCHEMA,
    generatedAt: '2026-10-12T00:00:00.000Z',
    benchmark: { source: 'local', path: '/bench', raw: { name: 'smoke', title: 'Smoke <test>', version: 2, harness: { protocol: 1 }, requires: {}, tests: [{ config: 'a' }], tasks: [{ id: 'survival_rate', metric: 'survival_rate@1' }] } },
    shard: null,
    policies: [{ key: 'm0', id: 'org/model', label: 'org/model' }],
    tests: [row],
    expectedCells: 2,
    cells: [
      { policyKey: 'm0', cellId: 'a/walk#0', testId: 'a/walk', repeat: 0, seed: 7, error: null, warning: null, metrics: metrics({ fell: false, time: null }) },
      { policyKey: 'm0', cellId: 'a/walk#1', testId: 'a/walk', repeat: 1, seed: 8, error: null, warning: null, metrics: metrics({ fell: true, time: 2.5 }) },
    ],
    ...overrides,
  };
}

test('the report shows tasks, each repeat\'s outcome and a tab per repeat', () => {
  const html = buildBenchmarkReportHtml(fakeResult());
  assert.match(html, /<h1>Smoke &lt;test&gt; <span class="muted">v2<\/span><\/h1>/);
  assert.match(html, /survival_rate_v2/);
  assert.match(html, /<td>0\.50 \[/);
  assert.match(html, /class="pill passed" title="seed 7">passed</);
  assert.match(html, /class="pill fell" title="seed 8">fell at 2\.5 s</);
  assert.match(html, /data-group="t0" data-show="r1" title="seed 8">#1</);
  const embedded = html.match(/<script type="application\/json" id="benchmark-result">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(embedded).cells.length, 2);
});

test('a partial result is flagged and has no tasks', () => {
  const html = buildBenchmarkReportHtml(fakeResult({ expectedCells: 4, shard: { index: 1, count: 2 } }));
  assert.match(html, /Partial result<\/b>: 2 of 4 cells \(shard 1\/2\)/);
  assert.doesNotMatch(html, /<h2>Tasks<\/h2>/);
});

test('anything but a result.json is refused', () => {
  assert.throws(() => buildBenchmarkReportHtml({ results: [] }), /Not a benchmark result/);
});
