// Plugins
import Components from 'unplugin-vue-components/vite'
import Vue from '@vitejs/plugin-vue'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'
import Fonts from 'unplugin-fonts/vite'

// Utilities
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { listModelRoots, listModels as discoverModels } from './scripts/modelDiscovery.mjs'
import { getBenchmarkRunsDir, getModelLibrary } from './scripts/modelLibraryConfig.mjs'
import { listSequenceEntries } from './scripts/sequenceCatalog.mjs'
import { readRows, writeRows } from './scripts/suiteDir.mjs'
import { rowToSequence, sequenceToRow } from './src/benchmark/testRow.js'

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
  const { baseDir: modelLibraryDir, roots: modelRootNames } = getModelLibrary();
  const modelRoots = listModelRoots(modelLibraryDir, modelRootNames);

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

  // ---- Trajectory sequence persistence (/api/sequences) ----
  // Absorbed from the former vite-plugin-sequences.mjs so this single dev
  // middleware also saves/loads velocity-command trajectories. Test
  // definitions live under ./benchmark; completed run outputs live under
  // ./benchmark_runs (both outside public/, so writing them never triggers a
  // page reload). Only ./benchmark is gitignored: keeping a test definition in
  // git requires an intentional `git add -f`, so ad hoc tests never end up
  // committed by accident. Run outputs are real results worth sharing, so
  // they're tracked normally once you `git add` one.
  const SEQ_DIR = resolve(appDir, 'benchmark');
  const BENCH_DIR = getBenchmarkRunsDir(appDir);
  const MAX_DURATION = 600;
  // Allow nested subfolders, e.g. push/forward.json. The char
  const FILENAME_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/;

  function round3(v) {
    const n = v === undefined ? 0 : Number(v);
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  }

  function validateSequence(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Sequence must be a JSON object');
    }
    if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      throw new Error('Sequence "commands" must be a non-empty array');
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
    const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : 'sequence';
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
          console.warn('[sequences] dropping malformed event (not an object)');
          continue;
        }
        const t = round3(ev.t);
        if (!Number.isFinite(t) || t < 0 || t > MAX_DURATION) {
          console.warn('[sequences] dropping event with invalid "t"');
          continue;
        }
        if (ev.type !== 'push') {
          console.warn(`[sequences] dropping event with unsupported "type" (${ev.type})`);
          continue;
        }
        // dir accepts 2 (legacy, z=0) or 3 elements — full 3D force direction.
        const dxyz = [Number(ev.dir?.[0]), Number(ev.dir?.[1]), Number(ev.dir?.[2] ?? 0)];
        if (!Array.isArray(ev.dir) || (ev.dir.length !== 2 && ev.dir.length !== 3)
          || dxyz.some((v) => !Number.isFinite(v)) || Math.hypot(...dxyz) === 0) {
          console.warn('[sequences] dropping push event with invalid "dir"');
          continue;
        }
        const force = Number(ev.force);
        // Force is a magnitude in Newtons — direction lives in "dir" — so a
        // non-positive value is an authoring mistake, not a valid reverse-push.
        if (!Number.isFinite(force) || force <= 0) {
          console.warn('[sequences] dropping push event with invalid "force"');
          continue;
        }
        const duration = Number(ev.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          console.warn('[sequences] dropping push event with invalid "duration"');
          continue;
        }
        // Optional torque, must be both-present or both-absent.
        const hasTorqueAxis = ev.torqueAxis !== undefined;
        const hasTorqueMag = ev.torqueMag !== undefined;
        if (hasTorqueAxis !== hasTorqueMag) {
          console.warn('[sequences] dropping push event: torqueAxis/torqueMag must be both present or both absent');
          continue;
        }
        let torqueAxis = null;
        let torqueMag = null;
        if (hasTorqueAxis) {
          if (!Array.isArray(ev.torqueAxis) || ev.torqueAxis.length !== 3
            || ev.torqueAxis.some((v) => !Number.isFinite(Number(v)))) {
            console.warn('[sequences] dropping push event with invalid "torqueAxis"');
            continue;
          }
          torqueMag = Number(ev.torqueMag);
          if (!Number.isFinite(torqueMag)) {
            console.warn('[sequences] dropping push event with invalid "torqueMag"');
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
        // The report label and the benchmark tier (reasonable / beyond).
        if (typeof ev.label === 'string' && ev.label) clean_ev.label = ev.label;
        if (ev.tier === 'reasonable' || ev.tier === 'beyond') clean_ev.tier = ev.tier;
        events.push(clean_ev);
      }
      if (events.length) {
        events.sort((a, b) => a.t - b.t);
        clean.events = events;
      }
    }
    // Per-test floor grip and the gait-symmetry opt-in; saving must keep them.
    const footFriction = Number(parsed.footFriction);
    if (parsed.footFriction !== undefined && parsed.footFriction !== null) {
      if (!Number.isFinite(footFriction) || footFriction <= 0) throw new Error('"footFriction" must be a number > 0');
      clean.footFriction = round3(footFriction);
    }
    if (parsed.gaitSymmetry === true) clean.gaitSymmetry = true;
    return clean;
  }

  // ---- Benchmark dataset working copy (HPV_SUITE_DIR) ----
  // `npm run dev suite=<dir>` points the editor at a benchmark dataset (see
  // scripts/suiteDir.mjs): each row of data/<config>/test.jsonl shows up as
  // "<config>/<name>.json" and saving writes the row back.
  const SUITE_DIR = process.env.HPV_SUITE_DIR ? resolve(process.env.HPV_SUITE_DIR) : null;
  const rowFile = (row) => `${row.id}.json`;

  function suiteEntries() {
    return readRows(SUITE_DIR).rows.map((row) => ({
      file: rowFile(row),
      folder: row.config,
      name: row.name,
      duration: row.duration,
      keypointCount: row.commands.length,
      eventCount: row.events.length,
    })).sort((a, b) => a.file.localeCompare(b.file));
  }

  function handleSuiteSequences(req, res, file, parsed) {
    const { rows } = readRows(SUITE_DIR);
    const id = file?.replace(/\.json$/, '');
    const index = rows.findIndex((row) => row.id === id);
    if (req.method === 'GET') {
      if (index < 0) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, rowToSequence(rows[index]));
    }
    if (req.method === 'PUT') {
      if (!/^[a-z0-9][a-z0-9_]*\/[a-z0-9][a-z0-9_.-]*$/.test(id)) {
        return sendJson(res, 400, { error: 'In a benchmark dataset a test is saved as <config>/<name>, lower case' });
      }
      const row = sequenceToRow(id, parsed, index >= 0 ? rows[index] : null);
      if (index >= 0) rows[index] = row; else rows.push(row);
      writeRows(SUITE_DIR, rows.filter((r) => r.config === row.config));
      return sendJson(res, 200, { ok: true, file, entry: suiteEntries().find((f) => f.file === file) });
    }
    if (req.method === 'DELETE') {
      if (index < 0) return sendJson(res, 404, { error: 'Not found' });
      const [removed] = rows.splice(index, 1);
      writeRows(SUITE_DIR, rows.filter((r) => r.config === removed.config), { configs: [removed.config] });
      return sendJson(res, 200, { ok: true, file });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
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

  function listSequences() {
    return listSequenceEntries(SEQ_DIR);
  }

  async function handleSequences(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    try {
      if (req.method === 'GET' && !file) {
        sendJson(res, 200, { files: SUITE_DIR ? suiteEntries() : listSequences() });
        return;
      }
      if (file && !FILENAME_RE.test(file)) {
        sendJson(res, 400, { error: 'Invalid filename (use letters, digits, _ , - and .json)' });
        return;
      }
      if (SUITE_DIR) {
        let parsed = null;
        if (req.method === 'PUT') {
          try {
            parsed = validateSequence(await readRequestJson(req));
          } catch (e) {
            sendJson(res, 400, { error: e.message });
            return;
          }
        }
        handleSuiteSequences(req, res, file, parsed);
        return;
      }
      const filePath = file ? resolve(SEQ_DIR, file) : null;
      if (filePath && !isWithinDirectory(SEQ_DIR, filePath)) {
        sendJson(res, 400, { error: 'Invalid path' });
        return;
      }
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
        try {
          parsed = await readRequestJson(req);
        } catch (e) {
          sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
          return;
        }
        let clean;
        try {
          clean = validateSequence(parsed);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(clean, null, 2) + '\n', 'utf8');
        sendJson(res, 200, { ok: true, file, entry: listSequences().find((f) => f.file === file) });
        return;
      }
      if (req.method === 'DELETE') {
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
  // ---- Model catalog (/api/models): ONNX checkpoints for benchmarking ----
  function listModels() {
    return discoverModels(modelLibraryDir, modelRootNames);
  }

  // ---- Benchmark results (/api/benchmarks): saved run reports ----
  function listBenchmarks() {
    if (!existsSync(BENCH_DIR)) return [];
    const out = [];
    walkJson(BENCH_DIR, '', (rel, full) => {
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

  async function handleBenchmarks(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    try {
      if (req.method === 'GET' && !file) { sendJson(res, 200, { files: listBenchmarks() }); return; }
      if (file && !FILENAME_RE.test(file)) { sendJson(res, 400, { error: 'Invalid filename' }); return; }
      const filePath = file ? resolve(BENCH_DIR, file) : null;
      if (filePath && !isWithinDirectory(BENCH_DIR, filePath)) { sendJson(res, 400, { error: 'Invalid path' }); return; }
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
  // ---- end sequences ----

  return {
    name: 'humanoid-dev-endpoints',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (pathname.startsWith('/model-library/')) {
          const relativeModelPath = pathname.slice('/model-library/'.length);
          const filePath = modelLibraryDir ? resolve(modelLibraryDir, relativeModelPath) : null;
          const resolvedFilePath = filePath && existsSync(filePath) ? realpathSync(filePath) : null;
          if (!resolvedFilePath || !modelRoots.some((modelRoot) => isWithinDirectory(modelRoot.realDirectory, resolvedFilePath)) || !statSync(resolvedFilePath).isFile()) {
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
        if (pathname === '/api/sequences') {
          await handleSequences(req, res);
          return;
        }
        if (pathname === '/api/models') {
          sendJson(res, 200, { models: listModels() });
          return;
        }
        if (pathname === '/api/benchmarks') {
          await handleBenchmarks(req, res);
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
      // Saving trajectory/benchmark JSON must not trigger a full page reload
      ignored: ['**/benchmark/**', '**/benchmark_runs/**'],
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
