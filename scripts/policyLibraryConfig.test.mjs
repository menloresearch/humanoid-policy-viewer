import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getBenchmarkResultsDir, getBenchmarkTemplate, getLogDir, getPolicyLibrary, readEnv } from './policyLibraryConfig.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

test('with no variables the library is policies/ next to package.json', () => {
  assert.deepEqual(getPolicyLibrary({}), { baseDir: appDir, roots: ['policies'] });
});

test('the variables override the directory and the roots independently', () => {
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_LIBRARY_DIR: '/data', HPV_POLICY_ROOTS: 'a, b' }), { baseDir: resolve('/data'), roots: ['a', 'b'] });
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_LIBRARY_DIR: '/data' }), { baseDir: resolve('/data'), roots: ['policies'] });
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_ROOTS: 'mine' }), { baseDir: appDir, roots: ['mine'] });
});

test('the pre-rename variable names still work, with one warning each; the new name wins', () => {
  const warnings = [];
  const warn = (line) => warnings.push(line);
  assert.equal(readEnv({ HPV_POLICY_ROOTS: 'new', HPV_MODEL_ROOTS: 'old' }, 'HPV_POLICY_ROOTS', warn), 'new');
  assert.equal(readEnv({}, 'HPV_POLICY_ROOTS', warn), undefined);
  assert.deepEqual(warnings, []);
  const old = { HPV_MODEL_LIBRARY_DIR: '/data', HPV_MODEL_ROOTS: 'a', HPV_BENCHMARK_RUNS_DIR: '/runs' };
  for (const name of ['HPV_POLICY_LIBRARY_DIR', 'HPV_POLICY_ROOTS', 'HPV_BENCHMARK_RESULTS_DIR', 'HPV_POLICY_ROOTS']) readEnv(old, name, warn);
  assert.deepEqual(warnings, [
    'Warning: HPV_MODEL_LIBRARY_DIR is now HPV_POLICY_LIBRARY_DIR; the old name still works for now.',
    'Warning: HPV_MODEL_ROOTS is now HPV_POLICY_ROOTS; the old name still works for now.',
    'Warning: HPV_BENCHMARK_RUNS_DIR is now HPV_BENCHMARK_RESULTS_DIR; the old name still works for now.',
  ]);
  assert.deepEqual(getPolicyLibrary(old), { baseDir: resolve('/data'), roots: ['a'] });
  assert.equal(getBenchmarkResultsDir(appDir, old), resolve('/runs'));
});

test('an empty HPV_POLICY_ROOTS turns the library off', () => {
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_ROOTS: '' }).roots, []);
});

test('results, the benchmark template and logs default to the checkout and follow their variables', () => {
  assert.equal(getBenchmarkResultsDir(appDir, {}), resolve(appDir, 'benchmark_results'));
  assert.equal(getBenchmarkResultsDir(appDir, { HPV_BENCHMARK_RESULTS_DIR: '/r' }), resolve('/r'));
  assert.equal(getBenchmarkTemplate(appDir, {}), resolve(appDir, 'benchmarks', 'default'));
  assert.equal(getBenchmarkTemplate(appDir, { HPV_BENCHMARK_TEMPLATE: '/t' }), resolve('/t'));
  assert.equal(getLogDir(appDir, {}), resolve(appDir, 'logs'));
  assert.equal(getLogDir(appDir, { HPV_LOG_DIR: '/l' }), resolve('/l'));
});
