import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readRows } from './suiteDir.mjs';
import { applySuiteEdit, checkSuiteText, patchSuiteYaml, suiteFormFields } from './suiteEdit.mjs';
import { initSuite } from './suiteInit.mjs';

function starter() {
  const dir = join(mkdtempSync(join(tmpdir(), 'hpv-suite-edit-')), 'example');
  initSuite(dir, { log: () => {} });
  return { text: readFileSync(join(dir, 'suite.yaml'), 'utf8'), rows: readRows(dir).rows };
}

test('the form shows the starter settings, and parser defaults for keys left out', () => {
  const { text } = starter();
  const fields = suiteFormFields(parseYaml(text));
  assert.equal(fields.version, 1);
  assert.equal(fields.repeats, 5);
  assert.equal(fields.action_delay, 'env_range');
  assert.equal(fields.initial_joint_noise_rad, 0.02);
  assert.deepEqual(fields.tests, [{ all: true }]);
  assert.deepEqual(fields.tasks.map((t) => t.id), ['survival_rate', 'survival_time']);
  const bare = suiteFormFields({ suite: 'x', version: 1 });
  assert.deepEqual([bare.repeats, bare.seed, bare.timeout_s, bare.action_delay, bare.initial_joint_noise_rad], [1, 0, 600, null, 0]);
  assert.equal(suiteFormFields('not a mapping'), null);
});

test('form edits are patched in, keeping comments and everything not edited', () => {
  const { text } = starter();
  const fields = suiteFormFields(parseYaml(text));
  const next = patchSuiteYaml(text, {
    ...fields,
    title: 'Example: walking',
    version: 2,
    repeats: 3,
    action_delay: null,
    tests: [{ all: true }, { config: 'locomotion', repeats: '' }, { id: 'locomotion/forward_walk', repeats: 8 }],
    tasks: [...fields.tasks, { id: 'walk_rate', metric: 'survival_rate@1', scope: { config: 'locomotion', tag: '' } }],
  });
  const raw = parseYaml(next);
  assert.equal(raw.title, 'Example: walking');
  assert.equal(raw.version, 2);
  assert.equal(raw.defaults.repeats, 3);
  assert.deepEqual(raw.defaults.randomize, { initial_joint_noise_rad: 0.02 });
  assert.deepEqual(raw.tests, [{ all: true }, { config: 'locomotion' }, { id: 'locomotion/forward_walk', repeats: 8 }]);
  assert.deepEqual(raw.tasks[2], { id: 'walk_rate', metric: 'survival_rate@1', scope: { config: 'locomotion' } });
  assert.deepEqual(raw.harness, parseYaml(text).harness);
  assert.match(next, /# bump whenever a change can move a score/);
  assert.match(next, /# What runs and how it is scored/);
  assert.match(next, /- \{ id: locomotion\/forward_walk, repeats: 8 \}/);
  // Nothing changed: the file comes back as it was.
  assert.equal(patchSuiteYaml(text, fields), text);
});

test('an edit npm run benchmark would refuse is not applied; dataset mismatches are warnings', () => {
  const { text, rows } = starter();
  const fields = suiteFormFields(parseYaml(text));
  assert.throws(() => applySuiteEdit(text, { fields: { ...fields, repeats: 0 } }, rows), /defaults\.repeats must be an integer >= 1/);
  assert.throws(() => applySuiteEdit(text, { text: 'suite: [unclosed' }, rows), /not valid YAML/);
  assert.throws(
    () => applySuiteEdit(text, { fields: { ...fields, tasks: [{ id: 'x', metric: 'survival_rate' }] } }, rows),
    (error) => error.problems.some((p) => /name a version, e.g. "survival_rate@1"/.test(p)),
  );
  const missing = applySuiteEdit(text, { fields: { ...fields, tests: [{ config: 'stairs' }] } }, rows);
  assert.deepEqual(missing.warnings, ['tests[0] (config stairs) matches no test in the dataset']);
  const identical = applySuiteEdit(text, { fields: { ...fields, action_delay: 'midpoint', initial_joint_noise_rad: 0 } }, rows);
  assert.ok(identical.warnings.every((w) => /nothing is randomised/.test(w)) && identical.warnings.length === rows.length);
  // A new benchmark has no tests yet; its { all: true } is not a problem.
  assert.deepEqual(checkSuiteText(text, []).warnings, []);
  assert.deepEqual(applySuiteEdit(text, { text: text.replace('version: 1 ', 'version: 4 ') }, rows).warnings, []);
});
