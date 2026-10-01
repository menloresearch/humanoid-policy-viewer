import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HF_META_FILE } from './hfModel.mjs';
import { listModels } from './modelDiscovery.mjs';

test('Hugging Face downloads are labelled by repo id, other models by path', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'hpv-discovery-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const hfDir = join(base, 'hf', 'Menlo__asimov1-locomotion-0818');
  mkdirSync(hfDir, { recursive: true });
  writeFileSync(join(hfDir, 'policy.onnx'), '');
  writeFileSync(join(hfDir, 'other.onnx'), '');
  writeFileSync(join(hfDir, HF_META_FILE), JSON.stringify({ repo: 'Menlo/asimov1-locomotion-0818', primary: 'policy.onnx' }));
  mkdirSync(join(base, 'models', 'mine'), { recursive: true });
  writeFileSync(join(base, 'models', 'mine', 'policy.onnx'), '');

  const labels = Object.fromEntries(listModels(base, ['hf', 'models']).map((m) => [m.path, m.label]));
  assert.deepEqual(labels, {
    'hf/Menlo__asimov1-locomotion-0818/other.onnx': 'Menlo/asimov1-locomotion-0818 (other.onnx)',
    'hf/Menlo__asimov1-locomotion-0818/policy.onnx': 'Menlo/asimov1-locomotion-0818',
    'models/mine/policy.onnx': 'models/mine/policy.onnx',
  });
});
