// Client for the /api/results endpoint (scripts/viewerServer.mjs): benchmark
// results, each a <timestamp>/result.json under ./benchmark_results, from the
// viewer's Run or `npm run benchmark` alike. The policy catalog's client is
// policyStore.js.
//
// In static mode (vite build --mode static, VITE_VIEWER_MODE=static), the
// endpoint is unavailable; instead, static JSON is fetched from /static-data/.

import { STATIC } from './viewerMode.js';

const RESULTS_API = STATIC ? '/static-data/result.json' : '/api/results';
// listResults() only needs this small summary, not the (often multi-MB)
// full result RESULTS_API points at in static mode.
const RESULTS_INDEX_API = '/static-data/results.json';

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function listResults() {
  if (STATIC) {
    // The small index build-static-catalog.mjs derives from the result, so
    // listing doesn't require downloading the full (often multi-MB) result
    // just to read a handful of summary fields off it.
    const response = await fetch(RESULTS_INDEX_API);
    if (!response.ok) throw new Error(await parseError(response));
    return [await response.json()];
  }

  const response = await fetch(RESULTS_API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.files) ? body.files : [];
}

export async function loadResult(file) {
  if (STATIC) {
    // In static mode, ignore the file param and just load the static result JSON.
    const response = await fetch(RESULTS_API);
    if (!response.ok) throw new Error(await parseError(response));
    return response.json();
  }

  const response = await fetch(`${RESULTS_API}?file=${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

/**
 * Saves a Run's result (the result.json shape of src/benchmark/run.js) as a new
 * <timestamp>/result.json; the server adds provenance and policy file hashes.
 * Returns that file's name.
 */
export async function postResult(result) {
  const response = await fetch(RESULTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result)
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()).file;
}

export async function deleteResult(file) {
  const response = await fetch(`${RESULTS_API}?file=${encodeURIComponent(file)}`, {
    method: 'DELETE'
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}
