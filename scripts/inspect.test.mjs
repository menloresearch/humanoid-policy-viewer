// The offline inspection command (scripts/inspect.mjs) that publishing tools read
// instead of importing HPV's internals.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadBenchmarkDir, scoredContentHash } from './benchmarkDir.mjs';
import { taskDescriptors } from '../src/benchmark/settings.js';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';
import { INSPECTION_SCHEMA, POLICY_INSPECTION_SCHEMA, inspectBenchmark } from './inspect.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'hpv-inspect-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const COMMIT = 'f'.repeat(40);
const START = { pos: [0, 0, 0.16], joint_pos: { '.*_knee_joint': 0.6 } };

let copies = 0;
/** A copy of benchmarks/default with a getup test that has a start state, a license file and a tag. */
function benchmarkCopy(editYaml = (yaml) => yaml) {
  const dir = join(scratch, `bench-${copies++}`);
  cpSync(join(appDir, 'benchmarks/default'), dir, { recursive: true });
  const yaml = readFileSync(join(dir, 'benchmark.yaml'), 'utf8').replace(/^(version: .*)$/m, '$1\nlicense: LICENSE\ntags: [locomotion]');
  writeFileSync(join(dir, 'benchmark.yaml'), editYaml(yaml));
  writeFileSync(join(dir, 'LICENSE'), 'Our own terms.\n');
  const [first] = readFileSync(join(dir, 'data/locomotion/test.jsonl'), 'utf8').split('\n');
  const getup = { ...JSON.parse(first), id: 'getup/from_crouch', config: 'getup', name: 'from crouch', start: START };
  mkdirSync(join(dir, 'data/getup'));
  writeFileSync(join(dir, 'data/getup/test.jsonl'), `${JSON.stringify(getup)}\n`);
  mkdirSync(join(dir, '.baseline'));
  writeFileSync(join(dir, '.baseline/NOTES.md'), 'not published\n');
  writeFileSync(join(dir, 'notes.txt'), 'not published\n');
  return dir;
}

function run(...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')));
  // Nothing may reach the Hub: an endpoint that cannot answer.
  return spawnSync(process.execPath, [join(appDir, 'scripts/inspect.mjs'), ...args], { cwd: scratch, encoding: 'utf8', env: { ...env, HF_ENDPOINT: 'http://127.0.0.1:9' } });
}

