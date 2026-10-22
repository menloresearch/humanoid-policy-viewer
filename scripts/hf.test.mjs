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

test('a policy word: org/name@rev, options and local folders', () => {
  const args = viewArgs(['Menlo/x@v1', 'port=4000', 'no-open', 'benchmark=datasets/a/b']);
  assert.deepEqual(args.target, { kind: 'policy', source: 'hub', id: 'Menlo/x', revision: 'v1' });
  assert.deepEqual([args.port, args.open, args.benchmark], [4000, false, 'datasets/a/b']);
  assert.equal(viewArgs(['Menlo/x@refs/pr/3']).target.revision, 'refs/pr/3');
  assert.deepEqual([viewArgs(['Menlo/x']).target.revision, viewArgs(['Menlo/x']).open], [null, true]);
  assert.equal(viewArgs(['public/examples/checkpoints/asimov/model_aug_18_1']).target.source, 'local');
  assert.throws(() => viewArgs([]), /No policy given/);
  assert.throws(() => viewArgs(['a/b', 'c/d']), /One policy at a time/);
  assert.throws(() => viewArgs(['datasets/a/b']), /is a benchmark.*npm run dev benchmark=/);
  assert.throws(() => viewArgs(['a/b', 'port=x']), /1-65535/);
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
  assert.match(usage.stdout, /npm run hf <policy>/);
  assert.match(usage.stdout, /HPV only reads from Hugging Face/);
  assert.doesNotMatch(usage.stdout, /publish <dir>|submit <result dir>|for writing/);
});
