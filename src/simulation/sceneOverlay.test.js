import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from 'mujoco-js';
import { applyTorqueLimits, buildActuatorBlock, motorJointNames, withActuatorOverlay } from './sceneOverlay.js';

const scenes = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/examples/scenes');
const SCENE = 'asimov-1/sim-model/xmls/asimov_1.xml';
const skip = existsSync(resolve(scenes, SCENE)) ? false : 'asimov-1 submodule is not checked out (run scripts/init-asimov-1.sh)';

function writeFile(mujoco, path, data) {
  const parts = path.split('/').slice(0, -1);
  let dir = '/working';
  for (const part of ['', ...parts]) {
    dir += part ? '/' + part : '';
    if (!mujoco.FS.analyzePath(dir).exists) mujoco.FS.mkdir(dir);
  }
  mujoco.FS.writeFile('/working/' + path, data);
}

// Mirrors downloadExampleScenesFolder(), reading from disk instead of fetch().
async function stageAsimov() {
  const mujoco = await loadMujoco();
  mujoco.FS.mkdir('/working');
  for (const file of JSON.parse(readFileSync(resolve(scenes, 'files.json'), 'utf8'))) {
    if (!file.startsWith('asimov-1/')) continue;
    const bytes = readFileSync(resolve(scenes, file));
    writeFile(mujoco, file, /\.(png|stl|skn)$/i.test(file) ? new Uint8Array(bytes) : bytes.toString('utf8'));
  }
  return mujoco;
}

function actuatorsByJoint(mujoco, model) {
  const byJoint = new Map();
  for (let i = 0; i < model.nu; i++) {
    assert.equal(model.actuator_trntype[i], mujoco.mjtTrn.mjTRN_JOINT.value);
    byJoint.set(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT.value, model.actuator_trnid[2 * i]), i);
  }
  return byJoint;
}

test('asimov_1.xml gets one unclamped motor per policy joint', { skip }, async () => {
  const mujoco = await stageAsimov();
  const patched = withActuatorOverlay(mujoco, SCENE);
  assert.equal(patched, 'asimov-1/sim-model/xmls/asimov_1.with-actuators.xml');

  const model = mujoco.MjModel.loadFromXML('/working/' + patched);
  const policyJoints = JSON.parse(readFileSync(resolve(scenes, '../checkpoints/asimov/reference_policy_config.json'), 'utf8')).policy_joint_names;
  assert.equal(model.nu, policyJoints.length);

  const byJoint = actuatorsByJoint(mujoco, model);
  for (const joint of policyJoints) assert.ok(byJoint.has(joint), `no actuator for ${joint}`);
  // Nothing from the robot model's own limits: the viewer clamps only when min < max.
  assert.ok(model.actuator_ctrlrange.every((value) => value === 0), 'motors should start unclamped');
});

test('applyTorqueLimits caps the policy actuators and null removes the cap again', { skip }, async () => {
  const mujoco = await stageAsimov();
  const model = mujoco.MjModel.loadFromXML('/working/' + withActuatorOverlay(mujoco, SCENE));
  const byJoint = actuatorsByJoint(mujoco, model);
  const joints = ['left_hip_pitch_joint', 'left_ankle_roll_joint'];
  const ctrlAdr = joints.map((joint) => byJoint.get(joint));

  applyTorqueLimits(model, ctrlAdr, [45, 17]);
  assert.deepEqual([model.actuator_ctrlrange[2 * ctrlAdr[0]], model.actuator_ctrlrange[2 * ctrlAdr[0] + 1]], [-45, 45]);
  assert.deepEqual([model.actuator_ctrlrange[2 * ctrlAdr[1]], model.actuator_ctrlrange[2 * ctrlAdr[1] + 1]], [-17, 17]);

  applyTorqueLimits(model, ctrlAdr, null);
  for (const a of ctrlAdr) assert.ok(!(model.actuator_ctrlrange[2 * a] < model.actuator_ctrlrange[2 * a + 1]), 'cap should be gone');
});

test('a scene that already has actuators is compiled as-is', async () => {
  const mujoco = await loadMujoco();
  mujoco.FS.mkdir('/working');
  const xml = '<mujoco><worldbody><body><joint name="j"/><geom size="1"/></body></worldbody><actuator><motor joint="j"/></actuator></mujoco>';
  writeFile(mujoco, 'has_actuator.xml', xml);
  assert.equal(withActuatorOverlay(mujoco, 'has_actuator.xml'), 'has_actuator.xml');
});

test('a scene with no actuators and no motor joints fails loudly', async () => {
  const mujoco = await loadMujoco();
  mujoco.FS.mkdir('/working');
  writeFile(mujoco, 'bare.xml', '<mujoco><worldbody/></mujoco>');
  assert.throws(() => withActuatorOverlay(mujoco, 'bare.xml'), /no class="motor" joints/);
});

test('motorJointNames ignores comments, default classes and non-motor joints', () => {
  const xml = `<mujoco>
    <default><default class="motor"><joint damping="0"/></default></default>
    <!-- <joint name="commented_out" class="motor"/> -->
    <worldbody><body>
      <joint name="a_joint" type="hinge" class="motor" range="-1 1"/>
      <joint name="b_joint" class="passive_upper"/>
      <joint class="motor" axis="0 0 1" name="c_joint"/>
    </body></worldbody></mujoco>`;
  assert.deepEqual(motorJointNames(xml), ['a_joint', 'c_joint']);
  assert.match(buildActuatorBlock(['a_joint']), /<motor name="a" joint="a_joint"\/>/);
});
