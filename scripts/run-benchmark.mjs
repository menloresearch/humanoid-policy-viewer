#!/usr/bin/env node
// Headless driver for the humanoid-policy-viewer benchmark suite.
//
// Boots a Vite dev server (the /api/models, /api/sequences and /api/benchmarks
// endpoints only exist under `vite dev` — see humanoidDevPlugin in
// vite.config.mjs — not under `vite build` + `preview`), opens it in headless
// Chromium, waits for the MuJoCo demo + model catalog to finish loading, then
// calls the app's window.__runHeadlessBenchmark(...) hook (src/views/Demo.vue)
// and writes the returned results JSON to disk.
//
// One process = one shard. Parallelism across policies comes from running
// multiple instances of this script concurrently (each gets its own Vite
// server + browser, since a single page can only host one live MuJoCoDemo),
// which is how a CI matrix can shard a suite.
//
// Usage:
//   node scripts/run-benchmark.mjs --out benchmark_runs/run_ci.json
//   node scripts/run-benchmark.mjs --policies "ckpt:<root>/a/x.onnx,ckpt:<root>/b/y.onnx" --out out.json
//   node scripts/run-benchmark.mjs --tests "circle.json,push_recovery.json" --out out.json
//
// With no --policies, benchmarks every ONNX checkpoint discovered under the
// model roots configured by HPV_MODEL_LIBRARY_DIR / HPV_MODEL_ROOTS
// (scripts/modelLibraryConfig.mjs).
// With no --tests, benchmarks every committed benchmark/*.json test.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels } from './modelDiscovery.mjs';
import { getBenchmarkRunsDir, getModelLibrary } from './modelLibraryConfig.mjs';
import { splitCsv } from './cliArgs.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..'); // humanoid-policy-viewer/

// A cold WASM + ONNX Runtime Web init plus model catalog fetch can take a
// while on a CI runner with no warm disk cache; fail loudly rather than hang
// the job forever if it never gets there.
const DEMO_READY_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const args = { policies: null, tests: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policies') args.policies = splitCsv(argv[++i]);
    else if (arg === '--tests') args.tests = splitCsv(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function defaultOutPath() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
  return resolve(getBenchmarkRunsDir(appDir), `run_${stamp}_ci.json`);
}

function summarizeProblems(results) {
  const problems = [];
  for (const r of results?.results ?? []) {
    if (r.error) problems.push(`${r.policyId} / ${r.testFile}: ${r.error}`);
    else if (r.warning) problems.push(`${r.policyId} / ${r.testFile}: ${r.warning}`);
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolve(process.cwd(), args.out ?? defaultOutPath());

  const library = getModelLibrary();
  const policyValues = args.policies?.length
    ? args.policies
    : listModels(library.baseDir, library.roots).map((model) => `ckpt:${model.path}`);
  if (!policyValues.length) {
    throw new Error('No policies to benchmark: no --policies given and no *.onnx found under HPV_MODEL_LIBRARY_DIR/HPV_MODEL_ROOTS.');
  }

  console.log(`[run-benchmark] policies: ${policyValues.join(', ')}`);
  console.log(`[run-benchmark] tests: ${args.tests?.length ? args.tests.join(', ') : '(all committed benchmark/*.json)'}`);

  const server = await createServer({
    root: appDir,
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`[run-benchmark] dev server up at ${url}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.error('[browser:pageerror]', err));

    await page.goto(url, { waitUntil: 'load' });

    // modelCatalog starts as `[]` (already an array) and is populated by an
    // un-awaited fetchModelCatalog() call fired just before state flips to 1 —
    // Array.isArray() alone races ahead of the catalog actually landing, so
    // require at least one discovered checkpoint too.
    // waitForFunction's signature is (pageFunction, arg, options) — arg is
    // positional and required even when the predicate ignores it. Passing
    // only two arguments makes the options object get treated as `arg`
    // instead, silently falling back to Playwright's default 30s timeout;
    // that stayed hidden locally (a warm cache made the demo ready well
    // under 30s) but broke every job on a cold CI runner.
    await page.waitForFunction(
      () => {
        const component = window.__humanoidViewerDemoComponent;
        return !!(component && component.state === 1 && component.modelCatalog?.length > 0 && typeof window.__runHeadlessBenchmark === 'function');
      },
      undefined,
      { timeout: DEMO_READY_TIMEOUT_MS, polling: 250 }
    );
    console.log('[run-benchmark] demo ready, starting benchmark');

    const results = await page.evaluate(
      ([policies, tests]) => window.__runHeadlessBenchmark(policies, tests),
      [policyValues, args.tests]
    );

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(results));
    console.log(`[run-benchmark] wrote ${outPath} (${results.results?.length ?? 0} result cells)`);

    const problems = summarizeProblems(results);
    if (problems.length) {
      console.error(`[run-benchmark] ${problems.length} cell(s) had errors/warnings:`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error('[run-benchmark] failed:', error);
  process.exitCode = 1;
});
