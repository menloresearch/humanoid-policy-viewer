// Fetches a policy from Hugging Face into a local cache laid out as a viewer
// policy library (see policyLibraryConfig.mjs): <cache>/hf/<org>__<name>/.
// The dev server then serves it under /policy-library/hf/<org>__<name>/ and
// lists it in /api/policies, with no HF-specific code in the browser.

import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { policyFileCandidates } from '../src/simulation/envPolicyConfig.js';
import { hubToken } from './hfAuth.mjs';

export const HF_POLICY_ROOT = 'hf';
export const HF_META_FILE = '.hf-meta.json';
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeRepoId(input) {
  const id = String(input ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^models\//, '')
    .replace(/\/+$/, '');
  if (!REPO_ID_RE.test(id)) {
    throw new Error(`"${input}" is not a Hugging Face repo id (expected <org>/<name>, e.g. Menlo/asimov1-locomotion-0818)`);
  }
  return id;
}

export function defaultCacheDir(env = process.env) {
  if (env.HPV_CACHE_DIR) return resolve(env.HPV_CACHE_DIR);
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'humanoid-policy-viewer');
}

// Every ONNX in the repo, plus the training config (env.yaml supplies the gains,
// agent.yaml is only checked for presence) and, when present, the policy's
// tracking_policy.json (its overrides of the base policy config).
export function selectFiles(files) {
  const onnx = files.filter((f) => f.toLowerCase().endsWith('.onnx')).sort();
  if (onnx.length === 0) throw new Error('The repo contains no .onnx file');
  const present = (name) => policyFileCandidates(name).filter((f) => files.includes(f));
  return {
    onnx,
    env: present('env.yaml'),
    agent: present('agent.yaml'),
    policyConfig: present('tracking_policy.json'),
    primary: onnx.includes('policy.onnx') ? 'policy.onnx' : onnx[0],
  };
}

function readMeta(policyDir) {
  try { return JSON.parse(readFileSync(join(policyDir, HF_META_FILE), 'utf8')); } catch { return null; }
}

// The Hub answers 401 (not 404) for a repo that is missing or private, and for any repo when the token is bad.
export function notFoundHint(token) {
  return token
    ? 'was not found, or your Hugging Face token cannot read it (private, or the token is expired: log in again with hf auth login or a new HF_TOKEN)'
    : 'was not found, or it is private (log in with hf auth login, or set HF_TOKEN)';
}

async function fetchRepoInfo(repo, revision, { endpoint, token, fetchImpl }) {
  const response = await fetchImpl(`${endpoint}/api/models/${repo}/revision/${encodeURIComponent(revision)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401 || response.status === 404) {
    throw new Error(`Hugging Face repo ${repo}@${revision} ${notFoundHint(token)}`);
  }
  if (!response.ok) throw new Error(`Hugging Face API returned ${response.status} for ${repo}@${revision}`);
  const info = await response.json();
  return {
    id: info.id ?? repo,
    sha: info.sha,
    libraryName: info.library_name ?? info.cardData?.library_name ?? null,
    files: info.siblings.map((s) => s.rfilename),
  };
}

export async function downloadFile(url, destination, { token, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/**
 * Makes `repo` available under <cacheDir>/hf/ and returns where it is and which
 * ONNX to run. Re-downloads only when the revision's commit changed; if the Hub
 * is unreachable, a previous download is used instead.
 */
export async function ensurePolicy(repo, {
  revision = 'main',
  cacheDir = defaultCacheDir(),
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const endpoint = (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
  const { token } = hubToken(env);
  const layout = (id) => {
    const dirName = id.replace('/', '__');
    return { dirName, policyDir: join(cacheDir, HF_POLICY_ROOT, dirName) };
  };
  const result = (id, meta, cached) => {
    const { dirName, policyDir } = layout(id);
    return { cacheDir, policyDir, ...meta, cached, policyValue: `lib:${HF_POLICY_ROOT}/${dirName}/${meta.primary}` };
  };

  let info;
  try {
    info = await fetchRepoInfo(repo, revision, { endpoint, token, fetchImpl });
  } catch (error) {
    const previous = readMeta(layout(repo).policyDir);
    // A TypeError is fetch's "could not reach the server"; HTTP errors are not retried from cache.
    if (error instanceof TypeError && previous) {
      log(`Hugging Face is unreachable; using the cached copy of ${repo} (${previous.sha.slice(0, 7)})`);
      return result(repo, previous, true);
    }
    throw error;
  }

  // The Hub matches repo ids case-insensitively; key the cache on its spelling.
  const id = info.id;
  const { policyDir } = layout(id);
  const previous = readMeta(policyDir);
  const { onnx, env: envFiles, agent: agentFiles, policyConfig, primary } = selectFiles(info.files);
  const wanted = [...onnx, ...envFiles, ...agentFiles, ...policyConfig];
  // A copy cached by an older version may lack files that are wanted now.
  if (previous?.sha === info.sha && wanted.every((file) => previous.files?.includes(file))) {
    log(`Using cached ${id} (${info.sha.slice(0, 7)})`);
    return result(id, { ...previous, libraryName: info.libraryName }, true);
  }

  const staging = `${policyDir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const file of wanted) {
      const destination = resolve(staging, file);
      if (!destination.startsWith(resolve(staging) + sep)) throw new Error(`Refusing unsafe path from the Hub: ${file}`);
      log(`Downloading ${id}/${file}`);
      const path = file.split('/').map(encodeURIComponent).join('/');
      await downloadFile(`${endpoint}/${id}/resolve/${info.sha}/${path}`, destination, { token, fetchImpl });
    }
    const meta = { repo: id, revision, sha: info.sha, libraryName: info.libraryName, primary, onnx, files: wanted };
    writeFileSync(join(staging, HF_META_FILE), JSON.stringify(meta, null, 2) + '\n');
    rmSync(policyDir, { recursive: true, force: true });
    renameSync(staging, policyDir);
    return result(id, meta, false);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
