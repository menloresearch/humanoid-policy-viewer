// The viewer's server: the Vite plugin that serves the policy library and the
// /api routes the app reads and writes (benchmarks, tests, results). Every
// launcher passes its settings in as options (scripts/startViewer.mjs);
// vite.config.mjs builds them from HPV_* variables for a plain `npx vite`.
// Nothing here reads process.env.
//
//   benchmarksDir     where benchmark folders are listed and "New benchmark" creates them
//   openBenchmark     the benchmark the app opens first (what a request without ?benchmark= uses)
//   resultsDir        where results are listed, read and saved (<timestamp>/result.json, as `npm run benchmark` writes)
//   policyLibraryDir  the folder holding the policy roots, served under /policy-library/
//   policyRoots       folder names under policyLibraryDir to list (empty: no library)
//   editable          false drops every route that writes (the headless benchmark runner)

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPolicies, listPolicyRoots } from './policyDiscovery.mjs';
import { initBenchmark } from './benchmarkInit.mjs';
import { BENCHMARK_FILE, readRows, readYamlFile, writeRows } from './benchmarkDir.mjs';
import { collectProvenance, policyFileHashes } from './benchmarkProvenance.mjs';
import { applyBenchmarkEdit, benchmarkFormFields, checkBenchmarkText } from './benchmarkEdit.mjs';
import { RESULT_SCHEMA, isComplete, summarize } from '../src/benchmark/run.js';
import { OPT_IN_METRICS, rowToSequence, sequenceToRow, validateGoal, validateTestRow } from '../src/benchmark/testRow.js';
import { validateSettle, validateStartState } from '../src/simulation/startState.js';
import { buildBenchmarkReportHtml } from '../src/simulation/benchmarkReport.js';
import { validateTerrain } from '../src/simulation/terrainGen.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

