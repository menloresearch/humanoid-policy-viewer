// Where the viewer finds checkpoint folders and saved benchmark runs. By default
// it looks in the models/ folder next to package.json; a repo that embeds the
// viewer can point it elsewhere through environment variables. Paths should be
// absolute (relative ones resolve against the process's working directory).
//
//   HPV_MODEL_LIBRARY_DIR   directory that contains the model root folders
//                           (default: this app's directory)
//   HPV_MODEL_ROOTS         comma-separated folder names under that directory
//                           (each becomes /model-library/<root>/...);
//                           default: models. Set it empty to disable the library
//   HPV_BENCHMARK_RUNS_DIR  where saved benchmark runs are listed/read/written
//                           (default: <app>/benchmark_runs)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MODEL_ROOT = 'models';

export function getModelLibrary(env = process.env) {
  const baseDir = resolve(env.HPV_MODEL_LIBRARY_DIR || APP_DIR);
  const roots = (env.HPV_MODEL_ROOTS ?? DEFAULT_MODEL_ROOT)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { baseDir, roots };
}

export function getBenchmarkRunsDir(appDir, env = process.env) {
  return env.HPV_BENCHMARK_RUNS_DIR
    ? resolve(env.HPV_BENCHMARK_RUNS_DIR)
    : resolve(appDir, 'benchmark_runs');
}
