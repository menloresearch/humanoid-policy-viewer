import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverPolicies } from './policyDiscovery.mjs';
import { expandLocalPolicy, findLocalPolicy, findPolicyFolders, isLocalPolicy, linkPolicyLibrary, policyLabels } from './localPolicy.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-local-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function makePolicy(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), file);
  return dir;
}

test('isLocalPolicy tells paths from Hub repo ids', () => withDir((dir) => {
  for (const path of [dir, './x', '../x', '~/x', '/x/y', 'x/policy.onnx', 'C:\\x']) assert.equal(isLocalPolicy(path), true, path);
  for (const id of ['Menlo/asimov1-locomotion-0818', 'https://huggingface.co/Menlo/x']) assert.equal(isLocalPolicy(id), false, id);
}));

test('findLocalPolicy picks the given .onnx, else policy.onnx, else the only .onnx', () => withDir((dir) => {
  const run = makePolicy(join(dir, 'run'), ['policy.onnx', 'other.onnx', 'env.yaml']);
  assert.equal(findLocalPolicy(run).primary, 'policy.onnx');
  assert.equal(findLocalPolicy(join(run, 'other.onnx')).primary, 'other.onnx');
  assert.equal(findLocalPolicy(makePolicy(join(dir, 'one'), ['a.onnx'])).primary, 'a.onnx');
}));

test('findLocalPolicy explains folders it cannot run', () => withDir((dir) => {
  assert.throws(() => findLocalPolicy(join(dir, 'missing')), /does not exist/);
  assert.throws(() => findLocalPolicy(makePolicy(join(dir, 'empty'), ['env.yaml'])), /contains no .onnx/);
  assert.throws(() => findLocalPolicy(makePolicy(join(dir, 'two'), ['a.onnx', 'b.onnx'])), /several .onnx files \(a.onnx, b.onnx\)/);
  assert.throws(() => findLocalPolicy(join(dir, 'empty', 'env.yaml')), /not an .onnx file/);
}));

test('a folder with no .onnx stands for every policy folder below it', () => withDir((dir) => {
  const logs = join(dir, 'logs');
  makePolicy(join(logs, 'run1', 'exported'), ['policy.onnx', 'env.yaml']);
  makePolicy(join(logs, 'run2', 'exported'), ['policy.onnx', 'env.yaml', 'agent.yaml']);
  makePolicy(join(logs, 'run3', 'exported'), ['a.onnx', 'b.onnx', 'env.yaml']); // several .onnx: no single one to run
  makePolicy(join(logs, 'run4', 'exported'), ['policy.onnx']); // no env.yaml: not a policy folder
  makePolicy(join(logs, 'run5', 'exported', 'params'), ['env.yaml']);
  writeFileSync(join(logs, 'run5', 'exported', 'model.onnx'), '');
  makePolicy(join(logs, '.hidden', 'exported'), ['policy.onnx', 'env.yaml']);
  makePolicy(join(logs, 'run1', 'exported', 'nested'), ['policy.onnx', 'env.yaml']); // inside a policy folder: not searched
  const real = (path) => realpathSync(join(logs, path));
  assert.deepEqual(findPolicyFolders(logs), ['run1', 'run2', 'run3', 'run5'].map((run) => join(logs, run, 'exported')));
  assert.deepEqual(expandLocalPolicy(logs), [
    { policyDir: real('run1/exported'), primary: 'policy.onnx', scanned: true },
    { policyDir: real('run2/exported'), primary: 'policy.onnx', scanned: true },
    { policyDir: real('run3/exported'), primary: null, scanned: true, error: `${join(logs, 'run3', 'exported')} contains several .onnx files (a.onnx, b.onnx); pass the one to run` },
    { policyDir: real('run5/exported'), primary: 'model.onnx', scanned: true },
  ]);
  // A policy folder or an .onnx is itself, not a search.
  assert.deepEqual(expandLocalPolicy(join(logs, 'run1', 'exported')), [{ policyDir: real('run1/exported'), primary: 'policy.onnx', scanned: false }]);
  assert.throws(() => expandLocalPolicy(makePolicy(join(dir, 'empty'), ['notes.txt'])), /contains no \.onnx file, and no folder below it holds an \.onnx with an env\.yaml/);
}));

test('policies on disk are labelled by their shortest distinguishing path suffix', () => {
  assert.deepEqual(policyLabels(['/x/run1/exported', '/x/run2/exported', '/y/other']), ['run1/exported', 'run2/exported', 'other']);
  assert.deepEqual(policyLabels(['/a/b/exported', '/c/b/exported', '/a/d/exported']), ['a/b/exported', 'c/b/exported', 'd/exported']);
  assert.deepEqual(policyLabels(['/only/one']), ['one']);
  // A suffix of another folder's path still differs from that folder's longer label.
  assert.deepEqual(policyLabels(['/b/exported', '/a/b/exported']), ['/b/exported', 'a/b/exported']);
  // Not the same as a Hub repo id listed beside them.
  assert.deepEqual(policyLabels(['/data/Menlo/asimov1', '/x/asimov1'], ['Menlo/asimov1']), ['data/Menlo/asimov1', 'x/asimov1']);
});

test('linkPolicyLibrary lists each policy under its label beside the base roots, and cleanup leaves the folders alone', () => withDir((dir) => {
  const run1 = makePolicy(join(dir, 'run1', 'exported'), ['policy.onnx', 'other.onnx', 'env.yaml']);
  const run2 = makePolicy(join(dir, 'my run, v2', 'exported'), ['model.onnx', 'env.yaml', 'agent.yaml']);
  const base = makePolicy(join(dir, 'cache', 'hf', 'Menlo__x'), ['policy.onnx', 'env.yaml']);
  const library = linkPolicyLibrary([
    { policyDir: run1, primary: 'policy.onnx', label: 'run1/exported' },
    { policyDir: run2, primary: 'model.onnx', label: 'my run, v2/exported' },
  ], { base: { dir: join(dir, 'cache'), roots: ['hf'] }, tmpRoot: dir });
  assert.deepEqual(library.roots, ['hf', 'run1__exported', 'my_run_v2__exported']);
  assert.deepEqual(library.values, ['lib:run1__exported/policy.onnx', 'lib:my_run_v2__exported/model.onnx']);
  const policies = discoverPolicies(library.dir, library.roots, { labels: library.labels });
  assert.deepEqual(policies.map((p) => [p.path, p.label]), [
    ['hf/Menlo__x/policy.onnx', 'hf/Menlo__x/policy.onnx'],
    ['my_run_v2__exported/model.onnx', 'my run, v2/exported'],
    ['run1__exported/other.onnx', 'run1/exported (other.onnx)'],
    ['run1__exported/policy.onnx', 'run1/exported'],
  ]);
  for (const value of library.values) assert.ok(policies.some((p) => `lib:${p.path}` === value), value);

  library.cleanup();
  assert.equal(existsSync(library.dir), false);
  assert.equal(readFileSync(join(run1, 'env.yaml'), 'utf8'), 'env.yaml');
  assert.ok(existsSync(join(base, 'policy.onnx')));
}));
