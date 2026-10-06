import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCheckpointDir, checkpointProblems, libraryNameWarning, readReferenceJointNames } from './checkpointChecks.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const bundled = join(appDir, 'public/examples/checkpoints/asimov/model_aug_18_1');
const jointNames = readReferenceJointNames(appDir);
const envYaml = readFileSync(join(bundled, 'env.yaml'), 'utf8');
const agentYaml = 'seed: 1\nalgorithm:\n  class_name: PPO\n';

test('a complete checkpoint has no problems', () => {
  assert.deepEqual(checkpointProblems({ envYaml, agentYaml, jointNames }), { errors: [], warnings: [] });
});

test('a missing env.yaml is an error, a missing agent.yaml only a warning', () => {
  const noEnv = checkpointProblems({ envYaml: null, agentYaml, jointNames });
  assert.equal(noEnv.errors.length, 1);
  assert.match(noEnv.errors[0], /missing env\.yaml/);
  assert.deepEqual(noEnv.warnings, []);

  const noAgent = checkpointProblems({ envYaml, agentYaml: null, jointNames });
  assert.deepEqual(noAgent.errors, []);
  assert.equal(noAgent.warnings.length, 1);
  assert.match(noAgent.warnings[0], /missing agent\.yaml/);

  const neither = checkpointProblems({ envYaml: null, agentYaml: null, jointNames });
  assert.equal(neither.errors.length, 1);
  assert.equal(neither.warnings.length, 1);
});

test('an env.yaml without effort_limit is warned about as unclamped torque', () => {
  const stripped = envYaml.replace(/effort_limit:/g, 'effort_cap:');
  const { errors, warnings } = checkpointProblems({ envYaml: stripped, agentYaml, jointNames });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.replace(/,.*/, '')), ['env.yaml declares no numeric effort_limit for the actuators']);
});

test('policy observations the viewer cannot compute are warned about', () => {
  const footContact = '\n    foot_contact:\n      func: isaac_asimov.tasks.locomotion.mdp.observations:foot_contact\n      scale: null\n';
  const withFootContact = envYaml.replace('\n  critic:\n', `${footContact}  critic:\n`);
  const { errors, warnings } = checkpointProblems({ envYaml: withFootContact, agentYaml, jointNames });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /foot_contact .*viewer will refuse the policy$/);
});

test('a policy trained at another rate is warned about', () => {
  const faster = envYaml.replace('\ndecimation: 4\n', '\ndecimation: 2\n');
  assert.deepEqual(checkpointProblems({ envYaml: faster, agentYaml, jointNames }), {
    errors: [],
    warnings: ['env.yaml drove the robot differently than the viewer does: it ran every 0.01 s in training (sim.dt 0.005 x decimation 2), but the viewer runs it every 0.02 s, so the viewer will refuse the policy'],
  });
});

test('an incomplete env.yaml and a junk agent.yaml are warnings', () => {
  const { errors, warnings } = checkpointProblems({ envYaml: 'foo: 1\n', agentYaml: '\n', jointNames });
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /^env\.yaml is incomplete/);
  assert.equal(warnings[1], 'agent.yaml file is empty');
  assert.match(checkpointProblems({ envYaml, agentYaml: 'a:\n\tb: 1\n', jointNames }).warnings[0], /tab character/);
});

test('checkCheckpointDir finds files at the root or under params/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpv-check-'));
  try {
    writeFileSync(join(dir, 'agent.yaml'), agentYaml);
    mkdirSync(join(dir, 'params'));
    cpSync(join(bundled, 'env.yaml'), join(dir, 'params/env.yaml'));
    assert.deepEqual(checkCheckpointDir(dir, jointNames), { errors: [], warnings: [] });
    rmSync(join(dir, 'agent.yaml'));
    assert.match(checkCheckpointDir(dir, jointNames).warnings[0], /missing agent\.yaml/);
    rmSync(join(dir, 'params'), { recursive: true });
    assert.match(checkCheckpointDir(dir, jointNames).errors[0], /missing env\.yaml/);
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
