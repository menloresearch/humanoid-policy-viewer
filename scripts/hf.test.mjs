import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { command, viewArgs } from './hf.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hf(...args) {
  // No npm here, so none of its npm_config_* variables either.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')));
  return spawnSync(process.execPath, [join(appDir, 'scripts/hf.mjs'), ...args], { cwd: appDir, encoding: 'utf8', env });
}

test('the first word picks a verb; anything else is a policy to view', () => {
  for (const verb of ['pull', 'diff', 'baseline', 'publish', 'release', 'submit']) assert.equal(command([verb, 'x']), verb);
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

test('verbs check their own words', () => {
  assert.match(hf('submit').stderr, /submit needs <dir>/);
  assert.match(hf('submit', 'x', 'base=main').stderr, /Unknown option "base="/);
  assert.match(hf('diff', 'port=3').stderr, /Unknown option "port="/);
  assert.match(hf('release', '--rev=abc').stderr, /write rev=abc/);
  const usage = hf();
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /npm run hf <policy>/);
});
