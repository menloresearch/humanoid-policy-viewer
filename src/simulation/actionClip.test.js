// env.yaml's actions.joint_pos.clip: how it is read (Isaac Lab's
// resolve_matching_names_values) and where PolicyRunner applies it (on the
// joint position target, as Isaac Lab's JointAction.process_actions does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { parseEnvPolicySettings } from './envPolicyConfig.js';
import { PolicyRunner } from './policyRunner.js';

const checkpoints = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/examples/checkpoints/asimov');
const reference = JSON.parse(readFileSync(resolve(checkpoints, 'reference_policy_config.json'), 'utf8'));
const bundledEnv = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8');
const joints = reference.policy_joint_names;
const UNCLIPPED = [-Infinity, Infinity];

// The bundled env.yaml (clip: null) with `clip` lines in its actions.joint_pos.
function clippedEnv(clip) {
  const yaml = bundledEnv.replace('\n    clip: null\n    joint_names:\n', `\n    clip:\n${clip.map((line) => `      ${line}\n`).join('')}    joint_names:\n`);
  assert.notEqual(yaml, bundledEnv);
  return yaml;
}

// As Menlo/asimov1-locomotion-26-09-24 and others write it.
const ANKLE_ROLL = ['.*_ankle_roll_joint: !!python/tuple', '- -0.09', '- 0.09'];

const clipOf = (clip) => parseEnvPolicySettings(clippedEnv(clip), joints);
const errorOf = (clip) => {
  const settings = clipOf(clip);
  assert.equal(settings.target_clip, undefined);
  assert.equal(settings.control_errors.length, 1);
  return settings.control_errors[0];
};

test('a clip: null policy has no target clip and nothing else changes', () => {
  const settings = parseEnvPolicySettings(bundledEnv, joints);
  assert.equal('target_clip' in settings, false);
  assert.equal(settings.control_errors, undefined);
});

test('a pattern clips every joint it fully matches; the others are not clipped', () => {
  const settings = clipOf(ANKLE_ROLL);
  assert.equal(settings.control_errors, undefined);
  assert.deepEqual(settings.target_clip, joints.map((joint) => (joint.endsWith('_ankle_roll_joint') ? [-0.09, 0.09] : UNCLIPPED)));
  // Everything else is read as before.
  const { target_clip: _, ...rest } = settings;
  assert.deepEqual(rest, parseEnvPolicySettings(bundledEnv, joints));
});

test('tuples, inline lists, exact names and infinite bounds are read', () => {
  const settings = clipOf([
    'left_knee_joint: [-0.5, 1.5]',
    'right_knee_joint: !!python/tuple',
    '- -.inf',
    '- 0.25',
    '(left|right)_elbow_joint: !!python/tuple',
    '- -1.0e-1',
    '- .inf',
  ]);
  assert.equal(settings.control_errors, undefined);
  const expected = Object.fromEntries(joints.map((joint) => [joint, UNCLIPPED]));
  expected.left_knee_joint = [-0.5, 1.5];
  expected.right_knee_joint = [-Infinity, 0.25];
  expected.left_elbow_joint = [-0.1, Infinity];
  expected.right_elbow_joint = [-0.1, Infinity];
  assert.deepEqual(settings.target_clip, joints.map((joint) => expected[joint]));
});

test('a clip the viewer cannot apply as in training is a control error, so the policy is refused', () => {
  const prefix = 'its actions.joint_pos.clip cannot be applied: ';
  // Isaac Lab full-matches and requires every pattern to match a joint.
  assert.equal(errorOf(['ankle_roll: [-0.1, 0.1]']), `${prefix}ankle_roll matches none of the policy's joints`);
  assert.equal(errorOf(['.*_toe_joint: [-0.1, 0.1]']), `${prefix}.*_toe_joint matches none of the policy's joints`);
  // ... and that no joint matches two.
  assert.equal(errorOf(['.*_ankle_.*: [-0.1, 0.1]', 'left_ankle_roll_joint: [-0.2, 0.2]']),
    `${prefix}left_ankle_roll_joint is matched by both .*_ankle_.* and left_ankle_roll_joint`);
  // Malformed values and patterns.
  assert.equal(errorOf(['.*_ankle_roll_joint: !!python/tuple', '- -0.09']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['.*_ankle_roll_joint: [-0.09, 0.09, 1]']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['.*_ankle_roll_joint: 0.09']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['.*_ankle_roll_joint: [low, high]']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['.*_ankle_roll_joint: !!python/tuple', '- null', '- 0.09']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['.*_ankle_roll_joint:', '  min: -0.09', '  max: 0.09']), `${prefix}.*_ankle_roll_joint is not a (min, max) pair of numbers`);
  assert.equal(errorOf(['(.*_ankle_roll_joint: [-0.09, 0.09]']), `${prefix}(.*_ankle_roll_joint is not a valid joint pattern`);
  assert.equal(errorOf(['- -0.09']), `${prefix}expected a block of "<joint pattern>: (min, max)" entries`);
  // A flow map is not how Isaac Lab writes env.yaml; it is refused rather than guessed at.
  const flow = parseEnvPolicySettings(bundledEnv.replace('\n    clip: null\n', '\n    clip: {.*_ankle_roll_joint: [-0.09, 0.09]}\n'), joints);
  assert.deepEqual(flow.control_errors, [`${prefix}expected a block of "<joint pattern>: (min, max)" entries`]);
});

