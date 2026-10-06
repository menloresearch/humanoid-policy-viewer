import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvPolicySettings } from './envPolicyConfig.js';
import { asimovCommandState, ObsHistory } from './observationHelpers.js';
import { PolicyRunner } from './policyRunner.js';
import { policyIOErrors } from './policyIO.js';

const checkpoints = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/examples/checkpoints/asimov');
const reference = JSON.parse(readFileSync(resolve(checkpoints, 'reference_policy_config.json'), 'utf8'));
const bundledEnv = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8');
const joints = reference.policy_joint_names;

// The bundled env.yaml with its observations.policy group rewritten by `edit`
// and `commands` added to its commands section.
function envWith(edit, commands = '') {
  const start = bundledEnv.indexOf('\n  policy:\n', bundledEnv.indexOf('\nobservations:\n'));
  const end = bundledEnv.indexOf('\n  critic:\n', start);
  const group = edit(bundledEnv.slice(start, end));
  return (bundledEnv.slice(0, start) + group + bundledEnv.slice(end)).replace('\ncommands:\n', `\ncommands:\n${commands}`);
}

const withoutTerm = (name) => (group) => group.replace(new RegExp(`\\n    ${name}:\\n(?:      .*\\n?)+`), '\n');
const appendTerm = (text) => (group) => `${group}\n${text}`;

const GAIT_TERM = [
  '    gait_phase:',
  '      func: isaaclab.envs.mdp.observations:generated_commands',
  '      params:',
  '        command_name: gait',
  '      scale: null',
  '      history_length: 0',
].join('\n');
const GAIT_COMMAND = [
  '  gait:',
  '    class_type: asimov_flex.skills.walk.mdp.gait_clock:GaitClockCommand',
  '    period_slow: 0.8',
  '    period_fast: 0.7',
  '    speed_slow: 0.2',
  '    speed_fast: 0.8',
  '    stand_threshold: 0.1',
  '',
].join('\n');

function runnerFor(settings) {
  assert.equal(settings.obs_config_error, undefined);
  return new PolicyRunner({ ...reference, ...settings });
}

function state(seed) {
  const values = (n, k) => Float32Array.from({ length: n }, (_, i) => Math.sin(seed * 7.3 + i * k));
  return { rootAngVel: values(3, 1.1), rootQuat: [0.98, 0.1, -0.15, 0.05], jointPos: values(23, 0.7), jointVel: values(23, 1.9) };
}

// What PolicyRunner.step feeds the ONNX model, without running it.
function observe(runner, s) {
  const out = [];
  for (const obs of runner.obsModules) {
    obs.update?.(s);
    out.push(...obs.compute(s));
  }
  return out;
}

const ioFor = (runner, inputSize) => ({
  inputMetadata: [{ name: 'obs', isTensor: true, shape: [1, inputSize] }],
  outputMetadata: [{ name: 'actions', isTensor: true, shape: [1, 23] }],
  inputName: 'obs',
  outputName: 'actions',
  numObs: runner.numObs,
  numActions: runner.numActions,
  recipeError: runner.config.obs_config_error,
  controlErrors: runner.config.control_errors,
});

// The bundled env.yaml with its actions section rewritten by `edit`.
function actionsWith(edit) {
  const start = bundledEnv.indexOf('\nactions:\n');
  return bundledEnv.slice(0, start) + edit(bundledEnv.slice(start));
}

test('the bundled env.yaml yields the same 78 observations as the reference recipe', () => {
  const fromEnv = runnerFor(parseEnvPolicySettings(bundledEnv, joints));
  const fromReference = new PolicyRunner(reference);
  assert.equal(fromEnv.numObs, 78);
  for (const seed of [1, 2, 3]) {
    const s = state(seed);
    assert.deepEqual(observe(fromEnv, s), observe(fromReference, s));
  }
});

