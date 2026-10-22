// Starts the viewer's dev server in this process. Every launcher goes through
// here (`npm run dev`, `npm run hf`, the benchmark runner); the settings reach
// the server as options (see viewerServer.mjs), not through process.env.
// It imports Vite, so call scripts/setup.mjs first on a fresh checkout.
//
//   policies       policies to list besides the library (`npm run dev`), as words or classified
//                  targets (benchmarkTargets.mjs): Hub ones are downloaded first, local ones (a
//                  policy folder, an .onnx or a folder of policies) linked into a temporary library
//   benchmark      the benchmark the app opens first, a word or a classified target: a folder
//                  (editable), or datasets/<org>/<name>[@rev], downloaded into the cache and
//                  opened read-only (default ./benchmarks/default)
//   policyLibrary  { dir, roots, labels? } to serve; by default the HPV_POLICY_* variables if set,
//                  else a folder of links to ./policies and every downloaded Hugging Face policy
//   resultsDir     where results are listed and read (default ./benchmark_results, or HPV_BENCHMARK_RESULTS_DIR)
//   host, port, open, logLevel   passed to Vite
//   editable       false serves the app read-only (no route that writes)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { serverOptionsFromEnv, viteConfig } from '../vite.config.mjs';
import { BENCHMARK_FILE, defaultBenchmarkDir } from './benchmarkDir.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { HF_POLICY_ROOT, defaultCacheDir } from './hfPolicy.mjs';
import { DEFAULT_POLICY_ROOT, readEnv } from './policyLibraryConfig.mjs';
import { cleanupOnExit, libraryFor, resolvePolicies } from './viewPolicies.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function startViewer({
  policies = [],
  benchmark = null,
  policyLibrary = null,
  resultsDir = null,
  host = '127.0.0.1',
  port,
  open = false,
  editable = true,
  logLevel,
  env = process.env,
  log = console.log,
} = {}) {
  const cacheDir = defaultCacheDir(env);
  const openBenchmark = await resolveBenchmark(benchmark, { cacheDir, env, log });

  const options = serverOptionsFromEnv(env);
  if (resultsDir) options.resultsDir = resolve(resultsDir);
  let library = policyLibrary;
  if (!library) {
    const fromEnv = readEnv(env, 'HPV_POLICY_LIBRARY_DIR', log) !== undefined || readEnv(env, 'HPV_POLICY_ROOTS', log) !== undefined;
    library = fromEnv
      ? { dir: options.policyLibraryDir, roots: options.policyRoots }
      : { dir: linkedLibrary(cacheDir), roots: [DEFAULT_POLICY_ROOT, HF_POLICY_ROOT] };
  }
  if (policies.length) library = await withPolicies(library, policies, { cacheDir, env, log });
  options.policyLibraryDir = resolve(library.dir);
  options.policyRoots = library.roots;
  options.policyLabels = library.labels ?? {};
  const config = viteConfig({ ...options, openBenchmark, editable });
  const server = await createServer({
    ...config,
    configFile: false,
    root: appDir,
    ...(logLevel ? { logLevel } : {}),
    server: { ...config.server, host, ...(port !== undefined ? { port } : {}), open },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.httpServer.address().port}/`;
  return { server, url, benchmarkDir: openBenchmark };
}

/**
 * The benchmark folder to open first. A Hugging Face dataset is downloaded into
 * the cache (or reused from it) and served from there, read-only.
 */
async function resolveBenchmark(benchmark, { cacheDir, env, log }) {
  if (!benchmark) return defaultBenchmarkDir(appDir);
  const target = typeof benchmark === 'string' ? benchmarkTarget(benchmark) : benchmark;
  if (target.source === 'hub') {
    const dataset = await ensureDataset(target.id, { revision: target.revision ?? 'main', cacheDir, env, log });
    log(`Opening datasets/${dataset.id}@${dataset.sha.slice(0, 7)} read-only (downloaded from Hugging Face)`);
    return dataset.dir;
  }
  const dir = resolve(target.path);
  if (!existsSync(join(dir, BENCHMARK_FILE))) {
    throw new Error(`${dir} has no benchmark.yaml. Create a benchmark with \`npm run benchmark init ${dir}\`, or open one from Hugging Face with benchmark=datasets/<org>/<name>.`);
  }
  return dir;
}

// A word given as the benchmark: a folder on disk, else a Hub dataset (org/name works too).
function benchmarkTarget(word) {
  if (existsSync(resolve(word))) return { kind: 'benchmark', source: 'local', path: resolve(word) };
  return { ...classifyTarget(word), kind: 'benchmark' };
}

/**
 * `library` plus the `policies` given to `npm run dev`: Hub ones downloaded into
 * the cache (listed under its hf/ root), local ones linked into a temporary
 * library beside it. Every policy is listed, problems or not; the viewer refuses
 * one it would run wrongly when it is picked.
 */
async function withPolicies(library, policies, { cacheDir, env, log }) {
  const targets = policies.map((policy) => (typeof policy === 'string' ? classifyTarget(policy) : policy));
  const found = await resolvePolicies(targets, { appDir, cacheDir, env, log });
  // A folder below a folder of policies with no single .onnx to run cannot be listed.
  const listed = found.filter((policy) => policy.primary);
  const composed = libraryFor(listed, { base: library });
  if (composed.dir !== library.dir) cleanupOnExit(composed.cleanup);
  for (const policy of found) {
    if (!policy.primary) log(`Not listed: ${policy.name}`);
    else if (policy.source === 'hub') log(`${policy.cached ? 'Cached' : 'Downloaded'} policy ${policy.repo}@${policy.sha.slice(0, 7)}`);
    else log(`Listed policy ${policy.name} as ${policy.label}`);
    for (const problem of policy.errors) console.warn(`  Error: ${problem}`);
    for (const problem of policy.warnings) console.warn(`  Warning: ${problem}`);
  }
  return composed;
}

/**
 * A folder of links to ./policies and the Hugging Face policy cache, so the
 * viewer lists both. One per checkout, so two checkouts don't share ./policies.
 */
function linkedLibrary(cacheDir) {
  const key = createHash('sha256').update(appDir).digest('hex').slice(0, 10);
  const library = join(cacheDir, 'dev-library', key);
  mkdirSync(library, { recursive: true });
  const link = (name, target) => {
    const path = join(library, name);
    try {
      if (readlinkSync(path) === target) return;
    } catch {}
    rmSync(path, { force: true });
    symlinkSync(target, path, 'dir');
  };
  link(DEFAULT_POLICY_ROOT, join(appDir, DEFAULT_POLICY_ROOT));
  link(HF_POLICY_ROOT, join(cacheDir, HF_POLICY_ROOT));
  return library;
}
