// Client for the /api/tests endpoint of the dev server (vite.config.mjs),
// which reads and writes the tests of a benchmark folder: each test is
// "<category>/<name>.json" here and one row of data/<category>/test.jsonl on disk.
// The dev server knows several benchmarks (/api/benchmarks); every call below goes
// to the one open in the browser, appState.currentBenchmark (null: the server's
// default, the one `npm run dev benchmark=` named).
//
// There is no such filesystem behind the static build. The embedding repo's
// static build bakes a test listing into /static-data/tests.json, so browsing/loading a test still
// works there (fetched once and cached below); only *writing* — saving edits
// or deleting a test — has no static equivalent and still throws. Edits made
// in the trajectory editor survive via its "Export JSON" download instead.

import { appState } from './appState.js';
import { STATIC } from './viewerMode.js';

const API = '/api/tests';
const BENCHMARKS_API = '/api/benchmarks';
const STATIC_TESTS_URL = '/static-data/tests.json';
const STATIC_SAVE_UNAVAILABLE = "Static deployments can't save to disk — use \"Export JSON\" to download your edits instead.";
const STATIC_DELETE_UNAVAILABLE = "Static deployments can't delete files — this is the read-only bundle built by CI.";

let staticCatalogPromise = null;
/** Fetches and caches /static-data/tests.json for the lifetime of the page. */
function loadStaticCatalog() {
  if (!staticCatalogPromise) {
    staticCatalogPromise = fetch(STATIC_TESTS_URL).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load ${STATIC_TESTS_URL} (${response.status})`);
      return response.json();
    });
  }
  return staticCatalogPromise;
}

export function slugify(name) {
  const base = String(name || 'test')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return (base || 'test') + '.json';
}

/** Query string for `file` (optional) in the open benchmark. */
function query(file = null) {
  const params = new URLSearchParams();
  if (appState.currentBenchmark) params.set('benchmark', appState.currentBenchmark);
  if (file) params.set('file', file);
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function listTests() {
  if (STATIC) {
    const catalog = await loadStaticCatalog();
    return Array.isArray(catalog.files) ? catalog.files : [];
  }
  const response = await fetch(`${API}${query()}`);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.files) ? body.files : [];
}

/**
 * The benchmarks there are: [{ key, title, description, testCount, session }].
 * A static deployment has just its bundled tests, as one benchmark.
 */
export async function listBenchmarks() {
  if (STATIC) {
    const catalog = await loadStaticCatalog();
    const files = Array.isArray(catalog.files) ? catalog.files : [];
    return [{ key: null, title: 'Tests', description: '', testCount: files.length, session: true }];
  }
  const response = await fetch(BENCHMARKS_API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.benchmarks) ? body.benchmarks : [];
}

/** Creates an empty benchmark named `name` (lower case, digits, -) and returns it. */
export async function createBenchmark(name, title = '') {
  if (STATIC) throw new Error("Static deployments can't create benchmarks.");
  const response = await fetch(BENCHMARKS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title })
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()).benchmark;
}

const BENCHMARK_API = '/api/benchmark';
const benchmarkFileUrl = (benchmark) => (benchmark ? `${BENCHMARK_API}?${new URLSearchParams({ benchmark })}` : BENCHMARK_API);

/**
 * benchmark.yaml of benchmark `benchmark` (a key; null: the server's default):
 * { text, fields, errors, warnings, configs, testIds }.
 */
export async function loadBenchmarkSettings(benchmark) {
  if (STATIC) throw new Error("Static deployments can't read benchmark.yaml.");
  const response = await fetch(benchmarkFileUrl(benchmark));
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

/**
 * Saves `edit` ({ fields } from the settings form, or { text }) over the
 * benchmark.yaml text `base` it was made from. Throws listing every problem when
 * the result would not be a valid benchmark; returns what loadBenchmarkSettings does.
 */
export async function saveBenchmarkSettings(benchmark, edit, base) {
  if (STATIC) throw new Error("Static deployments can't save benchmark.yaml.");
  const response = await fetch(benchmarkFileUrl(benchmark), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...edit, base })
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function loadTest(file) {
  if (STATIC) {
    const catalog = await loadStaticCatalog();
    const sequence = catalog.data?.[file];
    if (!sequence) throw new Error(`${file} not found in the static bundle`);
    return sequence;
  }
  const response = await fetch(`${API}${query(file)}`);
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function saveTest(file, sequence) {
  if (STATIC) throw new Error(STATIC_SAVE_UNAVAILABLE);
  const response = await fetch(`${API}${query(file)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sequence)
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function deleteTest(file) {
  if (STATIC) throw new Error(STATIC_DELETE_UNAVAILABLE);
  const response = await fetch(`${API}${query(file)}`, {
    method: 'DELETE'
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}
