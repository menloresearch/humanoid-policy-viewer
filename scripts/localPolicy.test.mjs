import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverPolicies } from './policyDiscovery.mjs';
import { findLocalPolicy, isLocalPolicy, linkLocalPolicy } from './localPolicy.mjs';

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

test('linkLocalPolicy serves the folder as a policy library, and cleanup leaves the folder alone', () => withDir((dir) => {
  const run = makePolicy(join(dir, 'my run, v2'), ['policy.onnx', 'env.yaml', 'agent.yaml']);
  const local = linkLocalPolicy(run, { tmpRoot: dir });
  assert.equal(local.root, 'my_run_v2');
  assert.equal(local.policyValue, 'lib:my_run_v2/policy.onnx');
  const policies = discoverPolicies(local.cacheDir, [local.root]);
  assert.deepEqual(policies.map((p) => p.path), ['my_run_v2/policy.onnx']);
  assert.equal(`lib:${policies[0].path}`, local.policyValue);

  local.cleanup();
  assert.equal(existsSync(local.cacheDir), false);
  assert.equal(readFileSync(join(run, 'env.yaml'), 'utf8'), 'env.yaml');
}));
