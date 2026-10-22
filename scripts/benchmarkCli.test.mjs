import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePort, parseWords, rejectSwallowedNpmFlags, swallowedNpmFlags } from './cliArgs.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { MAX_ROBOTS, buildJobs, groupCells, takeNextJob } from '../src/benchmark/run.js';
import { parseShard, parseTests, resultTarget, shardJobs, viewHint } from './benchmarkRun.mjs';
import { datasetFilesToFetch } from './hfDataset.mjs';

test('words, key=value options and flags', () => {
  const parsed = parseWords(['org/a', 'benchmark=../s', 'policy=b/c', 'policy=d/e', 'pr', 'jobs=3', 'dry-run'], {
    keys: ['benchmark', 'policy', 'jobs'], flags: ['pr', 'dry-run'], repeatable: ['policy'],
  });
  assert.deepEqual(parsed.positionals, ['org/a']);
  assert.deepEqual(parsed.options, { benchmark: '../s', policy: ['b/c', 'd/e'], jobs: '3' });
  assert.deepEqual([...parsed.flags].sort(), ['dry-run', 'pr']);
  assert.throws(() => parseWords(['jbos=2'], { keys: ['jobs'] }), /Unknown option "jbos="/);
  assert.throws(() => parseWords(['jobs=1', 'jobs=2'], { keys: ['jobs'] }), /twice/);
  // A path containing "=" is a positional, not an option.
  assert.deepEqual(parseWords(['./a=b/model'], { keys: [] }).positionals, ['./a=b/model']);
  assert.deepEqual(swallowedNpmFlags({ npm_config_pr: 'true' }, ['pr', 'watch']), ['pr']);
  // What npm really sets: `--no-open` -> npm_config_open='', `--verbose` -> npm_config_loglevel=verbose (the default is notice).
  assert.deepEqual(swallowedNpmFlags({ npm_config_open: '', npm_config_loglevel: 'verbose' }, ['no-open', 'verbose', 'watch']), ['no-open', 'verbose']);
  assert.deepEqual(swallowedNpmFlags({ npm_config_loglevel: 'notice' }, ['no-open', 'verbose']), []);
});

test('a "--" word is refused with the words form to write instead', () => {
  const spec = { keys: ['jobs'], flags: ['pr'], hints: { revision: 'write the revision as org/name@rev' } };
  assert.throws(() => parseWords(['--jobs=3'], spec), /"--jobs=3": no dashes; write jobs=3/);
  assert.throws(() => parseWords(['--jobs', '3'], spec), /write jobs=<value>/);
  assert.throws(() => parseWords(['--pr'], spec), /no dashes; write pr\./);
  assert.throws(() => parseWords(['--revision', 'x'], spec), /write the revision as org\/name@rev/);
  assert.throws(() => parseWords(['--nope'], spec), /key=value .*options: jobs=.*flags: pr/);
  assert.throws(() => rejectSwallowedNpmFlags({ npm_config_revision: 'x' }, spec), /npm kept --revision .*org\/name@rev/);
  assert.throws(() => rejectSwallowedNpmFlags({ npm_config_jobs: '2' }, spec), /write jobs=<value>/);
  rejectSwallowedNpmFlags({}, spec);
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort('4000'), 4000);
  assert.throws(() => parsePort('0'), /1-65535/);
});

test('targets: policies, benchmarks, revisions and local paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-targets-'));
  mkdirSync(join(dir, 'benchmark'));
  writeFileSync(join(dir, 'benchmark', 'benchmark.yaml'), 'name: x\n');
  mkdirSync(join(dir, 'model'));
  assert.deepEqual(classifyTarget('org/name'), { kind: 'policy', source: 'hub', id: 'org/name', revision: null });
  assert.deepEqual(classifyTarget('org/name@v2'), { kind: 'policy', source: 'hub', id: 'org/name', revision: 'v2' });
  assert.deepEqual(classifyTarget('https://huggingface.co/org/name/tree/abc123'), { kind: 'policy', source: 'hub', id: 'org/name', revision: 'abc123' });
  assert.deepEqual(classifyTarget('datasets/org/bench@v1'), { kind: 'benchmark', source: 'hub', id: 'org/bench', revision: 'v1' });
  assert.deepEqual(classifyTarget('https://huggingface.co/datasets/org/bench'), { kind: 'benchmark', source: 'hub', id: 'org/bench', revision: null });
  assert.equal(classifyTarget('benchmark', { cwd: dir }).kind, 'benchmark');
  assert.equal(classifyTarget('model', { cwd: dir }).kind, 'policy');
  assert.throws(() => classifyTarget('./missing', { cwd: dir }), /does not exist/);
  assert.throws(() => classifyTarget('https://huggingface.co/spaces/a/b'), /Space/);
});

const cell = (id, duration, repeat = 0) => ({ cellId: `${id}#${repeat}`, testId: id, repeat, duration, seed: repeat, timeoutS: 60 });

