import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvPolicySettings } from './envPolicyConfig.js';
import {
  FALLBACK_INIT_STATE, START_PRESETS, resolveStartState, startPresetOf, validateSettle, validateStartState, worldToBody,
} from './startState.js';

const checkpoints = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/examples/checkpoints/asimov');
const joints = JSON.parse(readFileSync(resolve(checkpoints, 'reference_policy_config.json'), 'utf8')).policy_joint_names;
const bundledEnv = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8');

const close = (actual, expected, eps = 1e-9) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < eps, `[${i}] ${value} != ${expected[i]}`));
};

test('the bundled env.yaml gives its init_state: base pose, velocities and the default joint pose', () => {
  const { init_state: init, default_joint_pos: pose } = parseEnvPolicySettings(bundledEnv, joints);
  assert.deepEqual(init.pos, [0, 0, 0.639]);
  assert.deepEqual(init.rot, [1, 0, 0, 0]);
  assert.deepEqual(init.lin_vel, [0, 0, 0]);
  assert.deepEqual(init.ang_vel, [0, 0, 0]);
  assert.deepEqual(init.joint_vel, joints.map(() => 0));
  assert.deepEqual(init.joint_pos, pose);
});

test('init_state vectors may be flow lists, as mjlab writes them', () => {
  const env = bundledEnv.replace(/( {4}init_state:\n {6}pos: )!!python\/tuple\n(?: {6}- .*\n){3}/, '$1[0.1, -0.2, 0.7]\n');
  assert.deepEqual(parseEnvPolicySettings(env, joints).init_state.pos, [0.1, -0.2, 0.7]);
});

test('without an override the start is the policy init_state; an override replaces only what it gives', () => {
  const pose = joints.map((_, i) => i / 100);
  const init = { pos: [0, 0, 0.639], rot: [1, 0, 0, 0], lin_vel: [0, 0, 0], ang_vel: [0, 0, 0], joint_pos: pose };
  const plain = resolveStartState(init, null, joints);
  close(plain.pos, [0, 0, 0.639]);
  close(Array.from(plain.jointPos), pose);
  close(Array.from(plain.jointVel), joints.map(() => 0));

  const knee = joints.indexOf('left_knee_joint');
  const moved = resolveStartState(init, { pos: [1, 2, 0.3], rot: [2, 0, 0, 0], joint_pos: { '.*_knee_joint': 1.2 }, joint_vel: { left_knee_joint: 3 } }, joints);
  close(moved.pos, [1, 2, 0.3]);
  close(moved.rot, [1, 0, 0, 0]); // normalised
  assert.equal(moved.jointPos[knee], 1.2);
  assert.equal(moved.jointPos[joints.indexOf('right_knee_joint')], 1.2);
  assert.equal(moved.jointPos[0], pose[0]);
  assert.equal(moved.jointVel[knee], 3);
});

test('a policy without an init_state starts at the fallback pose', () => {
  const start = resolveStartState(null, null, joints);
  close(start.pos, FALLBACK_INIT_STATE.pos);
  close(start.rot, FALLBACK_INIT_STATE.rot);
});

test('joint patterns must match a policy joint, and only one pattern may match a joint', () => {
  assert.throws(() => resolveStartState(null, { joint_pos: { left_kne_joint: 1 } }, joints), /left_kne_joint matches none/);
  assert.throws(() => resolveStartState(null, { joint_pos: { '.*_knee_joint': 1, 'left_.*': 2 } }, joints), /all match left_knee_joint/);
  // An exact name wins over a pattern.
  const start = resolveStartState(null, { joint_pos: { '.*_knee_joint': 1, left_knee_joint: 2 } }, joints);
  assert.equal(start.jointPos[joints.indexOf('left_knee_joint')], 2);
  assert.equal(start.jointPos[joints.indexOf('right_knee_joint')], 1);
});

test('start validation names each problem', () => {
  assert.deepEqual(validateStartState({ pos: [0, 0, 0.2] }), []);
  assert.deepEqual(validateStartState(null), ['must be an object like env.yaml\'s init_state']);
  assert.deepEqual(validateStartState({ height: 1 }), ['unknown key "height"']);
  assert.deepEqual(validateStartState({ pos: [0, 0] }), ['pos must be 3 numbers']);
  assert.deepEqual(validateStartState({ rot: [0, 0, 0, 0] }), ['rot must not be all zeros']);
  assert.deepEqual(validateStartState({ joint_pos: { '(': 1 } }), ['joint_pos: "(" is not a valid pattern']);
  assert.deepEqual(validateStartState({ joint_vel: { a: 'x' } }), ['joint_vel["a"] must be a number']);
  for (const preset of START_PRESETS) if (preset.start) assert.deepEqual(validateStartState(preset.start), []);
});

test('presets are recognised; anything else is custom', () => {
  assert.equal(startPresetOf(null), 'policy_default');
  assert.equal(startPresetOf(undefined), 'policy_default');
  assert.equal(startPresetOf(structuredClone(START_PRESETS[1].start)), 'standing');
  assert.equal(startPresetOf(structuredClone(START_PRESETS[2].start)), 'lying_on_back');
  assert.equal(startPresetOf({ pos: [0, 0, 1] }), 'custom');
});

test('the settle time is off (null) or 0 < s <= 10', () => {
  assert.deepEqual(validateSettle(null), []);
  assert.deepEqual(validateSettle(2.5), []);
  assert.equal(validateSettle(0).length, 1);
  assert.equal(validateSettle(11).length, 1);
});

test('a world-frame velocity is rotated into the body frame', () => {
  close(worldToBody([1, 0, 0, 0], [1, 2, 3]), [1, 2, 3]);
  // Yawed +90 degrees: world +x is the body's -y.
  close(worldToBody([Math.SQRT1_2, 0, 0, Math.SQRT1_2], [1, 0, 0]), [0, -1, 0], 1e-12);
});
