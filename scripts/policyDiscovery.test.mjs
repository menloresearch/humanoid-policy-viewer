import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HF_META_FILE } from './hfPolicy.mjs';
import { discoverPolicies } from './policyDiscovery.mjs';

test('Hugging Face downloads are labelled by repo id, other policies by path', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'hpv-discovery-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const hfDir = join(base, 'hf', 'Menlo__asimov1-locomotion-0818');
  mkdirSync(hfDir, { recursive: true });
  writeFileSync(join(hfDir, 'policy.onnx'), '');
  writeFileSync(join(hfDir, 'other.onnx'), '');
  writeFileSync(join(hfDir, HF_META_FILE), JSON.stringify({ repo: 'Menlo/asimov1-locomotion-0818', primary: 'policy.onnx' }));
  mkdirSync(join(base, 'policies', 'mine'), { recursive: true });
  writeFileSync(join(base, 'policies', 'mine', 'policy.onnx'), '');

  const labels = Object.fromEntries(discoverPolicies(base, ['hf', 'policies']).map((p) => [p.path, p.label]));
  assert.deepEqual(labels, {
    'hf/Menlo__asimov1-locomotion-0818/other.onnx': 'Menlo/asimov1-locomotion-0818 (other.onnx)',
    'hf/Menlo__asimov1-locomotion-0818/policy.onnx': 'Menlo/asimov1-locomotion-0818',
    'policies/mine/policy.onnx': 'policies/mine/policy.onnx',
  });
});
