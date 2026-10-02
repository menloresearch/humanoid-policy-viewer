import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseWords, swallowedNpmFlags } from './cliArgs.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { buildJobs, mergeRuns, parseShard, shardJobs, takeNextJob, uploadBlockers, RUN_SCHEMA } from './benchmarkRun.mjs';
import { buildEvalResultEntries, evalResultsPath, mergeEvalResults } from './hfEvalResults.mjs';
import { commitFiles, decideCommitMode } from './hfCommit.mjs';
import { datasetFilesToFetch } from './hfDataset.mjs';
import { mergeEvalTasks } from './suiteDir.mjs';

test('words, key=value options and flags', () => {
  const parsed = parseWords(['org/a', 'suite=../s', 'model=b/c', 'model=d/e', 'pr', '--jobs=3', '--dry-run'], {
    keys: ['suite', 'model', 'jobs'], flags: ['pr', 'dry-run'], repeatable: ['model'],
  });
  assert.deepEqual(parsed.positionals, ['org/a']);
  assert.deepEqual(parsed.options, { suite: '../s', model: ['b/c', 'd/e'], jobs: '3' });
  assert.deepEqual([...parsed.flags].sort(), ['dry-run', 'pr']);
  assert.throws(() => parseWords(['jbos=2'], { keys: ['jobs'] }), /Unknown option "jbos="/);
  assert.throws(() => parseWords(['jobs=1', 'jobs=2'], { keys: ['jobs'] }), /twice/);
  // A path containing "=" is a positional, not an option.
  assert.deepEqual(parseWords(['./a=b/model'], { keys: [] }).positionals, ['./a=b/model']);
  assert.deepEqual(swallowedNpmFlags({ npm_config_pr: 'true', npm_config_no_upload: '' }, ['pr', 'no-upload', 'watch']), ['pr', 'no-upload']);
});

test('targets: models, suites, revisions and local paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-targets-'));
  mkdirSync(join(dir, 'suite'));
  writeFileSync(join(dir, 'suite', 'suite.yaml'), 'suite: x\n');
  mkdirSync(join(dir, 'model'));
  assert.deepEqual(classifyTarget('org/name'), { kind: 'model', source: 'hub', id: 'org/name', revision: null });
  assert.deepEqual(classifyTarget('org/name@v2'), { kind: 'model', source: 'hub', id: 'org/name', revision: 'v2' });
  assert.deepEqual(classifyTarget('https://huggingface.co/org/name/tree/abc123'), { kind: 'model', source: 'hub', id: 'org/name', revision: 'abc123' });
  assert.deepEqual(classifyTarget('datasets/org/bench@v1'), { kind: 'suite', source: 'hub', id: 'org/bench', revision: 'v1' });
  assert.deepEqual(classifyTarget('https://huggingface.co/datasets/org/bench'), { kind: 'suite', source: 'hub', id: 'org/bench', revision: null });
  assert.equal(classifyTarget('suite', { cwd: dir }).kind, 'suite');
  assert.equal(classifyTarget('model', { cwd: dir }).kind, 'model');
  assert.throws(() => classifyTarget('./missing', { cwd: dir }), /does not exist/);
  assert.throws(() => classifyTarget('https://huggingface.co/spaces/a/b'), /Space/);
});

const cell = (id, duration, repeat = 0) => ({ cellId: `${id}#${repeat}`, testId: id, repeat, duration, seed: repeat, timeoutS: 60 });

test('jobs run longest first, shards partition them, pages keep their model', () => {
  const jobs = buildJobs([{ key: 'm0' }, { key: 'm1' }], [cell('a/x', 5), cell('a/long', 100), cell('a/y', 10)]);
  assert.deepEqual(jobs.slice(0, 2).map((j) => j.cell.testId), ['a/long', 'a/long']);
  const shards = [1, 2, 3].map((index) => shardJobs(jobs, { index, count: 3 }));
  assert.equal(shards.flat().length, jobs.length);
  assert.equal(new Set(shards.flat()).size, jobs.length);
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
  assert.throws(() => parseShard('4/3'), /shard=/);

  const queue = jobs.slice();
  assert.equal(takeNextJob(queue, null).modelKey, 'm0');
  assert.equal(takeNextJob(queue, 'm1').modelKey, 'm1');
});

function fakeRun(overrides = {}) {
  const raw = {
    suite: 'smoke', version: 1, harness: { protocol: 1 }, requires: {},
    tests: [{ config: 'a' }], tasks: [{ id: 'upright_rate', metric: 'upright_rate' }],
  };
  const row = {
    id: 'a/x', config: 'a', schema_version: 1, kind: 'velocity-sequence', name: 'x', description: '', tags: [], duration: 1,
    commands: [{ t: 0, vx: 0, vy: 0, wz: 0 }], events: [], limits: null, foot_friction: null, metrics_opt_in: [],
  };
  return {
    schema: RUN_SCHEMA,
    generatedAt: '2026-10-02T00:00:00.000Z',
    provenance: { hpv: { commit: 'c'.repeat(40), dirty: false, protocol: 1 }, asimov1: { commit: 'a'.repeat(40) }, runtime: {} },
    suite: { source: 'hub', id: 'org/bench', sha: 'd'.repeat(40), suiteFile: 'suite.yaml', raw, problems: [] },
    overrides: { tests: null, repeats: null, force: false },
    shard: null,
    models: [{ key: 'm0', id: 'org/model', label: 'org/model', source: 'hub', repo: 'org/model', sha: 'e'.repeat(40), files: {} }],
    tests: [row],
    expectedCells: 1,
    cells: [{ modelKey: 'm0', cellId: 'a/x#0', testId: 'a/x', repeat: 0, metrics: { fell: { fell: false } } }],
    ...overrides,
  };
}

