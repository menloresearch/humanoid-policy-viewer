// Starts the viewer's dev server in this process. Every launcher goes through
// here (`npm run dev`, `npm run hf`, the benchmark runner); the settings reach
// the server as options (see viewerServer.mjs), not through process.env.
// It imports Vite, so call scripts/setup.mjs first on a fresh checkout.
//
//   policies       Hugging Face policies to download first ("org/name[@rev]"); listed either way
//   benchmark      the benchmark the app opens first: a folder (editable), or datasets/<org>/<name>[@rev],
//                  downloaded into the cache and opened read-only (default ./benchmarks/default)
//   policyLibrary  { dir, roots } to serve; by default the HPV_POLICY_* variables if set, else
//                  a folder of links to ./policies and every downloaded Hugging Face policy
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
import { HF_POLICY_ROOT, defaultCacheDir, ensurePolicy, normalizeRepoId } from './hfPolicy.mjs';
import { checkPolicyDir, readReferenceJointNames } from './policyChecks.mjs';
import { DEFAULT_POLICY_ROOT, readEnv } from './policyLibraryConfig.mjs';

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
  for (const word of policies) await fetchPolicy(word, { cacheDir, env, log });

  const options = serverOptionsFromEnv(env);
  if (resultsDir) options.resultsDir = resolve(resultsDir);
  if (policyLibrary) {
    options.policyLibraryDir = resolve(policyLibrary.dir);
    options.policyRoots = policyLibrary.roots;
  } else if (readEnv(env, 'HPV_POLICY_LIBRARY_DIR', log) === undefined && readEnv(env, 'HPV_POLICY_ROOTS', log) === undefined) {
    options.policyLibraryDir = linkedLibrary(cacheDir);
    options.policyRoots = [DEFAULT_POLICY_ROOT, HF_POLICY_ROOT];
  }
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
async function resolveBenchmark(word, { cacheDir, env, log }) {
  if (!word) return defaultBenchmarkDir(appDir);
  const target = isHubDataset(word) ? classifyTarget(word) : null;
  if (target?.kind === 'benchmark' && target.source === 'hub') {
    const dataset = await ensureDataset(target.id, { revision: target.revision ?? 'main', cacheDir, env, log });
    log(`Opening datasets/${dataset.id}@${dataset.sha.slice(0, 7)} read-only (downloaded from Hugging Face)`);
    return dataset.dir;
  }
  const dir = resolve(word);
  if (!existsSync(join(dir, BENCHMARK_FILE))) {
    throw new Error(`${dir} has no benchmark.yaml. Create a benchmark with \`npm run benchmark init ${dir}\`, or open one from Hugging Face with benchmark=datasets/<org>/<name>.`);
  }
  return dir;
}

// "datasets/org/name[@rev]" or a huggingface.co/datasets/... URL, not a path that happens to exist on disk.
function isHubDataset(text) {
  if (existsSync(resolve(text))) return false;
  return /^datasets\//.test(text) || /huggingface\.co\/datasets\/|hf\.co\/datasets\//.test(text);
}

/** Downloads one Hugging Face policy into the cache. */
async function fetchPolicy(word, { cacheDir, env, log }) {
  const [repo, revision] = word.split('@');
  const policy = await ensurePolicy(normalizeRepoId(repo), { revision: revision || 'main', cacheDir, env, log });
  log(`${policy.cached ? 'Cached' : 'Downloaded'} policy ${policy.repo}@${policy.sha.slice(0, 7)}`);
  // Listed either way; the viewer refuses a policy it would run wrongly when it is picked.
  const { errors, warnings } = checkPolicyDir(policy.policyDir, readReferenceJointNames(appDir));
  for (const problem of [...errors, ...warnings]) console.warn(`  ${errors.includes(problem) ? 'Error' : 'Warning'}: ${problem}`);
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