// An ONNX session that outputs `actions` whatever it is fed, so PolicyRunner.step
// runs exactly as in the viewer and the benchmark, model aside.
function fakeSession(actions) {
  return {
    inputNames: ['obs'],
    outputNames: ['actions'],
    inputMetadata: [{ name: 'obs', isTensor: true, type: 'float32', shape: [1, 78] }],
    outputMetadata: [{ name: 'actions', isTensor: true, type: 'float32', shape: [1, 23] }],
    run: async () => ({ actions: new ort.Tensor('float32', Float32Array.from(actions), [1, actions.length]) }),
  };
}

function runnerFor(yaml, actions) {
  const settings = parseEnvPolicySettings(yaml, joints);
  const config = { ...reference, ...settings };
  const runner = new PolicyRunner(config, { policyJointNames: joints, actionScale: config.action_scale, defaultJointPos: config.default_joint_pos });
  runner.module.useSession(fakeSession(actions));
  runner.reset();
  return runner;
}

const state = { rootAngVel: [0.1, -0.2, 0.3], rootQuat: [1, 0, 0, 0], jointPos: new Float32Array(23), jointVel: new Float32Array(23) };
// The ankle-roll ones push their targets past 0.09 rad, one each way (scale 0.25, default 0).
const ACTIONS = joints.map((joint, i) => ({ left_ankle_roll_joint: 1.5, right_ankle_roll_joint: -1.5 })[joint] ?? 1.7 * Math.sin(1.3 * i + 0.4));

test('PolicyRunner clips the joint position target (default + scale * action), not the action', async () => {
  const clipped = runnerFor(clippedEnv(ANKLE_ROLL), ACTIONS);
  const plain = runnerFor(bundledEnv, ACTIONS);
  const target = await clipped.step(state);
  const unclipped = await plain.step(state);
  joints.forEach((joint, i) => {
    // The policy's own output is untouched (it is the last_action observation).
    assert.equal(clipped.lastActions[i], plain.lastActions[i]);
    // Without a clip, the target is exactly what it always was.
    assert.equal(unclipped[i], Math.fround(plain.defaultJointPos[i] + plain.actionScale[i] * plain.lastActions[i]), joint);
    if (joint.endsWith('_ankle_roll_joint')) {
      assert.ok(Math.abs(unclipped[i]) > 0.09, `${joint} target ${unclipped[i]} should exceed the clip`);
      assert.equal(target[i], Math.fround(Math.sign(unclipped[i]) * 0.09), joint);
    } else {
      assert.equal(target[i], unclipped[i], joint);
    }
  });
  // A target within the bounds is left as it is.
  const small = runnerFor(clippedEnv(ANKLE_ROLL), ACTIONS.map((value) => value / 10));
  const smallPlain = runnerFor(bundledEnv, ACTIONS.map((value) => value / 10));
  assert.deepEqual(await small.step(state), await smallPlain.step(state));
});

test('every robot of a grouped benchmark run clips its target', async () => {
  const runner = runnerFor(clippedEnv(ANKLE_ROLL), ACTIONS);
  const twin = runner.twin();
  assert.deepEqual(await twin.step(state), await runner.step(state));
  const target = await twin.step(state);
  assert.equal(target[joints.indexOf('left_ankle_roll_joint')], Math.fround(0.09));
  assert.equal(target[joints.indexOf('right_ankle_roll_joint')], Math.fround(-0.09));
});
