// The benchmark folder format helpers other tools use to publish a benchmark
// exactly as HPV reads it (scripts/benchmarkDir.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { BENCHMARK_FILES, hubRowsText, scoredContentHash, withTestedCommit } from './benchmarkDir.mjs';

test('the scored-content hash ignores prose, version and tested_commit', () => {
  const benchmark = { name: 's', title: 'T', version: 1, harness: { protocol: 1, tested_commit: 'abc' }, tests: [{ all: true }] };
  const rows = [{ id: 'loco/a', duration: 10 }];
  const hash = scoredContentHash(benchmark, rows);
  assert.equal(scoredContentHash({ ...benchmark, title: 'U', version: 2, harness: { protocol: 1, tested_commit: 'def' } }, rows), hash);
  assert.notEqual(scoredContentHash({ ...benchmark, harness: { protocol: 2 } }, rows), hash);
  assert.notEqual(scoredContentHash(benchmark, [{ id: 'loco/a', duration: 11 }]), hash);
});

test('withTestedCommit replaces the value in place, and adds the key when there is none', () => {
  const text = 'name: x   # the name\nharness:\n  protocol: 1      # p\n  tested_commit: abc   # set by publish\nversion: 1\n';
  assert.equal(withTestedCommit(text, 'f'.repeat(40)), text.replace('abc', 'f'.repeat(40)));
  assert.equal(parseYaml(withTestedCommit('harness: { protocol: 1, tested_commit: "abc" }\n', 'f'.repeat(40))).harness.tested_commit, 'f'.repeat(40));
  for (const missing of ['harness:\n  protocol: 1\n', 'harness:\n  protocol: 1\n  tested_commit:\n']) {
    assert.deepEqual(parseYaml(withTestedCommit(missing, 'f'.repeat(40))).harness, { protocol: 1, tested_commit: 'f'.repeat(40) });
  }
});

test('hubRowsText writes a row\'s start as JSON text and leaves other rows as written', () => {
  const start = { pos: [0, 0, 0.16], joint_pos: { '.*_knee_joint': 0.6 } };
  const plain = '{"id":"loco/a",  "start":null}';
  const text = `${plain}\n${JSON.stringify({ id: 'getup/a', start })}\n`;
  const [first, second, last] = hubRowsText(text).split('\n');
  assert.equal(first, plain);
  assert.deepEqual(JSON.parse(second), { id: 'getup/a', start: JSON.stringify(start) });
  assert.equal(last, '');
});

test('BENCHMARK_FILES are the files a benchmark is published with', () => {
  const published = (path) => BENCHMARK_FILES.some((re) => re.test(path));
  for (const path of ['benchmark.yaml', 'README.md', 'CHANGELOG.md', 'data/push/test.jsonl', 'calibration/v1.json', 'tools/gen.py', 'LICENSE', 'LICENSE.txt']) assert.ok(published(path), path);
  for (const path of ['eval.yaml', 'suites/smoke.yaml', 'data/push/big.parquet', 'tools/x/deep.py', '.hf-dataset.json', 'notes.md']) assert.ok(!published(path), path);
});
