// Leg-only policies: env.yaml's actions.joint_pos drives only some of the
// robot's joints (as Menlo/asimov1-locomotion-26-10-05-upper-body and
// -26-10-17-upper-body-blind drive the 12 leg joints). How the action joints
// are read (Isaac Lab's resolve_matching_names), what is checked for them, what
// the policy observes, and how the joints it does not drive are held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { parseEnvPolicySettings } from './envPolicyConfig.js';
import { MuJoCoDemo } from './main.js';
import { PolicyRunner } from './policyRunner.js';
import { policyIOErrors } from './policyIO.js';
import { applyTorqueLimits } from './sceneOverlay.js';
import { toFloatArray } from './utils/math.js';

const checkpoints = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/examples/checkpoints/asimov');
const reference = JSON.parse(readFileSync(resolve(checkpoints, 'reference_policy_config.json'), 'utf8'));
const bundledEnv = readFileSync(resolve(checkpoints, 'model_aug_18_1/env.yaml'), 'utf8');
const joints = reference.policy_joint_names;
// The viewer's first 12 joints, in its order.
const LEGS = joints.slice(0, 12);
const UPPER = joints.slice(12);
const UNCLIPPED = [-Infinity, Infinity];
const ANKLE_ROLL_CLIP = ['    clip:', '      .*_ankle_roll_joint: !!python/tuple', '      - -0.09', '      - 0.09'];

function replaced(text, from, to) {
  const out = text.replace(from, to);
  assert.notEqual(out, text, `${from} not found`);
  return out;
}

// The bundled env.yaml (23 joints, scale 0.25) with its actions.joint_pos
// listing `actionJoints`, scaled per joint as the leg-only policies are.
function legOnlyEnv({ actionJoints = LEGS, scale = (joint) => (joint.endsWith('_ankle_roll_joint') ? 0.08 : 0.25), clip = ['    clip: null'], extra = [] } = {}) {
  const block = [
    ...clip,
    '    joint_names:',
    ...actionJoints.map((joint) => `    - ${joint}`),
    '    scale:',
    ...actionJoints.filter((joint) => !joint.includes('*') && scale(joint) !== undefined).map((joint) => `      ${joint}: ${scale(joint)}`),
    ...extra,
  ].join('\n');
  return replaced(bundledEnv, /    clip: null\n    joint_names:\n(    - .*\n)+    scale: 0\.25/, block);
}

// Only the leg joints in the policy's joint observations (as -26-10-17-upper-body-blind).
function blind(yaml) {
  const start = yaml.indexOf('\n  policy:\n', yaml.indexOf('\nobservations:\n'));
  const end = yaml.indexOf('\n  critic:\n', start);
  const group = yaml.slice(start, end).split('\n')
    .filter((line) => !UPPER.some((joint) => line === `          - ${joint}`)).join('\n');
  return yaml.slice(0, start) + group + yaml.slice(end);
}

const settingsOf = (yaml) => parseEnvPolicySettings(yaml, joints);

test('the action joints are actions.joint_pos.joint_names; a policy driving every joint is read as before', () => {
  const legs = settingsOf(legOnlyEnv());
  assert.deepEqual(legs.action_joint_indices, LEGS.map((_, i) => i));
  // Scales are needed, and given, for the leg joints only.
  assert.deepEqual(legs.action_scale, LEGS.map((joint) => (joint.endsWith('_ankle_roll_joint') ? 0.08 : 0.25)));
  assert.equal(legs.control_errors, undefined);
  assert.equal(legs.obs_config_error, undefined);

  // Every joint listed, or a pattern matching every joint: no action joints are
  // recorded and the settings are exactly what they were.
  const all = settingsOf(bundledEnv);
  assert.equal('action_joint_indices' in all, false);
  assert.equal(all.action_scale.length, 23);
  const pattern = settingsOf(replaced(bundledEnv, /    joint_names:\n(    - .*\n)+/, '    joint_names:\n    - .*\n'));
  assert.deepEqual(pattern, all);
});

