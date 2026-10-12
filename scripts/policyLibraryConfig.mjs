// Where the viewer finds policy folders and saved benchmark results. By default
// it looks in the policies/ folder next to package.json; a repo that embeds the
// viewer can point it elsewhere through environment variables. Paths should be
// absolute (relative ones resolve against the process's working directory).
//
//   HPV_POLICY_LIBRARY_DIR  directory that contains the policy root folders
//                           (default: this app's directory)
//   HPV_POLICY_ROOTS        comma-separated folder names under that directory
//                           (each becomes /policy-library/<root>/...);
//                           default: policies. Set it empty to disable the library
//   HPV_BENCHMARK_RESULTS_DIR  where saved benchmark results are listed/read/written
//                              (default: <app>/benchmark_results)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_POLICY_ROOT = 'policies';

export function getPolicyLibrary(env = process.env) {
  const baseDir = resolve(env.HPV_POLICY_LIBRARY_DIR || APP_DIR);
  const roots = (env.HPV_POLICY_ROOTS ?? DEFAULT_POLICY_ROOT)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { baseDir, roots };
}

export function getBenchmarkResultsDir(appDir, env = process.env) {
  return env.HPV_BENCHMARK_RESULTS_DIR
    ? resolve(env.HPV_BENCHMARK_RESULTS_DIR)
    : resolve(appDir, 'benchmark_results');
}
