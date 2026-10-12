import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { viewerServer } from './viewerServer.mjs';

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
  return { request, benchmarksDir, close: () => new Promise((done) => server.close(done)) };
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
    for (const [method, path] of [['POST', '/api/benchmarks'], ['PUT', '/api/benchmark'], ['DELETE', '/api/tests'], ['POST', '/api/save-log']]) {
      const { status, json } = await viewer.request(method, path, { name: 'fresh' });
      assert.equal(status, 405, `${method} ${path}`);
      assert.match(json.error, /read-only/);
    }
    assert.equal(existsSync(join(viewer.benchmarksDir, 'fresh')), false);
    assert.equal((await viewer.request('GET', '/api/benchmarks')).status, 200);
    assert.equal((await viewer.request('GET', '/api/policies')).status, 200);
  } finally {
    await viewer.close();
  }
});