test('action-joint patterns are full matches, resolved as Isaac Lab resolves them', () => {
  // A pattern drives every joint it fully matches: `.*_knee_joint`, not `knee`.
  const patterns = settingsOf(legOnlyEnv({ actionJoints: ['.*_hip_.*', '.*_knee_joint', '.*_ankle_.*'], extra: ['      .*: 0.25'] }));
  assert.deepEqual(patterns.action_joint_indices, LEGS.map((_, i) => i));
  assert.deepEqual(settingsOf(legOnlyEnv({ actionJoints: [...LEGS.slice(0, 3), 'knee'], scale: () => 0.25 })).control_errors, [
    "its actions.joint_pos.joint_names drive knee, which matches none of the viewer's robot joints",
  ]);
  // Isaac Lab orders the actions pattern by pattern (preserve_order), so these
  // drove the hips first, then the knees: not the viewer's leg order.
  assert.deepEqual(patterns.control_errors, [
    'its actions.joint_pos.joint_names are in another order: action 4 drove right_hip_pitch_joint in training, but drives left_knee_joint in the viewer',
  ]);
  // Patterns in the viewer's order are fine.
  const left = settingsOf(legOnlyEnv({ actionJoints: ['left_.*_joint'], extra: ['      .*: 0.25'] }));
  assert.equal(left.control_errors, undefined);
  assert.deepEqual(left.action_joint_indices, [0, 1, 2, 3, 4, 5, 18, 19, 20, 21, 22]);

  const errorsOf = (options) => settingsOf(legOnlyEnv(options)).control_errors;
  // A joint the robot does not have, and a joint matched twice, are refused (Isaac Lab raises on both).
  assert.deepEqual(errorsOf({ actionJoints: [...LEGS, 'neck_yaw_joint'], scale: () => 0.25 }), [
    "its actions.joint_pos.joint_names drive neck_yaw_joint, which matches none of the viewer's robot joints",
  ]);
  assert.deepEqual(errorsOf({ actionJoints: ['.*_hip_.*', 'left_hip_pitch_joint'], extra: ['      .*: 0.25'] }), [
    'its actions.joint_pos.joint_names match left_hip_pitch_joint with both .*_hip_.* and left_hip_pitch_joint',
  ]);
  // Names in another order, or without preserve_order, are refused as for every joint.
  const swapped = [LEGS[1], LEGS[0], ...LEGS.slice(2)];
  assert.deepEqual(errorsOf({ actionJoints: swapped }), [
    'its actions.joint_pos.joint_names are in another order: action 1 drove left_hip_roll_joint in training, but drives left_hip_pitch_joint in the viewer',
  ]);
  const unordered = replaced(legOnlyEnv(), '    preserve_order: true\n    use_default_offset', '    preserve_order: false\n    use_default_offset');
  assert.match(settingsOf(unordered).control_errors[0], /does not set preserve_order/);
});

test('scale, clip and delay are read for the action joints only; pose, gains and torque limits for every joint', () => {
  const settings = settingsOf(legOnlyEnv({ clip: ANKLE_ROLL_CLIP }));
  // The clip resolves against the action joints, one [min, max] per action.
  assert.deepEqual(settings.target_clip, LEGS.map((joint) => (joint.endsWith('_ankle_roll_joint') ? [-0.09, 0.09] : UNCLIPPED)));
  // ... so a clip on a joint the policy does not drive matches none of its joints.
  const waistClip = settingsOf(legOnlyEnv({ clip: ['    clip:', '      waist_yaw_joint: [-0.1, 0.1]'] }));
  assert.deepEqual(waistClip.control_errors, ["its actions.joint_pos.clip cannot be applied: waist_yaw_joint matches none of the policy's joints"]);

  // A joint the policy does not drive needs no scale (legOnlyEnv gives none); one it drives does.
  assert.throws(() => settingsOf(legOnlyEnv({ actionJoints: [...LEGS, 'waist_yaw_joint'], scale: (joint) => (joint === 'waist_yaw_joint' ? undefined : 0.25) })),
    /Expected one action scale setting for waist_yaw_joint in env.yaml; found 0/);

  // Every joint keeps its default pose, gains and torque limit: the viewer holds the others with them.
  const all = settingsOf(bundledEnv);
  for (const key of ['default_joint_pos', 'stiffness', 'damping', 'torque_limit', 'init_state']) {
    assert.deepEqual(settings[key], all[key], key);
  }
  // The delay is one for the whole target; it is read from the action joints' actuators.
  const env = legOnlyEnv();
  const armDelay = replaced(env, /(\n      shoulder_pitch:\n(?:        .*\n)*?        max_delay: )\d+/, '$19');
  assert.equal(settingsOf(armDelay).delay_max_lag, all.delay_max_lag);
  const legDelay = replaced(env, /(\n      knee:\n(?:        .*\n)*?        max_delay: )\d+/, '$19');
  assert.throws(() => settingsOf(legDelay), /different min_delay\/max_delay ranges/);
});

