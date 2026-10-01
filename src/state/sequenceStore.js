// Client for the /api/sequences filesystem persistence endpoint (served by
// vite-plugin-sequences during dev/preview). All trajectory files — bundled
// synthetic tests, manual recordings, and newly authored sequences — live on
// disk under ./sequences and are read/written through here.
//
// There is no such filesystem behind the static (Cloudflare Pages) build.
// build-static-catalog.mjs bakes ./benchmark's bundled tests into
// /static-data/sequences.json at build time, so browsing/loading a test still
// works there (fetched once and cached below); only *writing* — saving edits
// or deleting a test — has no static equivalent and still throws. Edits made
// in the trajectory editor survive via its "Export JSON" download instead.

import { STATIC } from './viewerMode.js';

const API = '/api/sequences';
const STATIC_SEQUENCES_URL = '/static-data/sequences.json';
const STATIC_SAVE_UNAVAILABLE = "Static deployments can't save to disk — use \"Export JSON\" to download your edits instead.";
const STATIC_DELETE_UNAVAILABLE = "Static deployments can't delete files — this is the read-only bundle built by CI.";

let staticCatalogPromise = null;
/** Fetches and caches /static-data/sequences.json for the lifetime of the page. */
function loadStaticCatalog() {
  if (!staticCatalogPromise) {
    staticCatalogPromise = fetch(STATIC_SEQUENCES_URL).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load ${STATIC_SEQUENCES_URL} (${response.status})`);
      return response.json();
    });
  }
  return staticCatalogPromise;
}

export function slugify(name) {
  const base = String(name || 'sequence')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return (base || 'sequence') + '.json';
}

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function listSequences() {
  if (STATIC) {
    const catalog = await loadStaticCatalog();
    return Array.isArray(catalog.files) ? catalog.files : [];
  }
  const response = await fetch(API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.files) ? body.files : [];
}

export async function loadSequenceFile(file) {
  if (STATIC) {
    const catalog = await loadStaticCatalog();
    const sequence = catalog.data?.[file];
    if (!sequence) throw new Error(`${file} not found in the static bundle`);
    return sequence;
  }
  const response = await fetch(`${API}?file=${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function saveSequenceFile(file, sequence) {
  if (STATIC) throw new Error(STATIC_SAVE_UNAVAILABLE);
  const response = await fetch(`${API}?file=${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sequence)
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function deleteSequenceFile(file) {
  if (STATIC) throw new Error(STATIC_DELETE_UNAVAILABLE);
  const response = await fetch(`${API}?file=${encodeURIComponent(file)}`, {
    method: 'DELETE'
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}
