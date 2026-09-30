// Clients for the two benchmark-side dev endpoints (served by
// humanoidDevPlugin in vite.config.mjs):
//   /api/models     — ONNX checkpoints discovered in the model library
//                     (see the README), used to build the policy catalog.
//   /api/benchmarks — completed benchmark runs, stored as JSON under
//                     ./benchmarks so results survive a reload.
//
// In static mode (vite build --mode static, VITE_VIEWER_MODE=static), these
// endpoints are unavailable; instead, static JSON is fetched from /static-data/.

import { STATIC } from './viewerMode.js';

const MODELS_API = STATIC ? '/static-data/models.json' : '/api/models';
const BENCH_API = STATIC ? '/static-data/benchmark-run.json' : '/api/benchmarks';
// listBenchmarks() only needs this small summary, not the (often multi-MB)
// full run BENCH_API points at in static mode.
const BENCH_INDEX_API = '/static-data/benchmark-index.json';

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function listModels() {
  const response = await fetch(MODELS_API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.models) ? body.models : [];
}

export async function listBenchmarks() {
  if (STATIC) {
    // The small index build-static-catalog.mjs derives from the run, so
    // listing doesn't require downloading the full (often multi-MB) run
    // just to read a handful of summary fields off it.
    const response = await fetch(BENCH_INDEX_API);
    if (!response.ok) throw new Error(await parseError(response));
    return [await response.json()];
  }

  const response = await fetch(BENCH_API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.files) ? body.files : [];
}

export async function loadBenchmark(file) {
  if (STATIC) {
    // In static mode, ignore the file param and just load the static run JSON.
    const response = await fetch(BENCH_API);
    if (!response.ok) throw new Error(await parseError(response));
    return response.json();
  }

  const response = await fetch(`${BENCH_API}?file=${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function saveBenchmark(file, results) {
  const response = await fetch(`${BENCH_API}?file=${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results)
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function deleteBenchmark(file) {
  const response = await fetch(`${BENCH_API}?file=${encodeURIComponent(file)}`, {
    method: 'DELETE'
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

/** `run_20260902T101500.json` — matches the endpoint's filename rules. */
export function benchmarkFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:]/g, '');
  return `run_${stamp}.json`;
}