test('observations are sized to the policy: last_action is one per action joint', () => {
  // As -26-10-05-upper-body, but with Isaac Lab's last_action: every joint observed, 12 last actions.
  const full = settingsOf(legOnlyEnv());
  const runner = new PolicyRunner({ ...reference, ...full });
  assert.equal(runner.numJoints, 23);
  assert.equal(runner.numActions, 12);
  assert.deepEqual(runner.obsModules.map((obs) => obs.size), [3, 3, 3, 9, 8, 6, 9, 8, 6, 12]);
  assert.equal(runner.numObs, 9 + 23 + 23 + 12);

  // As -26-10-17-upper-body-blind: the legs only, 45 inputs.
  const legs = settingsOf(blind(legOnlyEnv({ clip: ANKLE_ROLL_CLIP })));
  assert.equal(legs.obs_config_error, undefined);
  const blindRunner = new PolicyRunner({ ...reference, ...legs });
  assert.deepEqual(blindRunner.obsModules.map((obs) => obs.size), [3, 3, 3, 4, 4, 4, 4, 4, 4, 12]);
  assert.equal(blindRunner.numObs, 45);
  // The joint observations read the leg joints, wherever they are in the robot.
  const slots = legs.obs_config.policy.filter((entry) => entry.indices);
  assert.deepEqual([...new Set(slots.flatMap((entry) => entry.indices))].sort((a, b) => a - b), LEGS.map((_, i) => i));
  // The CSV log names the actions after the joints they drive.
  assert.deepEqual(blindRunner._buildActionLabels(), LEGS.map((joint) => `action_${joint}`));
  assert.equal(blindRunner._buildCsvHeader().length, 1 + 45 + 12);
});

test('padded_last_action, whose source is not known, is refused', () => {
  const padded = replaced(legOnlyEnv(),
    '      func: isaaclab.envs.mdp.observations:last_action\n      params: {}',
    '      func: isaac_asimov.tasks.locomotion.mdp.observations:padded_last_action\n      params:\n        target_size: 23');
  assert.equal(settingsOf(padded).obs_config_error,
    "env.yaml's policy observations cannot be reproduced: actions (isaac_asimov.tasks.locomotion.mdp.observations:padded_last_action) is not something the viewer computes");
});

// An ONNX session that outputs `actions` whatever it is fed, as in actionClip.test.js.
function fakeSession(actions, outputs = actions.length) {
  return {
    inputNames: ['obs'],
    outputNames: ['actions'],
    inputMetadata: [{ name: 'obs', isTensor: true, type: 'float32', shape: [1, 45] }],
    outputMetadata: [{ name: 'actions', isTensor: true, type: 'float32', shape: [1, outputs] }],
    run: async () => ({ actions: new ort.Tensor('float32', Float32Array.from(actions), [1, actions.length]) }),
  };
}

const BLIND = settingsOf(blind(legOnlyEnv({ clip: ANKLE_ROLL_CLIP })));
const ACTIONS = LEGS.map((joint, i) => ({ left_ankle_roll_joint: 1.5, right_ankle_roll_joint: -1.5 })[joint] ?? 1.7 * Math.sin(1.3 * i + 0.4));

function blindRunner(actions = ACTIONS) {
  const config = { ...reference, ...BLIND };
  const runner = new PolicyRunner(config, { policyJointNames: joints, actionScale: config.action_scale, defaultJointPos: config.default_joint_pos });
  runner.module.useSession(fakeSession(actions));
  runner.reset();
  return runner;
}

test('the ONNX output must have one action per action joint', () => {
  const io = (outputs) => policyIOErrors({
    inputMetadata: [{ name: 'obs', isTensor: true, shape: [1, 45] }],
    outputMetadata: [{ name: 'actions', isTensor: true, shape: [1, outputs] }],
    inputName: 'obs', outputName: 'actions', numObs: 45, numActions: 12, actionsFromEnv: true,
  });
  assert.deepEqual(io(12), []);
  assert.deepEqual(io(23), ['it outputs 23 actions, but its env.yaml actions.joint_pos drives 12 joints']);

});

test('PolicyRunner.init refuses a policy whose output does not fit its action joints', async () => {
  // init() as in the viewer, with `session` in place of the loaded ONNX file.
  const initWith = async (session) => {
    const runner = new PolicyRunner({ ...reference, ...BLIND });
    runner.module.init = async function () { this.useSession(session); };
    await runner.init();
    return runner;
  };
  await assert.rejects(initWith(fakeSession(new Array(23).fill(0))),
    { message: 'This policy does not match the viewer: it outputs 23 actions, but its env.yaml actions.joint_pos drives 12 joints. See docs/huggingface.md#supported-policies.' });
  assert.equal((await initWith(fakeSession(ACTIONS))).numActions, 12);
  // A policy for every joint is checked against the robot's motors, as before.
  const all = new PolicyRunner({ ...reference, ...settingsOf(bundledEnv) });
  all.module.init = async function () { this.useSession({ ...fakeSession(ACTIONS), inputMetadata: [{ name: 'obs', isTensor: true, type: 'float32', shape: [1, 78] }] }); };
  await assert.rejects(all.init(), /it outputs 12 actions, but the robot has 23 motors/);
});

