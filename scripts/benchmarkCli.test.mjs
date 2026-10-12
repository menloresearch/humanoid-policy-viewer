import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parsePort, parseWords, rejectSwallowedNpmFlags, swallowedNpmFlags } from './cliArgs.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { MAX_ROBOTS, buildJobs, groupCells, takeNextJob, RESULT_SCHEMA } from '../src/benchmark/run.js';
import { parseShard, resultTarget, shardJobs, submitHint, uploadBlockers, viewHint } from './benchmarkRun.mjs';
import { buildEvalResultEntries, evalResultsPath, mergeEvalResults } from './hfEvalResults.mjs';
import { commitFiles, decideCommitMode } from './hfCommit.mjs';
import { datasetFilesToFetch } from './hfDataset.mjs';
import { mergeEvalTasks } from './benchmarkDir.mjs';
import { scoredContentHash } from './hfBenchmark.mjs';

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
  assert.deepEqual(swallowedNpmFlags({ npm_config_pr: 'true', npm_config_no_upload: '' }, ['pr', 'no-upload', 'watch']), ['pr', 'no-upload']);
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

function fakeRun(overrides = {}) {
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

test('only reproducible, complete, error-free runs may be uploaded', () => {
  assert.deepEqual(uploadBlockers(fakeRun(), 'm0'), []);
  const dirty = fakeRun();
  dirty.provenance.hpv.dirty = true;
  assert.match(uploadBlockers(dirty, 'm0').join(), /uncommitted/);
  assert.match(uploadBlockers(fakeRun({ benchmark: { ...fakeRun().benchmark, source: 'local' } }), 'm0').join(), /local folder/);
  assert.match(uploadBlockers(fakeRun({ overrides: { tests: ['a/x'], repeats: null, force: false } }), 'm0').join(), /tests=/);
  assert.match(uploadBlockers(fakeRun({ cells: [] }), 'm0').join(), /missing/);
  assert.match(uploadBlockers(fakeRun({ cells: [{ policyKey: 'm0', cellId: 'a/x#0', testId: 'a/x', error: 'boom' }] }), 'm0').join(), /boom/);
  assert.match(uploadBlockers(fakeRun({ benchmark: { ...fakeRun().benchmark, sha: null } }), 'm0').join(), /not pinned/);
  const protocol = fakeRun();
  protocol.provenance.hpv.protocol = 2;
  assert.match(uploadBlockers(protocol, 'm0').join(), /needs protocol 1.*implements 2/);
  const unknown = fakeRun();
  delete unknown.provenance.hpv.dirty;
  assert.match(uploadBlockers(unknown, 'm0').join(), /uncommitted/);
  assert.match(uploadBlockers(fakeRun({ shard: { index: 1, count: 2 } }), 'm0').join(), /merge the shards/);
});

test('the end of a run says how to submit it, or why it cannot be', () => {
  assert.deepEqual(submitHint(fakeRun(), 'out'), ['Submit to the Hub with: npm run hf submit out [pr] [dry-run]']);
  const local = fakeRun({ benchmark: { ...fakeRun().benchmark, source: 'local' } });
  local.policies.push({ ...local.policies[0], key: 'm1', id: 'local:p', label: 'p', source: 'local' });
  const lines = submitHint(local, 'out');
  assert.equal(lines[0], 'Cannot be submitted to the Hub:');
  assert.equal(lines.filter((line) => /benchmark is a local folder/.test(line)).length, 1);
  assert.ok(lines.includes('  - p: the policy is a local folder, not a Hugging Face model repo'));
  const mixed = fakeRun();
  mixed.policies.push({ ...mixed.policies[0], key: 'm1', id: 'local:p', label: 'p', source: 'local' });
  assert.match(submitHint(mixed, 'out').join('\n'), /^Submit to the Hub with.*\nNot submittable:\n {2}- p: the policy is a local folder/);
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

test('eval results: entries per task, re-runs replace only their own tasks', () => {
  const run = fakeRun({ tasks: { m0: [
    { taskId: 'survival_rate_v1', metric: 'survival_rate@1', value: 0.5, ci95: [0.3, 0.7], tests: 4, cells: 20 },
    { taskId: 'nothing_v1', metric: 'survival_rate@1', value: null, ci95: null, tests: 0, cells: 0 },
  ] } });
  const entries = buildEvalResultEntries(run, 'm0', { sourceUrl: 'https://example/report.html' });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].dataset, { id: 'org/bench', task_id: 'survival_rate_v1', revision: 'd'.repeat(40) });
  assert.match(entries[0].notes, /^metric=survival_rate@1 95%CI=\[0\.3, 0\.7\] tests=4 runs=20 hpv@cccccccccccc protocol=1 benchmark=smoke v1/);
  assert.equal(evalResultsPath('org/bench'), '.eval_results/org__bench.yaml');

  const existing = mergeEvalResults(null, [
    { dataset: { id: 'org/bench', task_id: 'survival_rate_v1' }, value: 0.1 },
    { dataset: { id: 'org/bench', task_id: 'survival_rate_v0' }, value: 0.9 },
    { dataset: { id: 'other/bench', task_id: 'survival_rate_v1' }, value: 0.3 },
  ]);
  const merged = parseYaml(mergeEvalResults(existing, entries));
  assert.deepEqual(merged.map((e) => [e.dataset.id, e.dataset.task_id, e.value]), [
    ['org/bench', 'survival_rate_v0', 0.9],
    ['other/bench', 'survival_rate_v1', 0.3],
    ['org/bench', 'survival_rate_v1', 0.5],
  ]);
  assert.throws(() => mergeEvalResults('a: 1\n', entries), /not a YAML list/);

  const text = mergeEvalResults(null, [...entries, { ...entries[0], dataset: { ...entries[0].dataset, task_id: 'b_v1' } }]);
  assert.match(text, /date: "2026-10-02T00:00:00.000Z"/);
  assert.doesNotMatch(text, /[&*]a\d/); // no YAML anchors/aliases
  assert.match(text, /notes: metric=\S+ 95%CI=\[[\d.]+, [\d.]+\] tests=\d+ runs=\d+ hpv@\S+ protocol=1 benchmark=smoke v1 asimov-1@\S+ policy@\S+\n/);
});

test('eval.yaml keeps task ids of earlier benchmark versions', () => {
  const merged = mergeEvalTasks({ tasks: [{ id: 'x_v1' }, { id: 'y_v2' }] }, { name: 'n', tasks: [{ id: 'y_v2', config: 'a' }] });
  assert.deepEqual(merged.tasks, [{ id: 'y_v2', config: 'a' }, { id: 'x_v1' }]);
});

test('owners commit directly, everyone else opens a pull request', () => {
  const user = (name, orgs = [], role = 'write') => ({ type: 'user', name, orgs: orgs.map((o) => ({ name: o })), auth: { accessToken: { role } } });
  assert.equal(decideCommitMode(user('jiaqi'), 'jiaqi/model').mode, 'direct');
  assert.equal(decideCommitMode(user('jiaqi', ['menloresearch']), 'menloresearch/model').mode, 'direct');
  assert.equal(decideCommitMode(user('someone'), 'menloresearch/model').mode, 'pr');
  assert.equal(decideCommitMode(user('jiaqi', [], 'read'), 'jiaqi/model').mode, 'pr');
  assert.equal(decideCommitMode(user('jiaqi'), 'jiaqi/model', { forcePr: true }).mode, 'pr');
});

test('a refused direct commit is retried as a pull request', async () => {
  const calls = [];
  const hub = {
    whoAmI: async () => ({ type: 'user', name: 'jiaqi', orgs: [], auth: { accessToken: { role: 'fineGrained' } } }),
    commit: async (params) => {
      calls.push(params.isPullRequest);
      if (!params.isPullRequest) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      return { pullRequestUrl: 'https://hf/pr/1', commit: { oid: 'abc', url: 'https://hf/c' } };
    },
  };
  const result = await commitFiles({
    repo: { type: 'model', name: 'jiaqi/model' },
    files: [{ path: 'a.yaml', content: 'x' }],
    title: 't',
    env: { HF_TOKEN: 'hf_x' },
    hub,
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(result.mode, 'pr');
  assert.equal(result.url, 'https://hf/pr/1');
  assert.match(result.fellBack, /403/);

  const failing = { ...hub, commit: async () => { throw Object.assign(new Error('server down'), { statusCode: 500 }); } };
  await assert.rejects(() => commitFiles({ repo: { type: 'model', name: 'jiaqi/model' }, files: [], title: 't', env: { HF_TOKEN: 'x' }, hub: failing }), /server down/);
  await assert.rejects(() => commitFiles({ repo: { type: 'model', name: 'jiaqi/model' }, files: [], title: 't', env: {}, hub }), /token/);
});

test('only benchmark files are fetched from a dataset', () => {
  assert.deepEqual(
    datasetFilesToFetch(['benchmark.yaml', 'eval.yaml', 'README.md', 'CHANGELOG.md', 'suites/smoke.yaml', 'data/push/test.jsonl', 'data/push/big.parquet', 'calibration/v1.json', 'tools/gen.py', 'tools/x/deep.py']),
    ['benchmark.yaml', 'eval.yaml', 'README.md', 'CHANGELOG.md', 'data/push/test.jsonl', 'calibration/v1.json', 'tools/gen.py'],
  );
});

test('the scored-content hash ignores prose, version and tested_commit', () => {
  const benchmark = { name: 's', title: 'T', version: 1, harness: { protocol: 1, tested_commit: 'abc' }, tests: [{ all: true }] };
  const rows = [{ id: 'loco/a', duration: 10 }];
  const hash = scoredContentHash(benchmark, rows);
  assert.equal(scoredContentHash({ ...benchmark, title: 'U', version: 2, harness: { protocol: 1, tested_commit: 'def' } }, rows), hash);
  assert.notEqual(scoredContentHash({ ...benchmark, harness: { protocol: 2 } }, rows), hash);
  assert.notEqual(scoredContentHash(benchmark, [{ id: 'loco/a', duration: 11 }]), hash);
});

