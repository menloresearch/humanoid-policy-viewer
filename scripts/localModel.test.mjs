import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listModels } from './modelDiscovery.mjs';
import { findLocalModel, isLocalModel, linkLocalModel } from './localModel.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-local-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function makeModel(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), file);
  return dir;
}

test('isLocalModel tells paths from Hub repo ids', () => withDir((dir) => {
  for (const path of [dir, './x', '../x', '~/x', '/x/y', 'x/policy.onnx', 'C:\\x']) assert.equal(isLocalModel(path), true, path);
  for (const id of ['Menlo/asimov1-locomotion-0818', 'https://huggingface.co/Menlo/x']) assert.equal(isLocalModel(id), false, id);
}));

test('findLocalModel picks the given .onnx, else policy.onnx, else the only .onnx', () => withDir((dir) => {
  const run = makeModel(join(dir, 'run'), ['policy.onnx', 'other.onnx', 'env.yaml']);
  assert.equal(findLocalModel(run).primary, 'policy.onnx');
  assert.equal(findLocalModel(join(run, 'other.onnx')).primary, 'other.onnx');
  assert.equal(findLocalModel(makeModel(join(dir, 'one'), ['a.onnx'])).primary, 'a.onnx');
}));

test('findLocalModel explains folders it cannot run', () => withDir((dir) => {
  assert.throws(() => findLocalModel(join(dir, 'missing')), /does not exist/);
  assert.throws(() => findLocalModel(makeModel(join(dir, 'empty'), ['env.yaml'])), /contains no .onnx/);
  assert.throws(() => findLocalModel(makeModel(join(dir, 'two'), ['a.onnx', 'b.onnx'])), /several .onnx files \(a.onnx, b.onnx\)/);
  assert.throws(() => findLocalModel(join(dir, 'empty', 'env.yaml')), /not an .onnx file/);
}));

test('linkLocalModel serves the folder as a model library, and cleanup leaves the folder alone', () => withDir((dir) => {
  const run = makeModel(join(dir, 'my run, v2'), ['policy.onnx', 'env.yaml', 'agent.yaml']);
  const local = linkLocalModel(run, { tmpRoot: dir });
  assert.equal(local.root, 'my_run_v2');
  assert.equal(local.policyValue, 'ckpt:my_run_v2/policy.onnx');
  const models = listModels(local.cacheDir, [local.root]);
  assert.deepEqual(models.map((m) => m.path), ['my_run_v2/policy.onnx']);
  assert.equal(`ckpt:${models[0].path}`, local.policyValue);

  local.cleanup();
  assert.equal(existsSync(local.cacheDir), false);
  assert.equal(readFileSync(join(run, 'env.yaml'), 'utf8'), 'env.yaml');
}));