const state = { rootAngVel: [0.1, -0.2, 0.3], rootQuat: [1, 0, 0, 0], jointPos: new Float32Array(23), jointVel: new Float32Array(23) };

test('the target holds every joint the policy does not drive at its default pose', async () => {
  const runner = blindRunner();
  const target = await runner.step(state);
  assert.equal(target.length, 23);
  assert.deepEqual(Array.from(runner.lastActions), ACTIONS.map(Math.fround));
  joints.forEach((joint, j) => {
    const i = LEGS.indexOf(joint);
    if (i < 0) {
      assert.equal(target[j], Math.fround(BLIND.default_joint_pos[j]), joint);
    } else {
      const unclipped = Math.fround(runner.defaultJointPos[j] + runner.actionScale[i] * runner.lastActions[i]);
      assert.equal(target[j], joint.endsWith('_ankle_roll_joint') ? Math.fround(Math.sign(unclipped) * 0.09) : unclipped, joint);
    }
  });
  // The observation of the last action is the 12 raw actions.
  const last = runner.obsModules.at(-1).compute(state);
  assert.deepEqual(Array.from(last), ACTIONS.map(Math.fround));
  // A grouped benchmark run's other robots do the same.
  assert.deepEqual(await runner.twin().step(state), await blindRunner().step(state));
});

// The viewer's PD loop (MuJoCoDemo._stepRobot) on a stand-in for MuJoCo: one
// policy tick of `robot` with the joints at `jointPos`, returning the motor
// torques it set. Gains and torque limits are set up as mujocoUtils.reloadPolicy
// sets them from the policy's config.
async function torquesFor(config, runner, jointPos) {
  const demo = Object.create(MuJoCoDemo.prototype);
  const n = joints.length;
  const model = { nv: 6 + n, actuator_ctrlrange: new Float64Array(2 * n) };
  Object.assign(demo, {
    model, decimation: 1, timestep: 0.02, numActions: n, control_type: 'joint_position', extraRobots: [],
    qpos_adr_policy: joints.map((_, i) => 7 + i), qvel_adr_policy: joints.map((_, i) => 6 + i), ctrl_adr_policy: joints.map((_, i) => i),
    kpPolicy: toFloatArray(config.stiffness, n, 0), kdPolicy: toFloatArray(config.damping, n, 0), kdFfPolicy: null,
    actionLpfAlpha: 1, actionDelayMinLag: 0, actionDelayMaxLag: 0, params: {},
  });
  applyTorqueLimits(model, demo.ctrl_adr_policy, config.torque_limit);
  const qpos = new Float64Array(7 + n);
  qpos.set([0, 0, 0.64, 1, 0, 0, 0]);
  qpos.set(jointPos, 7);
  const ctrl = new Float64Array(n);
  const robot = {
    simulation: { qpos, qvel: new Float64Array(6 + n), ctrl, qfrc_applied: new Float64Array(6 + n), step() {} },
    policyRunner: runner, actionDelayLag: 0, actionDelayBuffer: [], settleTicksLeft: 0, damp: false,
    _activePushes: [], idealPath: { update() {} },
  };
  assert.equal(await demo._stepRobot(robot), true);
  return ctrl;
}

test('the viewer drives a held joint to its default pose with its env.yaml gains and torque limit', async () => {
  const config = { ...reference, ...BLIND };
  // Every joint 0.1 rad off its default pose.
  const offset = BLIND.default_joint_pos.map((value) => value + 0.1);
  const torques = await torquesFor(config, blindRunner(), offset);
  UPPER.forEach((joint) => {
    const j = joints.indexOf(joint);
    const limit = BLIND.torque_limit[j];
    const expected = Math.max(-limit, Math.min(limit, BLIND.stiffness[j] * Math.fround(-0.1)));
    assert.ok(Math.abs(torques[j] - expected) < 1e-4, `${joint}: ${torques[j]} vs ${expected}`);
    assert.ok(torques[j] < 0, `${joint} is pulled back towards its default pose`);
  });
  // Far off, the torque stops at the joint's effort_limit.
  const far = await torquesFor(config, blindRunner(), BLIND.default_joint_pos.map((value) => value + 3));
  UPPER.forEach((joint) => {
    const j = joints.indexOf(joint);
    assert.equal(far[j], -BLIND.torque_limit[j], joint);
  });
});
