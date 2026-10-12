// Plugins
import Components from 'unplugin-vue-components/vite'
import Vue from '@vitejs/plugin-vue'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'
import Fonts from 'unplugin-fonts/vite'

// Utilities
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { discoverPolicies, listPolicyRoots } from './scripts/policyDiscovery.mjs'
import { getBenchmarkResultsDir, getPolicyLibrary } from './scripts/policyLibraryConfig.mjs'
import { initBenchmark } from './scripts/benchmarkInit.mjs'
import { BENCHMARK_FILE, defaultBenchmarkDir, readRows, readYamlFile, writeRows } from './scripts/benchmarkDir.mjs'
import { applyBenchmarkEdit, benchmarkFormFields, checkBenchmarkText } from './scripts/benchmarkEdit.mjs'
import { OPT_IN_METRICS, rowToSequence, sequenceToRow, validateGoal, validateTestRow } from './src/benchmark/testRow.js'
import { validateTerrain } from './src/simulation/terrainGen.js'

// A submodule checked out under public/ carries a `.git` pointer file that
// must not be deployed along with the scene assets.
function dropGitPointerFiles() {
  let scenesDir;
  return {
    name: 'drop-git-pointer-files',
    apply: 'build',
    configResolved(config) {
      scenesDir = resolve(config.root, config.build.outDir, 'examples/scenes');
    },
    closeBundle() {
      if (!existsSync(scenesDir)) return;
      for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
        const pointer = resolve(scenesDir, entry.name, '.git');
        if (entry.isDirectory() && existsSync(pointer) && statSync(pointer).isFile()) unlinkSync(pointer);
      }
    },
  };
}

