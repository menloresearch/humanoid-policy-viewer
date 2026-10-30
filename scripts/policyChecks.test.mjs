import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPolicyDir, policyProblems, libraryNameWarning, readReferenceJointNames } from './policyChecks.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const bundled = join(appDir, 'public/examples/checkpoints/asimov/model_aug_18_1');
const jointNames = readReferenceJointNames(appDir);
const envYaml = readFileSync(join(bundled, 'env.yaml'), 'utf8');
const agentYaml = 'seed: 1\nalgorithm:\n  class_name: PPO\n';

test('a complete policy has no problems', () => {
  assert.deepEqual(policyProblems({ envYaml, agentYaml, jointNames }), { errors: [], warnings: [] });
});

test('a missing env.yaml is an error, a missing agent.yaml only a warning', () => {
  const noEnv = policyProblems({ envYaml: null, agentYaml, jointNames });
  assert.equal(noEnv.errors.length, 1);
  assert.match(noEnv.errors[0], /missing env\.yaml/);
  assert.deepEqual(noEnv.warnings, []);

  const noAgent = policyProblems({ envYaml, agentYaml: null, jointNames });
  assert.deepEqual(noAgent.errors, []);
  assert.equal(noAgent.warnings.length, 1);
  assert.match(noAgent.warnings[0], /missing agent\.yaml/);

  const neither = policyProblems({ envYaml: null, agentYaml: null, jointNames });
  assert.equal(neither.errors.length, 1);
  assert.equal(neither.warnings.length, 1);
});

test('an env.yaml without effort_limit is warned about as unclamped torque', () => {
  const stripped = envYaml.replace(/effort_limit:/g, 'effort_cap:');
  const { errors, warnings } = policyProblems({ envYaml: stripped, agentYaml, jointNames });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.replace(/,.*/, '')), ['env.yaml declares no numeric effort_limit for the actuators']);
});

// The viewer refuses these policies at load, so a run must not start: every cell would fail.
test('policy observations the viewer cannot compute are an error', () => {
  const footContact = '\n    foot_contact:\n      func: isaac_asimov.tasks.locomotion.mdp.observations:foot_contact\n      scale: null\n';
  const withFootContact = envYaml.replace('\n  critic:\n', `${footContact}  critic:\n`);
  const { errors, warnings } = policyProblems({ envYaml: withFootContact, agentYaml, jointNames });
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /foot_contact .*viewer will refuse the policy$/);
});

test('a policy trained at another rate is an error', () => {
  const faster = envYaml.replace('\ndecimation: 4\n', '\ndecimation: 2\n');
  assert.deepEqual(policyProblems({ envYaml: faster, agentYaml, jointNames }), {
    errors: ['env.yaml drove the robot differently than the viewer does: it ran every 0.01 s in training (sim.dt 0.005 x decimation 2), but the viewer runs it every 0.02 s, so the viewer will refuse the policy'],
    warnings: [],
  });
});

test('a clip on the actions is applied, so it is no problem; one the viewer cannot apply is an error', () => {
  const clipped = (clip) => envYaml.replace('\n    clip: null\n    joint_names:\n', `\n    clip:\n${clip}    joint_names:\n`);
  const ankles = '      .*_ankle_roll_joint: !!python/tuple\n      - -0.09\n      - 0.09\n';
  assert.deepEqual(policyProblems({ envYaml: clipped(ankles), agentYaml, jointNames }), { errors: [], warnings: [] });
  const { errors, warnings } = policyProblems({ envYaml: clipped(ankles.replace('ankle_roll', 'toe')), agentYaml, jointNames });
  assert.deepEqual(warnings, []);
  assert.deepEqual(errors, [
    "env.yaml drove the robot differently than the viewer does: its actions.joint_pos.clip cannot be applied: .*_toe_joint matches none of the policy's joints, so the viewer will refuse the policy",
  ]);
});