test('jobs run the most work first, shards partition them, pages keep their policy', () => {
  const jobs = buildJobs([{ key: 'm0' }, { key: 'm1' }], [cell('a/x', 5), cell('a/long', 100), cell('a/y', 10)]);
  assert.deepEqual(jobs.slice(0, 2).map((j) => j.cells[0].testId), ['a/long', 'a/long']);
  const shards = [1, 2, 3].map((index) => shardJobs(jobs, { index, count: 3 }));
  assert.equal(shards.flat().length, jobs.length);
  assert.equal(new Set(shards.flat()).size, jobs.length);
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
  assert.throws(() => parseShard('4/3'), /shard=/);
  assert.equal(parseTests(undefined), null);
  assert.deepEqual(parseTests(' a/x, a/y ,'), ['a/x', 'a/y']);
  // Commas alone name no tests; that is a mistake, not "run nothing".
  assert.throws(() => parseTests(','), /tests= names no test ids/);

  const queue = jobs.slice();
  assert.equal(takeNextJob(queue, null).policyKey, 'm0');
  assert.equal(takeNextJob(queue, 'm1').policyKey, 'm1');
});

test('a test\'s repeats run in groups of at most MAX_ROBOTS robots', () => {
  assert.equal(MAX_ROBOTS, 5);
  const repeats = (id, duration, n) => Array.from({ length: n }, (_, r) => cell(id, duration, r));
  const cells = [...repeats('a/x', 10, 12), ...repeats('a/long', 30, 2), cell('a/one', 100)];
  const groups = groupCells(cells);
  assert.deepEqual(groups.map((g) => [g[0].testId, g.length]), [['a/x', 5], ['a/x', 5], ['a/x', 2], ['a/long', 2], ['a/one', 1]]);
  // Every cell keeps its own repeat and seed, in repeat order.
  assert.deepEqual(groups.slice(0, 3).flat().map((c) => c.seed), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(groups.every((g) => new Set(g.map((c) => c.testId)).size === 1));
  assert.deepEqual(groupCells(cells, 1).map((g) => g.length), cells.map(() => 1));

  const policies = [{ key: 'm0' }, { key: 'm1' }];
  const jobs = buildJobs(policies, cells);
  assert.equal(jobs.length, 2 * groups.length);
  // Ordered by test length x robots: a/one (100), then a/long x2 (60), then a/x x5 (50).
  assert.deepEqual(jobs.slice(0, 4).map((j) => [j.cells[0].testId, j.cells.length]), [['a/one', 1], ['a/one', 1], ['a/long', 2], ['a/long', 2]]);
  for (const count of [1, 2, 3, 4]) {
    const shards = Array.from({ length: count }, (_, i) => shardJobs(jobs, { index: i + 1, count }));
    const seen = shards.flat().flatMap((job) => job.cells.map((c) => `${job.policyKey}|${c.cellId}`));
    assert.equal(seen.length, policies.length * cells.length, `shards of ${count}`);
    assert.equal(new Set(seen).size, seen.length, `shards of ${count}: every cell exactly once`);
  }
});

test('the end of a run says how to view it, in the viewer and as the report file', () => {
  assert.deepEqual(viewHint('benchmark_results/20261012T112354', '/app/benchmark_results/20261012T112354/report.html'), [
    'View it in the viewer with: npm run benchmark view benchmark_results/20261012T112354',
    'Or open the report directly: /app/benchmark_results/20261012T112354/report.html',
  ]);
});

test('view takes a result folder or its result.json, served from the folder\'s parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'hpv-view-'));
  const dir = join(root, '20261012T112354_merged');
  mkdirSync(dir);
  writeFileSync(join(dir, 'result.json'), '{}');
  for (const word of [dir, join(dir, 'result.json')]) {
    assert.deepEqual(resultTarget(word), { dir, name: '20261012T112354_merged', resultsDir: root, file: '20261012T112354_merged/result.json' });
  }
  assert.throws(() => resultTarget(root), /has no result\.json/);
  const dotted = join(root, 'my.run');
  mkdirSync(dotted);
  writeFileSync(join(dotted, 'result.json'), '{}');
  assert.throws(() => resultTarget(dotted), /letters, digits, - and _/);
});

test('only benchmark files are fetched from a dataset', () => {
  assert.deepEqual(
    datasetFilesToFetch(['benchmark.yaml', 'eval.yaml', 'README.md', 'CHANGELOG.md', 'suites/smoke.yaml', 'data/push/test.jsonl', 'data/push/big.parquet', 'calibration/v1.json', 'tools/gen.py', 'tools/x/deep.py']),
    ['benchmark.yaml', 'eval.yaml', 'README.md', 'CHANGELOG.md', 'data/push/test.jsonl', 'calibration/v1.json', 'tools/gen.py'],
  );
});