function humanoidDevPlugin() {
  const appDir = dirname(fileURLToPath(import.meta.url));
  const { baseDir: policyLibraryDir, roots: policyRootNames } = getPolicyLibrary();
  const policyRoots = listPolicyRoots(policyLibraryDir, policyRootNames);

  function isWithinDirectory(directory, filePath) {
    const pathFromDirectory = relative(directory, filePath);
    return pathFromDirectory === '' || (!pathFromDirectory.startsWith('..') && !pathFromDirectory.includes('../'));
  }

  function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload, null, 2) + '\n');
  }

  function readRequestJson(req) {
    return new Promise((resolveJson, rejectJson) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveJson(text ? JSON.parse(text) : {});
        } catch (error) {
          rejectJson(error);
        }
      });
      req.on('error', rejectJson);
    });
  }

  // ---- Test persistence (/api/tests) ----
  // The trajectory editor and the in-app benchmark read and write the tests of
  // a benchmark working copy (see scripts/benchmarkDir.mjs): HPV_SUITE_DIR
  // (`npm run dev benchmark=<dir>`), by default ./benchmarks/default, or
  // another benchmark the request names (see /api/benchmarks below). Results live under
  // ./benchmark_results. All are outside public/, so writing them never triggers a
  // page reload.
  const RESULTS_DIR = getBenchmarkResultsDir(appDir);
  const MAX_DURATION = 600;
  // Saved benchmark result names; nested subfolders allowed.
  const FILENAME_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/;

  function round3(v) {
    const n = v === undefined ? 0 : Number(v);
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  }

  function validateSequence(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('A test must be a JSON object');
    }
    if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      throw new Error('A test\'s "commands" must be a non-empty array');
    }
    let lastT = 0;
    const commands = parsed.commands.map((entry, i) => {
      const t = Number(entry?.t);
      if (!Number.isFinite(t) || t < 0) {
        throw new Error(`Command ${i} has invalid "t"`);
      }
      const rt = round3(t);
      lastT = Math.max(lastT, rt);
      return { t: rt, vx: round3(entry.vx), vy: round3(entry.vy), wz: round3(entry.wz) };
    });
    if (lastT > MAX_DURATION) {
      throw new Error(`Last keypoint ${lastT}s exceeds ${MAX_DURATION}s limit`);
    }
    let duration = round3(parsed.duration);
    if (!Number.isFinite(duration) || duration < lastT) duration = lastT;
    if (duration > MAX_DURATION) {
      throw new Error(`Duration ${duration}s exceeds ${MAX_DURATION}s limit`);
    }
    const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : 'test';
    const clean = { name, duration };
    if (parsed.limits && typeof parsed.limits === 'object') {
      const limits = {};
      let any = false;
      for (const axis of ['vx', 'vy', 'wz']) {
        const pair = parsed.limits[axis];
        if (Array.isArray(pair) && pair.length === 2) {
          const a = Number(pair[0]);
          const b = Number(pair[1]);
          if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
            limits[axis] = [round3(a), round3(b)];
            any = true;
          }
        }
      }
      if (any) clean.limits = limits;
    }
    clean.commands = commands;
    // Preserve optional timed events (e.g. pushes) so benchmark perturbation
    // tests live in the same editable JSON as velocity keypoints. A malformed
    // event is dropped (with a warning), not silently repaired — a fabricated
    // [0,0] direction or an invalid duration is physically meaningless, and
    // hiding that at save time only pushes the bug to load time instead.
    if (Array.isArray(parsed.events) && parsed.events.length) {
      const events = [];
      for (const ev of parsed.events) {
        if (!ev || typeof ev !== 'object') {
          console.warn('[tests] dropping malformed event (not an object)');
          continue;
        }
        const t = round3(ev.t);
        if (!Number.isFinite(t) || t < 0 || t > MAX_DURATION) {
          console.warn('[tests] dropping event with invalid "t"');
          continue;
        }
        if (ev.type !== 'push') {
          console.warn(`[tests] dropping event with unsupported "type" (${ev.type})`);
          continue;
        }
        // dir accepts 2 (legacy, z=0) or 3 elements — full 3D force direction.
        const dxyz = [Number(ev.dir?.[0]), Number(ev.dir?.[1]), Number(ev.dir?.[2] ?? 0)];
        if (!Array.isArray(ev.dir) || (ev.dir.length !== 2 && ev.dir.length !== 3)
          || dxyz.some((v) => !Number.isFinite(v)) || Math.hypot(...dxyz) === 0) {
          console.warn('[tests] dropping push event with invalid "dir"');
          continue;
        }
        const force = Number(ev.force);
        // Force is a magnitude in Newtons — direction lives in "dir" — so a
        // non-positive value is an authoring mistake, not a valid reverse-push.
        if (!Number.isFinite(force) || force <= 0) {
          console.warn('[tests] dropping push event with invalid "force"');
          continue;
        }
        const duration = Number(ev.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          console.warn('[tests] dropping push event with invalid "duration"');
          continue;
        }
        // Optional torque, must be both-present or both-absent.
        const hasTorqueAxis = ev.torqueAxis !== undefined;
        const hasTorqueMag = ev.torqueMag !== undefined;
        if (hasTorqueAxis !== hasTorqueMag) {
          console.warn('[tests] dropping push event: torqueAxis/torqueMag must be both present or both absent');
          continue;
        }
        let torqueAxis = null;
        let torqueMag = null;
        if (hasTorqueAxis) {
          if (!Array.isArray(ev.torqueAxis) || ev.torqueAxis.length !== 3
            || ev.torqueAxis.some((v) => !Number.isFinite(Number(v)))) {
            console.warn('[tests] dropping push event with invalid "torqueAxis"');
            continue;
          }
          torqueMag = Number(ev.torqueMag);
          if (!Number.isFinite(torqueMag)) {
            console.warn('[tests] dropping push event with invalid "torqueMag"');
            continue;
          }
          torqueAxis = ev.torqueAxis.map((v) => round3(Number(v)));
        }
        const clean_ev = {
          t,
          type: 'push',
          dir: [round3(ev.dir[0]), round3(ev.dir[1]), round3(Number(ev.dir[2] ?? 0))],
          force: round3(force),
          duration: round3(duration),
        };
        if (torqueAxis) {
          clean_ev.torqueAxis = torqueAxis;
          clean_ev.torqueMag = round3(torqueMag);
        }
        // Which body the force/torque applies to (default: pelvis).
        if (typeof ev.targetBody === 'string' && ev.targetBody) clean_ev.targetBody = ev.targetBody;
        // The label shown in reports.
        if (typeof ev.label === 'string' && ev.label) clean_ev.label = ev.label;
        events.push(clean_ev);
      }
      if (events.length) {
        events.sort((a, b) => a.t - b.t);
        clean.events = events;
      }
    }
    // Per-test floor grip, terrain course, end zone and the gait-symmetry opt-in; saving must keep them.
    const footFriction = Number(parsed.footFriction);
    if (parsed.footFriction !== undefined && parsed.footFriction !== null) {
      if (!Number.isFinite(footFriction) || footFriction <= 0) throw new Error('"footFriction" must be a number > 0');
      clean.footFriction = round3(footFriction);
    }
    if (parsed.terrain !== undefined && parsed.terrain !== null) {
      const problems = validateTerrain(parsed.terrain);
      if (problems.length) throw new Error(`"terrain": ${problems.join('; ')}`);
      clean.terrain = { ...parsed.terrain };
    }
    if (parsed.goal !== undefined && parsed.goal !== null) {
      const problems = validateGoal(parsed.goal);
      if (problems.length) throw new Error(`"goal": ${problems.join('; ')}`);
      clean.goal = { x: parsed.goal.x, y: parsed.goal.y, radius_m: round3(parsed.goal.radius_m) };
    }
    if (parsed.gaitSymmetry === true) clean.gaitSymmetry = true;
    if (parsed.metricsOptIn !== undefined) {
      if (!Array.isArray(parsed.metricsOptIn) || parsed.metricsOptIn.some((m) => !OPT_IN_METRICS.includes(m))) {
        throw new Error(`"metricsOptIn" must list only: ${OPT_IN_METRICS.join(', ')}`);
      }
      clean.metricsOptIn = [...parsed.metricsOptIn];
      if (clean.metricsOptIn.includes('gait_symmetry')) clean.gaitSymmetry = true;
      else delete clean.gaitSymmetry;
    }
    return clean;
  }

  // Each row of data/<category>/test.jsonl shows up as "<category>/<name>.json";
  // saving writes the row back, and a new category gets its own file.
  const SESSION_BENCHMARK_DIR = resolve(process.env.HPV_SUITE_DIR || defaultBenchmarkDir(appDir));
  const TEST_ID_RE = /^[a-z0-9][a-z0-9_]*\/[a-z0-9][a-z0-9_.-]*$/;
  const rowFile = (row) => `${row.id}.json`;

  // ---- Benchmarks (/api/benchmarks) ----
  // The viewer lists every benchmark dataset folder it can find: the session's
  // (SESSION_BENCHMARK_DIR, what a request without ?benchmark= reads and writes) and each
  // folder of BENCHMARKS_DIR (the default benchmark, Hub working copies pulled
  // by `npm run dev benchmark=datasets/...`, and the benchmarks "New benchmark" makes).
  // A request names one by its key; only listed folders are accepted.
  const BENCHMARKS_DIR = resolve(process.env.HPV_BENCHMARKS_DIR || resolve(appDir, 'benchmarks'));
  const BENCHMARK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
  const benchmarkKey = (dir) => (isWithinDirectory(appDir, dir) ? relative(appDir, dir) : dir);

  function listBenchmarks() {
    const dirs = [SESSION_BENCHMARK_DIR];
    const others = [];
    try {
      for (const entry of readdirSync(BENCHMARKS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) others.push(resolve(BENCHMARKS_DIR, entry.name));
      }
    } catch {}
    const seen = new Set();
    return [...dirs, ...others.sort()]
      .filter((dir) => !seen.has(dir) && seen.add(dir) && existsSync(resolve(dir, BENCHMARK_FILE)))
      .map((dir) => {
        let raw = {};
        try { raw = readYamlFile(resolve(dir, BENCHMARK_FILE)) || {}; } catch {}
        return {
          key: benchmarkKey(dir),
          dir,
          title: String(raw.title || raw.name || basename(dir)),
          description: typeof raw.description === 'string' ? raw.description : '',
          testCount: readRows(dir).rows.length,
          session: dir === SESSION_BENCHMARK_DIR,
        };
      });
  }

  /** The folder a request's ?benchmark= names (default: the session's); null if it isn't a listed benchmark. */
  function requestBenchmarkDir(url) {
    const key = url.searchParams.get('benchmark');
    if (!key) return SESSION_BENCHMARK_DIR;
    return listBenchmarks().find((benchmark) => benchmark.key === key)?.dir ?? null;
  }

  async function handleBenchmarks(req, res) {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { benchmarks: listBenchmarks(), benchmarksDir: BENCHMARKS_DIR });
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readRequestJson(req);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        const name = String(body?.name ?? '');
        if (!BENCHMARK_NAME_RE.test(name)) {
          sendJson(res, 400, { error: 'A benchmark name is lower case letters, digits and -' });
          return;
        }
        const dir = resolve(BENCHMARKS_DIR, name);
        if (existsSync(dir)) {
          sendJson(res, 409, { error: `${benchmarkKey(dir)} already exists` });
          return;
        }
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
        initBenchmark(dir, { title, exampleTest: false, log: () => {} });
        sendJson(res, 201, { ok: true, benchmark: listBenchmarks().find((benchmark) => benchmark.dir === dir) });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  }

  // ---- Benchmark settings (/api/benchmark) ----
  // The benchmark.yaml of the benchmark ?benchmark= names, for the Benchmark settings
  // dialog: GET returns the text and the form's fields; PUT takes { fields } or
  // { text }, plus the text it was based on (`base`), and refuses an edit
  // `npm run benchmark` would reject (scripts/benchmarkEdit.mjs).
  function describeBenchmarkFile(text, rows) {
    const { raw, errors, warnings } = checkBenchmarkText(text, rows);
    return {
      text,
      fields: benchmarkFormFields(raw),
      errors,
      warnings,
      configs: [...new Set(rows.map((row) => row.config))].sort(),
      testIds: rows.map((row) => row.id).sort(),
    };
  }

  async function handleBenchmarkFile(req, res) {
    try {
      const dir = requestBenchmarkDir(new URL(req.url, 'http://localhost'));
      if (!dir) {
        sendJson(res, 404, { error: 'Unknown benchmark' });
        return;
      }
      const path = resolve(dir, BENCHMARK_FILE);
      const current = readFileSync(path, 'utf8');
      const { rows } = readRows(dir);
      if (req.method === 'GET') {
        sendJson(res, 200, describeBenchmarkFile(current, rows));
        return;
      }
      if (req.method === 'PUT') {
        let body;
        try {
          body = await readRequestJson(req);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        if (typeof body.base === 'string' && body.base !== current) {
          sendJson(res, 409, { error: 'benchmark.yaml changed on disk since you opened it; reopen the settings to see the new version.' });
          return;
        }
        let result;
        try {
          result = applyBenchmarkEdit(current, body, rows);
        } catch (e) {
          sendJson(res, 400, { error: e.message, problems: e.problems ?? [] });
          return;
        }
        if (result.text !== current) writeFileSync(path, result.text);
        sendJson(res, 200, { ok: true, ...describeBenchmarkFile(result.text, rows) });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  }

  function listTests(benchmarkDir) {
    return readRows(benchmarkDir).rows.map((row) => ({
      file: rowFile(row),
      config: row.config,
      name: row.name,
      duration: row.duration,
      keypointCount: row.commands.length,
      eventCount: row.events.length,
      terrainType: row.terrain?.type ?? null,
      footFriction: row.foot_friction,
    })).sort((a, b) => a.file.localeCompare(b.file));
  }

  async function handleTests(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    try {
      const benchmarkDir = requestBenchmarkDir(url);
      if (!benchmarkDir) {
        sendJson(res, 404, { error: `No benchmark ${url.searchParams.get('benchmark')}` });
        return;
      }
      if (req.method === 'GET' && !file) {
        sendJson(res, 200, { files: listTests(benchmarkDir), benchmarkDir });
        return;
      }
      const id = file?.replace(/\.json$/, '');
      if (!id || !TEST_ID_RE.test(id)) {
        sendJson(res, 400, { error: 'A test is saved as <category>/<name>: lower case letters, digits and _' });
        return;
      }
      const { rows } = readRows(benchmarkDir);
      const index = rows.findIndex((row) => row.id === id);
      if (req.method === 'GET') {
        if (index < 0) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, rowToSequence(rows[index]));
        return;
      }
      if (req.method === 'PUT') {
        let parsed;
        try {
          parsed = validateSequence(await readRequestJson(req));
        } catch (e) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        const row = sequenceToRow(id, parsed, index >= 0 ? rows[index] : null);
        // The same check the CLI runs on load: a bad row written here would make the whole dataset refuse to load.
        const problems = validateTestRow(row);
        if (problems.length) {
          sendJson(res, 400, { error: problems.join('\n') });
          return;
        }
        if (index >= 0) rows[index] = row; else rows.push(row);
        writeRows(benchmarkDir, rows.filter((r) => r.config === row.config));
        sendJson(res, 200, { ok: true, file, entry: listTests(benchmarkDir).find((f) => f.file === file) });
        return;
      }
      if (req.method === 'DELETE') {
        if (index < 0) { sendJson(res, 404, { error: 'Not found' }); return; }
        const [removed] = rows.splice(index, 1);
        const left = rows.filter((r) => r.config === removed.config);
        writeRows(benchmarkDir, left, { configs: [removed.config] });
        // The last test of a category takes its file (and dataset config) with it.
        if (!left.length) rmSync(resolve(benchmarkDir, 'data', removed.config), { recursive: true, force: true });
        sendJson(res, 200, { ok: true, file });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  }

  function walkJson(dir, prefix, onFile) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkJson(resolve(dir, entry.name), rel, onFile);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        onFile(rel, resolve(dir, entry.name));
      }
    }
  }

  // ---- Policy catalog (/api/policies): ONNX policies for benchmarking ----
  function listPolicies() {
    return discoverPolicies(policyLibraryDir, policyRootNames);
  }

  // ---- Benchmark results (/api/results): saved results ----
  function listResults() {
    if (!existsSync(RESULTS_DIR)) return [];
    const out = [];
    walkJson(RESULTS_DIR, '', (rel, full) => {
      let meta = {};
      try {
        const p = JSON.parse(readFileSync(full, 'utf8'));
        meta = {
          generatedAt: p.generatedAt ?? null,
          policyCount: Array.isArray(p.policies) ? p.policies.length : null,
          testCount: Array.isArray(p.tests) ? p.tests.length : null,
        };
      } catch { /* ignore */ }
      out.push({ file: rel, ...meta });
    });
    return out.sort((a, b) => b.file.localeCompare(a.file));
  }

  async function handleResults(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    try {
      if (req.method === 'GET' && !file) { sendJson(res, 200, { files: listResults() }); return; }
      if (file && !FILENAME_RE.test(file)) { sendJson(res, 400, { error: 'Invalid filename' }); return; }
      const filePath = file ? resolve(RESULTS_DIR, file) : null;
      if (filePath && !isWithinDirectory(RESULTS_DIR, filePath)) { sendJson(res, 400, { error: 'Invalid path' }); return; }
      if (req.method === 'GET') {
        if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Not found' }); return; }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(filePath, 'utf8'));
        return;
      }
      if (req.method === 'PUT') {
        let parsed;
        try { parsed = await readRequestJson(req); } catch (e) { sendJson(res, 400, { error: `Invalid JSON: ${e.message}` }); return; }
        mkdirSync(dirname(filePath), { recursive: true });
        // Compact, not pretty-printed: a run is machine-written and machine-read,
        // and the indentation alone tripled it (827KB -> 236KB for a 2x3 run),
        // which the results page then had to fetch and parse on every open.
        writeFileSync(filePath, JSON.stringify(parsed), 'utf8');
        sendJson(res, 200, { ok: true, file });
        return;
      }
      if (req.method === 'DELETE') {
        if (!file) { sendJson(res, 400, { error: 'Missing file' }); return; }
        if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Not found' }); return; }
        unlinkSync(filePath);
        sendJson(res, 200, { ok: true, file });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  }
  // ---- end tests ----

  return {
    name: 'humanoid-dev-endpoints',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (pathname.startsWith('/policy-library/')) {
          const relativePolicyPath = pathname.slice('/policy-library/'.length);
          const filePath = policyLibraryDir ? resolve(policyLibraryDir, relativePolicyPath) : null;
          const resolvedFilePath = filePath && existsSync(filePath) ? realpathSync(filePath) : null;
          if (!resolvedFilePath || !policyRoots.some((policyRoot) => isWithinDirectory(policyRoot.realDirectory, resolvedFilePath)) || !statSync(resolvedFilePath).isFile()) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', extname(resolvedFilePath).toLowerCase() === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(resolvedFilePath));
          return;
        }
        if (pathname === '/api/benchmarks') {
          await handleBenchmarks(req, res);
          return;
        }
        if (pathname === '/api/benchmark') {
          await handleBenchmarkFile(req, res);
          return;
        }
        if (pathname === '/api/tests') {
          await handleTests(req, res);
          return;
        }
        if (pathname === '/api/policies') {
          sendJson(res, 200, { policies: listPolicies() });
          return;
        }
        if (pathname === '/api/results') {
          await handleResults(req, res);
          return;
        }
        next();
      });

      server.middlewares.use('/api/save-log', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { filename, content } = JSON.parse(body);
            const safe = String(filename || ('dump_' + Date.now() + '.log')).replace(/[^a-zA-Z0-9_.-]/g, '_');
            const outPath = resolve(appDir, 'logs', safe);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, String(content ?? ''), 'utf8');
            sendJson(res, 200, { ok: true, path: outPath });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String(err) });
          }
        });
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    Vue({
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
    Vuetify({
      styles: {
        configFile: './src/styles/settings.scss',
      },
    }),
    Components(),
    humanoidDevPlugin(),
    dropGitPointerFiles(),
    Fonts({
      fontsource: {
        families: [
          {
            name: 'Roboto',
            weights: [100, 300, 400, 500, 700, 900],
            styles: ['normal', 'italic'],
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['vuetify', 'onnxruntime-web'],
  },
  define: { 'process.env': {} },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    extensions: [
      '.js',
      '.json',
      '.jsx',
      '.mjs',
      '.ts',
      '.tsx',
      '.vue',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    watch: {
      // Saving trajectory/benchmark JSON must not trigger a full page reload.
      // Anchored to the app folder: a bare **/benchmark/** would also stop
      // edits to src/benchmark/ from hot-reloading.
      ignored: ['benchmarks', 'benchmark_results']
        .map((folder) => fileURLToPath(new URL(`./${folder}/**`, import.meta.url))),
    },
  },
  css: {
    preprocessorOptions: {
      sass: {
        api: 'modern-compiler',
      },
      scss: {
        api:'modern-compiler',
      },
    },
  },
})