export function viewerServer({
  benchmarksDir,
  openBenchmark,
  resultsDir,
  policyLibraryDir,
  policyRoots: policyRootNames = [],
  editable = true,
}) {
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
  // a benchmark folder (see scripts/benchmarkDir.mjs): openBenchmark
  // (`npm run dev benchmark=<dir>`, by default ./benchmarks/default), or
  // another benchmark the request names (see /api/benchmarks below). Results live in
  // resultsDir. All are outside public/, so writing them never triggers a
  // page reload.
  const RESULTS_DIR = resultsDir;
  const MAX_DURATION = 600;
  // A result is <timestamp>/result.json, the folder `npm run benchmark` writes.
  const RESULT_FILE = 'result.json';
  const RESULT_FILE_RE = /^[A-Za-z0-9_-]+\/result\.json$/;

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
    // Per-test floor grip, terrain course, end zone, start state and the gait-symmetry opt-in; saving must keep them.
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
    if (parsed.start !== undefined && parsed.start !== null) {
      const problems = validateStartState(parsed.start);
      if (problems.length) throw new Error(`"start": ${problems.join('; ')}`);
      clean.start = structuredClone(parsed.start);
    }
    if (parsed.dropSettleS !== undefined && parsed.dropSettleS !== null) {
      const problems = validateSettle(parsed.dropSettleS);
      if (problems.length) throw new Error(`"dropSettleS" ${problems.join('; ')}`);
      clean.dropSettleS = round3(parsed.dropSettleS);
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
  const SESSION_BENCHMARK_DIR = resolve(openBenchmark);
  const TEST_ID_RE = /^[a-z0-9][a-z0-9_]*\/[a-z0-9][a-z0-9_.-]*$/;
  const rowFile = (row) => `${row.id}.json`;

  // ---- Benchmarks (/api/benchmarks) ----
  // The viewer lists every benchmark dataset folder it can find: the session's
  // (SESSION_BENCHMARK_DIR, what a request without ?benchmark= reads and writes) and each
  // folder of BENCHMARKS_DIR (the default benchmark, Hub working copies pulled
  // by `npm run dev benchmark=datasets/...`, and the benchmarks "New benchmark" makes).
  // A request names one by its key; only listed folders are accepted.
  const BENCHMARKS_DIR = resolve(benchmarksDir);
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

  // ---- Benchmark dataset (/api/benchmark/dataset) ----
  // benchmark.yaml as parsed YAML plus every row, what the viewer's Run plans
  // its cells from (src/benchmark/run.js), the same files `npm run benchmark`
  // loads. `problems` are rows that would make the CLI refuse the benchmark.
  function handleBenchmarkDataset(req, res) {
    try {
      const dir = requestBenchmarkDir(new URL(req.url, 'http://localhost'));
      if (!dir) {
        sendJson(res, 404, { error: 'Unknown benchmark' });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      let raw;
      try {
        raw = readYamlFile(resolve(dir, BENCHMARK_FILE));
      } catch (e) {
        sendJson(res, 400, { error: `${BENCHMARK_FILE}: ${e.message}` });
        return;
      }
      const { rows, problems } = readRows(dir);
      sendJson(res, 200, { dir, raw, rows, problems });
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

  // ---- Policy catalog (/api/policies): ONNX policies for benchmarking ----
  function listPolicies() {
    return discoverPolicies(policyLibraryDir, policyRootNames);
  }

  // ---- Benchmark results (/api/results) ----
  // Every <folder>/result.json under resultsDir: the CLI's out dirs and the
  // in-app benchmark's results alike. POST saves an in-app result as a new
  // <timestamp>/result.json + report.html, with what the server knows added:
  // provenance (viewer commit, runtime) and each policy's file hashes.
  function listResults() {
    let entries;
    try { entries = readdirSync(RESULTS_DIR, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const entry of entries) {
      const path = resolve(RESULTS_DIR, entry.name, RESULT_FILE);
      if (!entry.isDirectory() || entry.name.startsWith('.') || !existsSync(path)) continue;
      let meta = {};
      try {
        const result = JSON.parse(readFileSync(path, 'utf8'));
        meta = {
          generatedAt: result.generatedAt ?? null,
          benchmark: result.benchmark?.raw?.title ?? result.benchmark?.raw?.name ?? null,
          policyCount: Array.isArray(result.policies) ? result.policies.length : null,
          testCount: Array.isArray(result.tests) ? result.tests.length : null,
        };
      } catch { /* listed without its summary */ }
      out.push({ file: `${entry.name}/${RESULT_FILE}`, ...meta });
    }
    return out.sort((a, b) => b.file.localeCompare(a.file));
  }

  /** The policy file an app URL (/policy-library/... or a public/ path) names, or null. */
  function policyFileOnDisk(onnxPath) {
    if (typeof onnxPath !== 'string' || !onnxPath.startsWith('/')) return null;
    const path = onnxPath.startsWith('/policy-library/')
      ? policyLibraryDir && resolve(policyLibraryDir, onnxPath.slice('/policy-library/'.length))
      : resolve(appDir, 'public', onnxPath.slice(1));
    if (!path || !existsSync(path)) return null;
    const real = realpathSync(path);
    const allowed = onnxPath.startsWith('/policy-library/')
      ? policyRoots.some((root) => isWithinDirectory(root.realDirectory, real))
      : isWithinDirectory(resolve(appDir, 'public'), real);
    return allowed && statSync(real).isFile() ? path : null;
  }

  /** A policy as `npm run benchmark` records a local one, from the app's { key, label, onnxPath }. */
  function resultPolicy({ onnxPath, ...policy }) {
    const path = policyFileOnDisk(onnxPath);
    if (!path) return { ...policy, id: policy.id ?? `local:${onnxPath}`, source: 'local', sha: null, files: null };
    const policyDir = dirname(path);
    return { ...policy, id: `local:${policyDir}`, source: 'local', sha: null, primary: basename(path), files: policyFileHashes(policyDir, basename(path)) };
  }

  function newResultDir() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
    let name = stamp;
    for (let n = 2; existsSync(resolve(RESULTS_DIR, name)); n++) name = `${stamp}_${n}`;
    return name;
  }

  function saveResult(body) {
    if (body?.schema !== RESULT_SCHEMA) throw new Error(`A result must be a ${RESULT_SCHEMA} object`);
    for (const field of ['policies', 'tests', 'cells']) {
      if (!Array.isArray(body[field])) throw new Error(`A result needs a "${field}" list`);
    }
    if (!body.benchmark?.raw || typeof body.benchmark.raw !== 'object') throw new Error('A result needs the benchmark.yaml it ran (benchmark.raw)');
    const provenance = collectProvenance(appDir);
    const browser = body.provenance?.runtime?.chromium;
    provenance.runtime.chromium = typeof browser === 'string' ? browser : null;
    const result = { ...body, provenance, policies: body.policies.map(resultPolicy) };
    Object.assign(result, isComplete(result) ? summarize(result) : {});
    const name = newResultDir();
    const dir = resolve(RESULTS_DIR, name);
    mkdirSync(dir, { recursive: true });
    // Compact, as the CLI writes it: machine-written and machine-read.
    writeFileSync(resolve(dir, RESULT_FILE), JSON.stringify(result));
    writeFileSync(resolve(dir, 'report.html'), buildBenchmarkReportHtml(result));
    return `${name}/${RESULT_FILE}`;
  }

  async function handleResults(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    try {
      if (req.method === 'GET' && !file) { sendJson(res, 200, { files: listResults() }); return; }
      if (req.method === 'POST') {
        let body;
        try { body = await readRequestJson(req); } catch (e) { sendJson(res, 400, { error: `Invalid JSON: ${e.message}` }); return; }
        let saved;
        try { saved = saveResult(body); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
        sendJson(res, 201, { ok: true, file: saved });
        return;
      }
      if (!file || !RESULT_FILE_RE.test(file)) { sendJson(res, 400, { error: 'A result is named <folder>/result.json' }); return; }
      const filePath = resolve(RESULTS_DIR, file);
      if (!isWithinDirectory(RESULTS_DIR, filePath)) { sendJson(res, 400, { error: 'Invalid path' }); return; }
      if (!existsSync(filePath)) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(filePath, 'utf8'));
        return;
      }
      if (req.method === 'DELETE') {
        // result.json and the report beside it; the folder only if that empties it.
        unlinkSync(filePath);
        rmSync(resolve(dirname(filePath), 'report.html'), { force: true });
        try { rmdirSync(dirname(filePath)); } catch { /* holds other files */ }
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
    name: 'viewer-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (!editable && WRITE_METHODS.has(req.method) && pathname.startsWith('/api/')) {
          sendJson(res, 405, { error: 'This viewer is read-only' });
          return;
        }
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
        if (pathname === '/api/benchmark/dataset') {
          handleBenchmarkDataset(req, res);
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
