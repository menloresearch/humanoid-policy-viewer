import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RESULT_SCHEMA, planCells, cellResult } from '../src/benchmark/run.js';
import { parse as parseYaml } from 'yaml';
import { parseBenchmark } from '../src/benchmark/settings.js';
import { viewerServer } from './viewerServer.mjs';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

// The plugin's middlewares behind a plain HTTP server, dispatched the way Vite's
// connect stack does (a path given to use() is a prefix).
async function serve(options) {
  const temp = mkdtempSync(join(tmpdir(), 'hpv-viewer-server-'));
  tempDirs.push(temp);
  const benchmarksDir = join(temp, 'benchmarks');
  const plugin = viewerServer({
    benchmarksDir,
    openBenchmark: join(appDir, 'benchmarks', 'default'),
    resultsDir: join(temp, 'results'),
    policyLibraryDir: temp,
    policyRoots: [],
    ...options,
  });
  const stack = [];
  plugin.configureServer({ middlewares: { use: (path, fn) => stack.push(fn ? { path, fn } : { path: '', fn: path }) } });
  const server = createServer((req, res) => {
    const layers = stack.filter(({ path }) => req.url.startsWith(path));
    const next = () => {
      const layer = layers.shift();
      if (layer) layer.fn(req, res, next);
      else { res.statusCode = 404; res.end(); }
    };
    next();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { request, benchmarksDir, resultsDir: join(temp, 'results'), close: () => new Promise((done) => server.close(done)) };
}

test('lists the open benchmark first', async () => {
  const viewer = await serve({});
  try {
    const { status, json } = await viewer.request('GET', '/api/benchmarks');
    assert.equal(status, 200);
    assert.equal(json.benchmarks[0].dir, join(appDir, 'benchmarks', 'default'));
    assert.equal(json.benchmarks[0].session, true);
  } finally {
    await viewer.close();
  }
});

test('an editable server creates benchmarks', async () => {
  const viewer = await serve({ editable: true });
  try {
    const { status } = await viewer.request('POST', '/api/benchmarks', { name: 'fresh' });
    assert.equal(status, 201);
    assert.ok(existsSync(join(viewer.benchmarksDir, 'fresh', 'benchmark.yaml')));
  } finally {
    await viewer.close();
  }
});

test('editable: false refuses every write and still serves reads', async () => {
  const viewer = await serve({ editable: false });
  try {
    for (const [method, path] of [['POST', '/api/benchmarks'], ['PUT', '/api/benchmark'], ['DELETE', '/api/tests'], ['POST', '/api/save-log'], ['POST', '/api/results']]) {
      const { status, json } = await viewer.request(method, path, { name: 'fresh' });
      assert.equal(status, 405, `${method} ${path}`);
      assert.match(json.error, /read-only/);
    }
    assert.equal(existsSync(join(viewer.benchmarksDir, 'fresh')), false);
    assert.equal(existsSync(viewer.resultsDir), false);
    assert.equal((await viewer.request('GET', '/api/benchmarks')).status, 200);
    assert.equal((await viewer.request('GET', '/api/policies')).status, 200);
  } finally {
    await viewer.close();
  }
});

const smokeDir = join(appDir, 'test', 'fixtures', 'smoke-benchmark');

/** A copy of the smoke benchmark; `hub` makes it look like a download from Hugging Face (hfDataset.mjs). */
function benchmarkCopy({ hub = false } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'hpv-benchmark-copy-')), 'bench');
  tempDirs.push(dirname(dir));
  cpSync(smokeDir, dir, { recursive: true });
  if (hub) writeFileSync(join(dir, '.hf-dataset.json'), JSON.stringify({ id: 'org/bench', revision: 'main', sha: 'a'.repeat(40), files: [] }));
  return dir;
}

const files = (dir) => ['benchmark.yaml', 'data/locomotion/test.jsonl', 'data/push_standing/test.jsonl'].map((file) => readFileSync(join(dir, file), 'utf8'));

test('a benchmark downloaded from the Hub is served read-only; a local folder stays editable', async () => {
  const hubDir = benchmarkCopy({ hub: true });
  const before = files(hubDir);
  const viewer = await serve({ openBenchmark: hubDir });
  try {
    const listed = (await viewer.request('GET', '/api/benchmarks')).json.benchmarks[0];
    assert.deepEqual([listed.dir, listed.readOnly, listed.hub], [hubDir, true, { id: 'org/bench', revision: 'main', sha: 'a'.repeat(40) }]);
    const { json: { files: tests } } = await viewer.request('GET', '/api/tests');
    assert.ok(tests.length > 0);
    const test = (await viewer.request('GET', `/api/tests?file=${tests[0].file}`)).json;
    const settings = (await viewer.request('GET', '/api/benchmark')).json;
    for (const [method, path, body] of [
      ['PUT', `/api/tests?file=${tests[0].file}`, { ...test, duration: test.duration + 1 }],
      ['PUT', '/api/tests?file=locomotion/new_test.json', test],
      ['DELETE', `/api/tests?file=${tests[0].file}`],
      ['PUT', '/api/benchmark', { text: settings.text.replace(/^title: .*$/m, 'title: changed'), base: settings.text }],
    ]) {
      const { status, json } = await viewer.request(method, path, body);
      assert.equal(status, 403, `${method} ${path}`);
      assert.match(json.error, /datasets\/org\/bench@aaaaaaa, downloaded from Hugging Face, and is read-only here/);
      assert.match(json.error, /To edit and publish it, use cyclotron \(https:\/\/github\.com\/menloresearch\/cyclotron\)\.$/);
    }
    assert.deepEqual(files(hubDir), before);
  } finally {
    await viewer.close();
  }

  const localDir = benchmarkCopy();
  const local = await serve({ openBenchmark: localDir });
  try {
    assert.equal((await local.request('GET', '/api/benchmarks')).json.benchmarks[0].readOnly, false);
    const { json: { files: tests } } = await local.request('GET', '/api/tests');
    const test = (await local.request('GET', `/api/tests?file=${tests[0].file}`)).json;
    assert.equal((await local.request('PUT', `/api/tests?file=${tests[0].file}`, { ...test, duration: test.duration + 1 })).status, 200);
    assert.equal((await local.request('DELETE', `/api/tests?file=${tests[0].file}`)).status, 200);
  } finally {
    await local.close();
  }
});