test('a gait clock term adds two inputs, so an 80-input policy with 23 motors fits', () => {
  const settings = parseEnvPolicySettings(envWith(appendTerm(GAIT_TERM), GAIT_COMMAND), joints);
  const runner = runnerFor(settings);
  assert.equal(runner.numObs, 80);
  assert.deepEqual(policyIOErrors(ioFor(runner, 80)), []);
  assert.match(policyIOErrors(ioFor(runner, 78))[0], /takes 78 .* builds 80/);
});

test('the gait clock follows the period schedule, outputs (sin, cos), and is zero when standing', () => {
  const runner = runnerFor(parseEnvPolicySettings(envWith(appendTerm(GAIT_TERM), GAIT_COMMAND), joints));
  const clock = runner.obsModules.at(-1);
  try {
    Object.assign(asimovCommandState, { vx: 0, vy: 0, wz: 0.05 });
    assert.deepEqual([...clock.compute()], [0, 0]);
    // 0.5 m/s is halfway between 0.2 and 0.8 m/s, so the period is 0.75 s.
    Object.assign(asimovCommandState, { vx: 0.5, vy: 0, wz: 0 });
    const [sin, cos] = clock.compute();
    const phase = 2 * Math.PI * (0.02 / 0.75);
    assert.ok(Math.abs(sin - Math.sin(phase)) < 1e-6 && Math.abs(cos - Math.cos(phase)) < 1e-6);
    Object.assign(asimovCommandState, { vx: 2.0 });
    clock.reset();
    assert.ok(Math.abs(clock.compute()[0] - Math.sin(2 * Math.PI * (0.02 / 0.7))) < 1e-6);
  } finally {
    Object.assign(asimovCommandState, { vx: 0, vy: 0, wz: 0 });
  }
});

test('a group history_length stacks every term, so a 5-step, 75-per-step policy fits 375 inputs', () => {
  // The shape of openhorizon-labs/asimov1-getup-safefall: no velocity command,
  // the last 5 steps of each term, oldest first.
  const yaml = envWith((group) => withoutTerm('command')(group).replace('    history_length: null', '    history_length: 5'));
  const runner = runnerFor(parseEnvPolicySettings(yaml, joints));
  assert.equal(runner.numObs, 375);
  assert.ok(runner.obsModules.every((obs) => obs instanceof ObsHistory && obs.length === 5));
  assert.deepEqual(policyIOErrors(ioFor(runner, 375)), []);
});

test('a stacked term starts filled with its first value and then keeps the newest last', () => {
  const runner = runnerFor(parseEnvPolicySettings(envWith((group) => group.replace('    history_length: null', '    history_length: 3')), joints));
  const angVel = runner.obsModules[0];
  runner.reset();
  const first = state(1);
  const second = state(2);
  const scaled = (s) => [...s.rootAngVel].map((v) => Math.fround(v * 0.25));
  assert.deepEqual([...angVel.compute(first)], [...scaled(first), ...scaled(first), ...scaled(first)]);
  assert.deepEqual([...angVel.compute(second)], [...scaled(first), ...scaled(first), ...scaled(second)]);
});

test('a per-term history_length stacks only that term', () => {
  const yaml = envWith((group) => group.replace(/(    actions:\n(?:      .*\n)*?)      history_length: 0/, '$1      history_length: 4'));
  const runner = runnerFor(parseEnvPolicySettings(yaml, joints));
  assert.equal(runner.numObs, 78 + 3 * 23);
});

test('terms the viewer cannot compute are named, and the policy is refused', () => {
  const yaml = envWith(appendTerm([
    '    foot_contact:',
    '      func: isaac_asimov.tasks.locomotion.mdp.observations:foot_contact',
    '      scale: null',
    '      history_length: 0',
  ].join('\n')));
  const settings = parseEnvPolicySettings(yaml, joints);
  assert.match(settings.obs_config_error, /foot_contact .*is not something the viewer computes/);
  const runner = new PolicyRunner({ ...reference, ...settings });
  assert.match(policyIOErrors(ioFor(runner, 80))[0], /foot_contact/);
});

