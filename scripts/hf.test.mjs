import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RETIRED_VERBS, command, viewArgs } from './hf.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hf(...args) {
  // No npm here, so none of its npm_config_* variables either.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')));
  return spawnSync(process.execPath, [join(appDir, 'scripts/hf.mjs'), ...args], { cwd: appDir, encoding: 'utf8', env });
}

test('the first word is help, a retired Hub write verb, or a policy to view', () => {
  for (const verb of ['pull', 'diff', 'baseline', 'publish', 'release', 'submit']) assert.equal(command([verb, 'x']), 'retired');
  assert.equal(command([]), 'help');
  assert.equal(command(['help']), 'help');
  assert.equal(command(['Menlo/asimov1-locomotion-0818']), 'view');
  assert.equal(command(['./my-policy', 'port=4000']), 'view');
});

test('policy words: org/name@rev, options and local folders', () => {
  const args = viewArgs(['Menlo/x@v1', 'port=4000', 'no-open', 'benchmark=datasets/a/b']);
  assert.deepEqual(args.policies, [{ kind: 'policy', source: 'hub', id: 'Menlo/x', revision: 'v1' }]);
  assert.deepEqual(args.benchmark, { kind: 'benchmark', source: 'hub', id: 'a/b', revision: null });
  assert.deepEqual([args.port, args.open], [4000, false]);
  assert.equal(viewArgs(['Menlo/x@refs/pr/3']).policies[0].revision, 'refs/pr/3');
  assert.deepEqual([viewArgs(['Menlo/x']).policies[0].revision, viewArgs(['Menlo/x']).open, viewArgs(['Menlo/x']).benchmark], [null, true, null]);
  assert.equal(viewArgs(['public/examples/checkpoints/asimov/model_aug_18_1']).policies[0].source, 'local');
  assert.throws(() => viewArgs([]), /No policy given/);
  assert.throws(() => viewArgs(['datasets/a/b']), /No policy given/);
  assert.throws(() => viewArgs(['a/b', 'port=x']), /1-65535/);
});

test('several policies and a benchmark, in any order, Hub or local; policy= and benchmark= say which is which', () => {
  const local = 'public/examples/checkpoints/asimov/model_aug_18_1';
  const forward = viewArgs(['Menlo/a', local, 'test/fixtures/smoke-benchmark']);
  const backward = viewArgs(['test/fixtures/smoke-benchmark', local, 'Menlo/a']);
  assert.deepEqual(forward.policies.map((p) => p.source), ['hub', 'local']);
  assert.deepEqual(backward.policies.map((p) => p.source), ['local', 'hub']);
  for (const args of [forward, backward]) assert.deepEqual(args.benchmark, { kind: 'benchmark', source: 'local', path: join(appDir, 'test/fixtures/smoke-benchmark') });
  assert.deepEqual(viewArgs(['datasets/org/bench@v2', 'Menlo/a']).benchmark, { kind: 'benchmark', source: 'hub', id: 'org/bench', revision: 'v2' });
  // A bare org/name is a policy; benchmark= makes it a dataset id.
  const explicit = viewArgs(['benchmark=org/bench', 'policy=Menlo/a', 'policy=Menlo/b']);
  assert.deepEqual(explicit.benchmark, { kind: 'benchmark', source: 'hub', id: 'org/bench', revision: null });
  assert.deepEqual(explicit.policies.map((p) => p.id), ['Menlo/a', 'Menlo/b']);
  assert.throws(() => viewArgs(['Menlo/a', 'datasets/a/b', 'datasets/c/d']), /Give one benchmark, got datasets\/a\/b and datasets\/c\/d/);
  assert.throws(() => viewArgs(['policy=datasets/a/b']), /policy=datasets\/a\/b is a benchmark dataset, not a policy/);
});

test('old --flags fail with the words form to write instead', () => {
  assert.throws(() => viewArgs(['--revision', 'x', 'foo']), /"--revision": no dashes; write the revision as org\/name@rev/);
  assert.throws(() => viewArgs(['a/b', '--port=4000']), /write port=4000/);
  assert.throws(() => viewArgs(['a/b', '--no-open']), /write no-open/);
  const run = hf('--revision', 'x', 'foo');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /org\/name@rev/);
});

test('the retired Hub write verbs fail with one line that points to cyclotron', () => {
  assert.deepEqual(RETIRED_VERBS, ['pull', 'diff', 'baseline', 'publish', 'release', 'submit']);
  for (const args of [['publish', './bench', 'pr'], ['submit', 'benchmark_results/x'], ['pull', 'datasets/a/b', 'dir'], ['release', 'datasets/a/b', 'rev=abc'], ['diff'], ['baseline', './b']]) {
    const run = hf(...args);
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stdout, '');
    const lines = run.stderr.trim().split('\n');
    assert.equal(lines.length, 1, run.stderr);
    assert.equal(lines[0], `npm run hf ${args[0]} is gone: HPV only reads from Hugging Face; publishing benchmarks and submitting results are done with cyclotron (https://github.com/menloresearch/cyclotron).`);
  }
  const usage = hf();
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /npm run hf <policy\.\.\.> \[<benchmark>\]/);
  assert.match(usage.stdout, /HPV only reads from Hugging Face/);
  assert.doesNotMatch(usage.stdout, /publish <dir>|submit <result dir>|for writing/);
});