test('only reproducible, complete, error-free runs may be uploaded', () => {
  assert.deepEqual(uploadBlockers(fakeRun(), 'm0'), []);
  const dirty = fakeRun();
  dirty.provenance.hpv.dirty = true;
  assert.match(uploadBlockers(dirty, 'm0').join(), /uncommitted/);
  assert.match(uploadBlockers(fakeRun({ suite: { ...fakeRun().suite, source: 'local' } }), 'm0').join(), /local folder/);
  assert.match(uploadBlockers(fakeRun({ overrides: { tests: ['a/x'], repeats: null, force: false } }), 'm0').join(), /tests=/);
  assert.match(uploadBlockers(fakeRun({ cells: [] }), 'm0').join(), /missing/);
  assert.match(uploadBlockers(fakeRun({ cells: [{ modelKey: 'm0', cellId: 'a/x#0', testId: 'a/x', error: 'boom' }] }), 'm0').join(), /boom/);
});

test('merge needs every shard of the same run exactly once', () => {
  const base = fakeRun({ expectedCells: 2, tests: fakeRun().tests });
  const s1 = { ...base, shard: { index: 1, count: 2 }, cells: [{ ...base.cells[0], cellId: 'a/x#0' }] };
  const s2 = { ...base, shard: { index: 2, count: 2 }, cells: [{ ...base.cells[0], cellId: 'a/x#1', repeat: 1 }] };
  const merged = mergeRuns([s1, s2]);
  assert.equal(merged.cells.length, 2);
  assert.equal(merged.shard, null);
  assert.ok(merged.tasks.m0);
  assert.throws(() => mergeRuns([s1]), /shards 1\.\.2|cells/);
  assert.throws(() => mergeRuns([s1, s1]), /more than one input/);
  const other = { ...s2, provenance: { ...s2.provenance, hpv: { ...s2.provenance.hpv, commit: 'f'.repeat(40) } } };
  assert.throws(() => mergeRuns([s1, other]), /different run/);
});

test('eval results: entries per task, re-runs replace only their own tasks', () => {
  const run = fakeRun({ tasks: { m0: [{ taskId: 'upright_rate_v1', value: 0.5 }, { taskId: 'nothing_v1', value: null }] } });
  const entries = buildEvalResultEntries(run, 'm0', { sourceUrl: 'https://example/report.html' });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].dataset, { id: 'org/bench', task_id: 'upright_rate_v1', revision: 'd'.repeat(40) });
  assert.match(entries[0].notes, /hpv@cccccccccccc protocol=1 suite=smoke v1/);
  assert.equal(evalResultsPath('org/bench'), '.eval_results/org__bench.yaml');

  const existing = mergeEvalResults(null, [
    { dataset: { id: 'org/bench', task_id: 'upright_rate_v1' }, value: 0.1 },
    { dataset: { id: 'org/bench', task_id: 'upright_rate_v0' }, value: 0.9 },
    { dataset: { id: 'other/bench', task_id: 'upright_rate_v1' }, value: 0.3 },
  ]);
  const merged = parseYaml(mergeEvalResults(existing, entries));
  assert.deepEqual(merged.map((e) => [e.dataset.id, e.dataset.task_id, e.value]), [
    ['org/bench', 'upright_rate_v0', 0.9],
    ['other/bench', 'upright_rate_v1', 0.3],
    ['org/bench', 'upright_rate_v1', 0.5],
  ]);
  assert.throws(() => mergeEvalResults('a: 1\n', entries), /not a YAML list/);

  const text = mergeEvalResults(null, [...entries, { ...entries[0], dataset: { ...entries[0].dataset, task_id: 'b_v1' } }]);
  assert.match(text, /date: "2026-10-02T00:00:00.000Z"/);
  assert.doesNotMatch(text, /[&*]a\d/); // no YAML anchors/aliases
  assert.match(text, /notes: hpv@\S+ protocol=1 suite=smoke v1 asimov-1@\S+ model@\S+\n/);
});

test('eval.yaml keeps task ids of earlier suite versions', () => {
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

test('only suite files are fetched from a dataset', () => {
  assert.deepEqual(
    datasetFilesToFetch(['suite.yaml', 'eval.yaml', 'README.md', 'suites/smoke.yaml', 'data/push/test.jsonl', 'data/push/big.parquet', 'calibration/v1.json']),
    ['suite.yaml', 'eval.yaml', 'README.md', 'suites/smoke.yaml', 'data/push/test.jsonl'],
  );
});