test('a clipped or modified observation term is refused, since the viewer feeds it raw', () => {
  const clipped = parseEnvPolicySettings(envWith((group) => group.replace(
    '      clip: null\n      scale: 0.25',
    '      clip: !!python/tuple\n      - -1.0\n      - 1.0\n      scale: 0.25',
  )), joints);
  assert.equal(clipped.obs_config_error, "env.yaml's policy observations cannot be reproduced: base_ang_vel is clipped, which the viewer does not do");
  const modified = parseEnvPolicySettings(envWith((group) => group.replace(
    '      modifiers: null',
    '      modifiers:\n      - func: isaaclab.utils.modifiers:bias\n        params: {}',
  )), joints);
  assert.match(modified.obs_config_error, /base_ang_vel has modifiers, which the viewer does not apply$/);
});

test('another policy rate or action order is refused, alongside the size check', () => {
  assert.equal(parseEnvPolicySettings(bundledEnv, joints).control_errors, undefined);

  const faster = parseEnvPolicySettings(bundledEnv.replace('\ndecimation: 4\n', '\ndecimation: 2\n'), joints);
  assert.deepEqual(faster.control_errors, ['it ran every 0.01 s in training (sim.dt 0.005 x decimation 2), but the viewer runs it every 0.02 s']);
  const runner = runnerFor(faster);
  assert.deepEqual(policyIOErrors(ioFor(runner, 78)), faster.control_errors);
  assert.equal(policyIOErrors(ioFor(runner, 80)).length, 2);

  const swapped = actionsWith((actions) => actions.replace(
    '    - left_hip_pitch_joint\n    - left_hip_roll_joint',
    '    - left_hip_roll_joint\n    - left_hip_pitch_joint',
  ));
  assert.deepEqual(parseEnvPolicySettings(swapped, joints).control_errors, [
    'its actions.joint_pos.joint_names are in another order: action 1 drove left_hip_roll_joint in training, but drives left_hip_pitch_joint in the viewer',
  ]);
  const errorsFor = (from, to) => parseEnvPolicySettings(actionsWith((actions) => actions.replace(from, to)), joints).control_errors;
  assert.match(errorsFor('preserve_order: true', 'preserve_order: false')[0], /does not set preserve_order/);
  assert.match(errorsFor('use_default_offset: true', 'use_default_offset: false')[0], /not added to the default pose/);
  assert.match(errorsFor('    clip: null', '    clip:\n      .*: !!python/tuple\n      - -1.0\n      - 1.0')[0], /clipped in training/);
  // A pattern follows the robot asset's joint order, which the viewer cannot see, so it is not compared.
  const pattern = actionsWith((actions) => actions.replace(/    joint_names:\n(    - .*\n)+/, '    joint_names:\n    - .*\n'));
  assert.equal(parseEnvPolicySettings(pattern, joints).control_errors, undefined);
});

test('per-joint gain maps in a single actuator group are resolved joint by joint', () => {
  // One group for every joint, gains and limits given per joint (as asimov-flex does).
  const perJoint = (value) => joints.map((joint) => `          ${joint}: ${value(joint)}`);
  const group = [
    '    actuators:',
    '      all:',
    '        class_type: isaaclab.actuators.actuator_cfg:ImplicitActuator',
    '        joint_names_expr:',
    '        - .*',
    '        effort_limit:', ...perJoint(() => 20.0),
    '        stiffness:', ...perJoint((joint) => (joint.includes('knee') ? 150.0 : 40.0)),
    '        damping:', ...perJoint(() => 5.0),
  ];
  const lines = bundledEnv.split('\n');
  const start = lines.indexOf('    actuators:');
  let end = start + 1;
  while (lines[end].startsWith('      ')) end++;
  const yaml = [...lines.slice(0, start), ...group, ...lines.slice(end)].join('\n');
  const settings = parseEnvPolicySettings(yaml, joints);
  assert.equal(settings.stiffness[joints.indexOf('left_knee_joint')], 150);
  assert.equal(settings.stiffness[joints.indexOf('left_elbow_joint')], 40);
  assert.deepEqual(settings.torque_limit, joints.map(() => 20));
});
