// Where the viewer finds checkpoint folders and saved benchmark runs. The
// viewer assumes nothing about the repo around it: whoever embeds it opts in
// through environment variables. Paths should be absolute (relative ones
// resolve against the process's working directory).
//
//   HPV_MODEL_LIBRARY_DIR   directory that contains the model root folders
//   HPV_MODEL_ROOTS         comma-separated folder names under that directory
//                           (each becomes /model-library/<root>/...)
//   HPV_BENCHMARK_RUNS_DIR  where saved benchmark runs are listed/read/written
//                           (default: <app>/benchmark_runs)

import { resolve } from 'node:path';

export function getModelLibrary(env = process.env) {
  const baseDir = env.HPV_MODEL_LIBRARY_DIR ? resolve(env.HPV_MODEL_LIBRARY_DIR) : null;
  const roots = (env.HPV_MODEL_ROOTS ?? '')
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