test('inspect benchmark prints the folder as HPV reads it, with the exact files to publish', () => {
  const dir = benchmarkCopy();
  const out = run('benchmark', dir, COMMIT);
  assert.equal(out.status, 0, out.stderr);
  const inspection = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(inspection), [
    'schema', 'raw', 'rows', 'tasks', 'errors', 'warnings', 'problems', 'cells', 'tests', 'scored_hash', 'files',
    'provenance', 'public', 'card', 'benchmark_yaml', 'publish_files',
  ]);
  const loaded = loadBenchmarkDir(dir);
  assert.equal(inspection.schema, INSPECTION_SCHEMA);
  assert.deepEqual(inspection.raw, loaded.rawBenchmark);
  assert.deepEqual(inspection.rows, loaded.rows);
  assert.deepEqual(inspection.rows.find((row) => row.id === 'getup/from_crouch').start, START);
  assert.deepEqual(inspection.tasks, taskDescriptors(loaded.benchmark));
  assert.deepEqual([inspection.errors, inspection.problems], [[], []]);
  assert.equal(inspection.tests.length, loaded.rows.length);
  assert.equal(inspection.cells.length, loaded.rows.length * 5);
  assert.equal(inspection.scored_hash, scoredContentHash(loaded.rawBenchmark, loaded.rows));
  assert.equal(inspection.provenance.hpv.protocol, BENCHMARK_PROTOCOL);
  assert.deepEqual(inspection.files, ['LICENSE', 'README.md', 'benchmark.yaml', 'data/getup/test.jsonl', 'data/locomotion/test.jsonl', 'data/push_standing/test.jsonl']);

  // The card: the tags benchmark.yaml lists (no HPV tag), a license file linked.
  assert.deepEqual(inspection.card.tags, ['locomotion']);
  assert.deepEqual([inspection.card.license, inspection.card.license_link], ['other', 'LICENSE']);
  assert.deepEqual(inspection.card.configs.map((c) => c.config_name), ['all', 'getup', 'locomotion', 'push_standing']);

  // What to upload: README.md is left to the publisher (it builds the card); benchmark.yaml records the commit
  // with its comments kept; a start goes up as JSON text, the type the card declares; the rest byte for byte.
  const files = inspection.publish_files;
  assert.deepEqual(Object.keys(files).sort(), inspection.files.filter((path) => path !== 'README.md'));
  const yaml = readFileSync(join(dir, 'benchmark.yaml'), 'utf8');
  assert.equal(files['benchmark.yaml'], yaml.replace(/tested_commit: \S+/, `tested_commit: ${COMMIT}`));
  assert.equal(inspection.benchmark_yaml, files['benchmark.yaml']);
  assert.equal(parseYaml(files['benchmark.yaml']).harness.tested_commit, COMMIT);
  assert.match(files['benchmark.yaml'], /# bump whenever a change can move a score/);
  const [getup, end] = files['data/getup/test.jsonl'].split('\n');
  assert.equal(end, '');
  assert.equal(JSON.parse(getup).start, JSON.stringify(START));
  assert.equal(files['data/locomotion/test.jsonl'], readFileSync(join(dir, 'data/locomotion/test.jsonl'), 'utf8'));
  assert.equal(files.LICENSE, 'Our own terms.\n');

  // Nothing in the folder changed.
  assert.equal(readFileSync(join(dir, 'benchmark.yaml'), 'utf8'), yaml);
});

test('without a commit benchmark.yaml is published as it is, and benchmark_yaml is null', () => {
  const dir = benchmarkCopy();
  const inspection = inspectBenchmark(dir);
  assert.equal(inspection.benchmark_yaml, null);
  assert.equal(inspection.publish_files['benchmark.yaml'], readFileSync(join(dir, 'benchmark.yaml'), 'utf8'));
  assert.throws(() => inspectBenchmark(dir, { commit: 'not a commit' }), /"not a commit" is not a commit hash/);
});

test('an unusable license is an error, not a crash; an unloadable folder fails on stderr', () => {
  const inspection = inspectBenchmark(benchmarkCopy((yaml) => yaml.replace(/^license: .*$/m, 'license: Not A License')));
  assert.match(inspection.errors.join('\n'), /license "Not A License" is neither a file in .* nor a Hugging Face license id/);
  assert.equal(inspection.card.license, undefined);
  assert.ok(inspection.cells.length > 0, 'the tests still plan');

  const broken = run('benchmark', join(scratch, 'missing'));
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /has no benchmark\.yaml/);
  assert.match(run('nonsense').stderr, /Usage:/);
});

test('inspect policy names the .onnx the viewer runs, its hashes and its problems', () => {
  const policy = join(scratch, 'policy');
  cpSync(join(appDir, 'public/examples/checkpoints/asimov/model_aug_18_1'), policy, { recursive: true });
  const out = run('policy', policy);
  assert.equal(out.status, 0, out.stderr);
  const info = JSON.parse(out.stdout);
  assert.equal(info.schema, POLICY_INSPECTION_SCHEMA);
  assert.equal(info.policyDir, policy);
  assert.equal(info.primary, 'policy_isaaclab_new.onnx');
  assert.match(info.hashes.onnx, /^[0-9a-f]{64}$/);
  assert.deepEqual(info.errors, []);
  const empty = join(scratch, 'empty');
  mkdirSync(empty);
  assert.match(run('policy', empty).stderr, /contains no \.onnx file/);
});
