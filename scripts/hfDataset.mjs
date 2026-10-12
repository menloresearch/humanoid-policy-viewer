// Fetches a benchmark dataset (suite.yaml + data/**/test.jsonl, see suiteDir.mjs)
// from Hugging Face into <cache>/hf-datasets/<org>__<name>/<sha>/. A commit
// never changes, so a revision already in the cache is used as is, and a run
// always records the exact dataset commit it used.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defaultCacheDir, downloadFile } from './hfModel.mjs';

export const DATASET_META_FILE = '.hf-dataset.json';

// Only what the runner and suite tooling read; never large data files.
export function datasetFilesToFetch(files) {
  return files.filter((file) => file === 'suite.yaml'
    || file === 'eval.yaml'
    || file === 'README.md'
    || /^suites\/[^/]+\.ya?ml$/.test(file)
    || /^data\/[^/]+\/test\.jsonl$/.test(file));
}

export function hubSettings(env = process.env) {
  return {
    endpoint: (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, ''),
    token: env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || null,
  };
}

export async function fetchDatasetInfo(id, revision, { endpoint, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${endpoint}/api/datasets/${id}/revision/${encodeURIComponent(revision)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401 || response.status === 404) {
    throw new Error(`Hugging Face dataset ${id}@${revision} was not found, or it is private (set HF_TOKEN to use a private dataset)`);
  }
  if (!response.ok) throw new Error(`Hugging Face API returned ${response.status} for dataset ${id}@${revision}`);
  const info = await response.json();
  return { id: info.id ?? id, sha: info.sha, files: (info.siblings ?? []).map((s) => s.rfilename) };
}

/** Downloads (or reuses) the dataset at `revision` and returns { dir, id, sha, revision }. */
export async function ensureDataset(id, {
  revision = 'main',
  cacheDir = defaultCacheDir(),
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const { endpoint, token } = hubSettings(env);
  const info = await fetchDatasetInfo(id, revision, { endpoint, token, fetchImpl });
  const dir = join(cacheDir, 'hf-datasets', info.id.replace('/', '__'), info.sha);
  if (existsSync(join(dir, DATASET_META_FILE))) {
    log(`Using cached datasets/${info.id} (${info.sha.slice(0, 7)})`);
    return { dir, id: info.id, sha: info.sha, revision };
  }
  const wanted = datasetFilesToFetch(info.files);
  if (!wanted.includes('suite.yaml')) throw new Error(`datasets/${info.id}@${revision} has no suite.yaml, so it is not a humanoid-policy-viewer benchmark`);
  const staging = `${dir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const file of wanted) {
      const destination = resolve(staging, file);
      if (!destination.startsWith(resolve(staging) + sep)) throw new Error(`Refusing unsafe path from the Hub: ${file}`);
      log(`Downloading datasets/${info.id}/${file}`);
      const path = file.split('/').map(encodeURIComponent).join('/');
      await downloadFile(`${endpoint}/datasets/${info.id}/resolve/${info.sha}/${path}`, destination, { token, fetchImpl });
    }
    writeFileSync(join(staging, DATASET_META_FILE), JSON.stringify({ id: info.id, revision, sha: info.sha, files: wanted }, null, 2) + '\n');
    mkdirSync(join(dir, '..'), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return { dir, id: info.id, sha: info.sha, revision };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