test('a Run is saved as <timestamp>/result.json with server provenance, then listed, read and deleted', async () => {
  const viewer = await serve({ openBenchmark: smokeDir });
  try {
    const dataset = await viewer.request('GET', '/api/benchmark/dataset');
    assert.equal(dataset.status, 200);
    assert.deepEqual(dataset.json.problems, []);
    const { cells, tests } = planCells(parseBenchmark(dataset.json.raw), dataset.json.rows);
    const policy = { key: 'm0', label: 'bundled', onnxPath: '/examples/checkpoints/asimov/model_aug_18_1/policy_isaaclab_new.onnx' };
    const run = {
      schema: RESULT_SCHEMA,
      generatedAt: new Date().toISOString(),
      provenance: { runtime: { chromium: '140.0.0.0' } },
      benchmark: { source: 'local', path: smokeDir, raw: dataset.json.raw, problems: [] },
      overrides: { tests: null, repeats: null, force: false },
      shard: null,
      policies: [policy],
      tests,
      expectedCells: cells.length,
      cells: cells.map((cell) => cellResult('m0', cell, { frames: 10, metrics: { fell: { fell: false } } }, 5)),
    };
    const saved = await viewer.request('POST', '/api/results', run);
    assert.equal(saved.status, 201);
    assert.match(saved.json.file, /^\d{8}T\d{6}\/result\.json$/);
    assert.ok(existsSync(join(viewer.resultsDir, dirname(saved.json.file), 'report.html')));

    const result = JSON.parse(readFileSync(join(viewer.resultsDir, saved.json.file), 'utf8'));
    assert.equal(result.provenance.hpv.protocol, BENCHMARK_PROTOCOL);
    assert.equal(result.provenance.runtime.node, process.version);
    assert.equal(result.provenance.runtime.chromium, '140.0.0.0');
    const [recorded] = result.policies;
    assert.equal(recorded.onnxPath, undefined);
    assert.equal(recorded.primary, 'policy_isaaclab_new.onnx');
    assert.match(recorded.files.onnx, /^[0-9a-f]{64}$/);
    assert.ok(result.tasks.m0, 'a complete Run is summarised');

    const listed = await viewer.request('GET', '/api/results');
    assert.deepEqual(listed.json.files.map((f) => [f.file, f.policyCount, f.testCount]), [[saved.json.file, 1, tests.length]]);
    assert.equal((await viewer.request('GET', `/api/results?file=${saved.json.file}`)).json.schema, RESULT_SCHEMA);
    assert.equal((await viewer.request('POST', '/api/results', { ...run, schema: 'old' })).status, 400);

    assert.equal((await viewer.request('DELETE', `/api/results?file=${saved.json.file}`)).status, 200);
    assert.equal(existsSync(join(viewer.resultsDir, dirname(saved.json.file))), false);
    assert.deepEqual((await viewer.request('GET', '/api/results')).json.files, []);
  } finally {
    await viewer.close();
  }
});

test('"New benchmark" copies the benchmark template, and /api/save-log writes to the log folder', async () => {
  const template = benchmarkCopy();
  writeFileSync(join(template, 'benchmark.yaml'), `${readFileSync(join(template, 'benchmark.yaml'), 'utf8')}# from our template\n`);
  const logDir = join(dirname(template), 'logs');
  const viewer = await serve({ benchmarkTemplate: template, logDir });
  try {
    assert.equal((await viewer.request('POST', '/api/benchmarks', { name: 'fresh' })).status, 201);
    const created = readFileSync(join(viewer.benchmarksDir, 'fresh', 'benchmark.yaml'), 'utf8');
    assert.match(created, /^name: fresh$/m);
    assert.match(created, /# from our template/);
    assert.equal(parseBenchmark(parseYaml(created)).name, 'fresh');
    const saved = await viewer.request('POST', '/api/save-log', { filename: 'run 1.log', content: 'step 1' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.path, join(logDir, 'run_1.log'));
    assert.equal(readFileSync(join(logDir, 'run_1.log'), 'utf8'), 'step 1');
  } finally {
    await viewer.close();
  }
});
