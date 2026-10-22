// Where the viewer finds policy folders and keeps what it writes. By default
// everything is inside this checkout; a repo that embeds the viewer can point it
// elsewhere through environment variables (all of them are listed in
// docs/architecture.md, "Environment variables"). Paths should be absolute
// (relative ones resolve against the process's working directory).
//
//   HPV_POLICY_LIBRARY_DIR  directory that contains the policy root folders
//                           (default: this app's directory)
//   HPV_POLICY_ROOTS        comma-separated folder names under that directory
//                           (each becomes /policy-library/<root>/...);
//                           default: policies. Set it empty to disable the library
//   HPV_BENCHMARK_RESULTS_DIR  where benchmark results are listed, read and written, by the
//                              viewer and by `npm run benchmark` (default: <app>/benchmark_results)
//   HPV_BENCHMARK_TEMPLATE  the benchmark folder "New benchmark" and `npm run benchmark init`
//                           copy (default: <app>/benchmarks/default)
//   HPV_LOG_DIR             where the viewer's policy logs (/api/save-log) are written
//                           (default: <app>/logs, gitignored)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_POLICY_ROOT = 'policies';

// The variables were renamed with the policy/benchmark vocabulary; the old names keep working, with a warning.
const LEGACY_NAMES = {
  HPV_POLICY_LIBRARY_DIR: 'HPV_MODEL_LIBRARY_DIR',
  HPV_POLICY_ROOTS: 'HPV_MODEL_ROOTS',
  HPV_BENCHMARK_RESULTS_DIR: 'HPV_BENCHMARK_RUNS_DIR',
};
const warned = new Set();

/** env[name], else its pre-rename value (warning once per name); undefined when neither is set. */
export function readEnv(env, name, warn = console.warn) {
  if (env[name] !== undefined) return env[name];
  const legacy = LEGACY_NAMES[name];
  if (env[legacy] === undefined) return undefined;
  if (!warned.has(legacy)) {
    warned.add(legacy);
    warn(`Warning: ${legacy} is now ${name}; the old name still works for now.`);
  }
  return env[legacy];
}

export function getPolicyLibrary(env = process.env) {
  const baseDir = resolve(readEnv(env, 'HPV_POLICY_LIBRARY_DIR') || APP_DIR);
  const roots = (readEnv(env, 'HPV_POLICY_ROOTS') ?? DEFAULT_POLICY_ROOT)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { baseDir, roots };
}

export function getBenchmarkResultsDir(appDir, env = process.env) {
  const dir = readEnv(env, 'HPV_BENCHMARK_RESULTS_DIR');
  return dir ? resolve(dir) : resolve(appDir, 'benchmark_results');
}

export function getBenchmarkTemplate(appDir, env = process.env) {
  return env.HPV_BENCHMARK_TEMPLATE ? resolve(env.HPV_BENCHMARK_TEMPLATE) : resolve(appDir, 'benchmarks', 'default');
}

export function getLogDir(appDir, env = process.env) {
  return env.HPV_LOG_DIR ? resolve(env.HPV_LOG_DIR) : resolve(appDir, 'logs');
}
