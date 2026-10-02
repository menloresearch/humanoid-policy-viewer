import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvPolicySettings } from './envPolicyConfig.js';

const viewerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkpoints = resolve(viewerRoot, 'public/examples/checkpoints/asimov');
const reference = JSON.parse(readFileSync(resolve(checkpoints, 'reference_policy_config.json'), 'utf8'));
const BUNDLED_ONNX = './examples/checkpoints/asimov/model_aug_18_1/policy_isaaclab_new.onnx';

// Serves ./examples/checkpoints/asimov/... from disk; everything else is a 404.
function fakeFetch(requested) {
  return async (url) => {
    requested.push(url);
    const prefix = './examples/checkpoints/asimov/';
    const file = url.startsWith(prefix) ? resolve(checkpoints, url.slice(prefix.length)) : null;
    try {
      return new Response(readFileSync(file), { headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      return new Response('', { status: 404 });
    }
  };
}

async function withFetchAndWarnings(run) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const requested = [];
  const warnings = [];
  globalThis.fetch = fakeFetch(requested);
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return await run({ requested, warnings });
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

test('the bundled example checkpoint gets its training settings from the env.yaml beside its onnx', async () => {
  await withFetchAndWarnings(async ({ requested }) => {
    const settings = await loadEnvPolicySettings(BUNDLED_ONNX, reference.policy_joint_names);
    assert.deepEqual(requested, [
      './examples/checkpoints/asimov/model_aug_18_1/params/env.yaml',
      './examples/checkpoints/asimov/model_aug_18_1/env.yaml'
    ]);
    assert.equal(settings.stiffness[0], 150);
    assert.equal(settings.torque_limit[0], 45);
    assert.equal(settings.torque_limit.length, reference.policy_joint_names.length);
  });
});

test('a model-library checkpoint looks for env.yaml in its model folder, or in the root when the onnx sits directly in it', async () => {
  await withFetchAndWarnings(async ({ requested, warnings }) => {
    await loadEnvPolicySettings('/model-library/hf/Menlo__x/exported/policy.onnx', reference.policy_joint_names);
    await loadEnvPolicySettings('/model-library/my-run/policy.onnx', reference.policy_joint_names);
    assert.deepEqual(requested, [
      '/model-library/hf/Menlo__x/params/env.yaml',
      '/model-library/hf/Menlo__x/env.yaml',
      '/model-library/my-run/params/env.yaml',
      '/model-library/my-run/env.yaml'
    ]);
    assert.equal(warnings.length, 2, 'a missing env.yaml is reported for both');
  });
});

test('the reference config points at the bundled onnx and lists the joints in the order env.yaml trained them', () => {
  assert.equal(reference.onnx.path, BUNDLED_ONNX);
  const lines = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8').split('\n');
  const actions = lines.indexOf('actions:');
  const start = lines.findIndex((line, i) => i > actions && line.trim() === 'joint_names:');
  assert.ok(actions >= 0 && start > actions, 'actions.joint_pos.joint_names not found');
  const trained = [];
  for (let i = start + 1; lines[i].trim().startsWith('- '); i++) trained.push(lines[i].trim().slice(2));
  assert.deepEqual(reference.policy_joint_names, trained);
});

test('a bundled policy with no env.yaml loads silently, a model-library one warns', async () => {
  await withFetchAndWarnings(async ({ warnings }) => {
    assert.equal(await loadEnvPolicySettings('./examples/checkpoints/other/policy.onnx', reference.policy_joint_names), null);
    assert.equal(warnings.length, 0);
    assert.equal(await loadEnvPolicySettings('/model-library/models/m/policy.onnx', reference.policy_joint_names), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no env\.yaml found/);
  });
});

test("the bundled env.yaml's asset_path is the real URDF in the asimov-1 submodule", {
  skip: existsSync(resolve(viewerRoot, 'public/examples/scenes/asimov-1/sim-model/urdf/asimov_1.urdf')) ? false : 'asimov-1 submodule is not checked out (run scripts/init-asimov-1.sh)'
}, () => {
  const yaml = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8');
  const assetPath = yaml.match(/^\s+asset_path:\s*(\S+)\s*$/m)?.[1];
  assert.ok(assetPath, 'asset_path not found');
  assert.ok(!assetPath.startsWith('/'), 'asset_path should be relative to the viewer root, not a machine-local absolute path');
  assert.ok(existsSync(resolve(viewerRoot, assetPath)), `asset_path does not exist: ${assetPath}`);
});