test('an env.yaml the viewer cannot read is an error; a junk agent.yaml a warning', () => {
  const { errors, warnings } = policyProblems({ envYaml: 'foo: 1\n', agentYaml: '\n', jointNames });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^env\.yaml is incomplete: .*, so the viewer will refuse the policy$/);
  assert.deepEqual(warnings, ['agent.yaml file is empty']);
  assert.match(policyProblems({ envYaml, agentYaml: 'a:\n\tb: 1\n', jointNames }).warnings[0], /tab character/);
  // env.yaml has no default pose for a joint, which the viewer needs even for a joint the policy does not drive.
  const noWaistPose = envYaml.replace('\n        waist_yaw_joint: 0.0\n', '\n');
  assert.match(policyProblems({ envYaml: noWaistPose, agentYaml, jointNames }).errors[0], /^env\.yaml is incomplete: Expected one .* for waist_yaw_joint/);
});

test('a leg-only policy is no problem; an observation the viewer cannot compute for it is an error', () => {
  // actions.joint_pos lists the 12 leg joints only, as Menlo/asimov1-locomotion-26-10-17-upper-body-blind.
  const legsOnly = envYaml.replace(/(    joint_names:\n(?:    - .*\n){12})(?:    - .*\n)+(    scale: 0\.25\n)/, '$1$2');
  assert.notEqual(legsOnly, envYaml);
  assert.deepEqual(policyProblems({ envYaml: legsOnly, agentYaml, jointNames }), { errors: [], warnings: [] });

  // As Menlo/asimov1-locomotion-26-10-05-upper-body: last actions padded by a function whose source is not known.
  const padded = legsOnly.replace(
    '      func: isaaclab.envs.mdp.observations:last_action\n      params: {}',
    '      func: isaac_asimov.tasks.locomotion.mdp.observations:padded_last_action\n      params:\n        target_size: 23');
  assert.deepEqual(policyProblems({ envYaml: padded, agentYaml, jointNames }).errors, [
    "env.yaml's policy observations cannot be reproduced: actions (isaac_asimov.tasks.locomotion.mdp.observations:padded_last_action) is not something the viewer computes, so the viewer will refuse the policy",
  ]);

  // As Menlo/asimov1-locomotion-26-10-26-lower-body-27dof: angular velocity read at the torso.
  const torso = legsOnly.replace('        quantity: base_ang_vel\n', '        quantity: base_ang_vel\n        asset_cfg:\n          name: robot\n          body_names:\n          - waist_yaw_link\n');
  assert.deepEqual(policyProblems({ envYaml: torso, agentYaml, jointNames }).errors, [
    "env.yaml's policy observations cannot be reproduced: base_ang_vel is read at waist_yaw_link in training, but the viewer reads it at the pelvis (pelvis_link), so the viewer will refuse the policy",
  ]);
});

test('checkPolicyDir finds files at the root or under params/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-check-'));
  try {
    writeFileSync(join(dir, 'agent.yaml'), agentYaml);
    mkdirSync(join(dir, 'params'));
    cpSync(join(bundled, 'env.yaml'), join(dir, 'params/env.yaml'));
    assert.deepEqual(checkPolicyDir(dir, jointNames), { errors: [], warnings: [] });
    rmSync(join(dir, 'agent.yaml'));
    assert.match(checkPolicyDir(dir, jointNames).warnings[0], /missing agent\.yaml/);
    rmSync(join(dir, 'params'), { recursive: true });
    assert.match(checkPolicyDir(dir, jointNames).errors[0], /missing env\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('libraryNameWarning accepts asimov in any case and warns otherwise', () => {
  assert.equal(libraryNameWarning('asimov'), null);
  assert.equal(libraryNameWarning('Asimov'), null);
  assert.match(libraryNameWarning('transformers'), /found library_name: transformers/);
  assert.match(libraryNameWarning(null), /found no library_name/);
});
