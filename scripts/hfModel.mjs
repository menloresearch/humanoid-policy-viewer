// Fetches a policy checkpoint from Hugging Face into a local cache laid out as
// a viewer model library (see modelLibraryConfig.mjs): <cache>/hf/<org>__<name>/.
// The dev server then serves it under /model-library/hf/<org>__<name>/ and
// lists it in /api/models, with no HF-specific code in the browser.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkpointFileCandidates } from '../src/simulation/envPolicyConfig.js';

export const HF_MODEL_ROOT = 'hf';
export const HF_META_FILE = '.hf-meta.json';
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const USAGE = `Usage: npm run hf <org/name | folder | file.onnx> [-- options]

Downloads a policy from Hugging Face (policy .onnx + env.yaml) and opens the
viewer with it selected. Example: npm run hf Menlo/asimov1-locomotion-0818

A folder or .onnx file on disk is run in place instead, with no download. The
folder needs the same files as a Hub repo: the .onnx and env.yaml (or
params/env.yaml) next to it. Example: npm run hf ./my-policy

Options (npm needs the "--" before these):
  --revision <ref>     branch, tag or commit of a Hub repo (default: main)
  --port <n>           dev server port (default: 3000, or the next free one)
  --no-open            do not open a browser window

Environment:
  HF_TOKEN             access token, needed for private repos
  HF_ENDPOINT          alternative Hub endpoint (default: https://huggingface.co)
  HPV_CACHE_DIR        where downloads are kept (default: ~/.cache/humanoid-policy-viewer)`;

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

export function parseArgs(argv) {
  const args = { model: null, revision: 'main', port: null, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--model') args.model = value();
    else if (flag === '--revision') args.revision = value();
    else if (flag === '--port') {
      args.port = Number(value());
      if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1-65535');
    } else if (flag === '--no-open') args.open = false;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (!flag.startsWith('-') && args.model === null) args.model = flag;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

export function defaultCacheDir(env = process.env) {
  if (env.HPV_CACHE_DIR) return resolve(env.HPV_CACHE_DIR);
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'humanoid-policy-viewer');
}

// Every ONNX in the repo, plus the training config (env.yaml supplies the gains,
// agent.yaml is only checked for presence).
export function selectFiles(files) {
  const onnx = files.filter((f) => f.toLowerCase().endsWith('.onnx')).sort();
  if (onnx.length === 0) throw new Error('The repo contains no .onnx file');
  const present = (name) => checkpointFileCandidates(name).filter((f) => files.includes(f));
  return {
    onnx,
    env: present('env.yaml'),
    agent: present('agent.yaml'),
    primary: onnx.includes('policy.onnx') ? 'policy.onnx' : onnx[0],
  };
}

function readMeta(modelDir) {
  try { return JSON.parse(readFileSync(join(modelDir, HF_META_FILE), 'utf8')); } catch { return null; }
}

async function fetchRepoInfo(repo, revision, { endpoint, token, fetchImpl }) {
  const response = await fetchImpl(`${endpoint}/api/models/${repo}/revision/${encodeURIComponent(revision)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // The Hub answers 401 (not 404) for a repo that is missing or private.
  if (response.status === 401 || response.status === 404) {
    throw new Error(`Hugging Face repo ${repo}@${revision} was not found, or it is private (set HF_TOKEN to use a private repo)`);
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

async function downloadFile(url, destination, { token, fetchImpl }) {
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
export async function ensureModel(repo, {
  revision = 'main',
  cacheDir = defaultCacheDir(),
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const endpoint = (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
  const token = env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || null;
  const layout = (id) => {
    const dirName = id.replace('/', '__');
    return { dirName, modelDir: join(cacheDir, HF_MODEL_ROOT, dirName) };
  };
  const result = (id, meta, cached) => {
    const { dirName, modelDir } = layout(id);
    return { cacheDir, modelDir, ...meta, cached, policyValue: `ckpt:${HF_MODEL_ROOT}/${dirName}/${meta.primary}` };
  };

  let info;
  try {
    info = await fetchRepoInfo(repo, revision, { endpoint, token, fetchImpl });
  } catch (error) {
    const previous = readMeta(layout(repo).modelDir);
    // A TypeError is fetch's "could not reach the server"; HTTP errors are not retried from cache.
    if (error instanceof TypeError && previous) {
      log(`Hugging Face is unreachable; using the cached copy of ${repo} (${previous.sha.slice(0, 7)})`);
      return result(repo, previous, true);
    }
    throw error;
  }

  // The Hub matches repo ids case-insensitively; key the cache on its spelling.
  const id = info.id;
  const { modelDir } = layout(id);
  const previous = readMeta(modelDir);
  const { onnx, env: envFiles, agent: agentFiles, primary } = selectFiles(info.files);
  const wanted = [...onnx, ...envFiles, ...agentFiles];
  // A copy cached by an older version may lack files that are wanted now.
  if (previous?.sha === info.sha && wanted.every((file) => previous.files?.includes(file))) {
    log(`Using cached ${id} (${info.sha.slice(0, 7)})`);
    return result(id, { ...previous, libraryName: info.libraryName }, true);
  }

  const staging = `${modelDir}.tmp-${process.pid}`;
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
    rmSync(modelDir, { recursive: true, force: true });
    renameSync(staging, modelDir);
    return result(id, meta, false);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function sceneIsInstalled(appDir) {
  return existsSync(join(appDir, 'public/examples/scenes/asimov-1/sim-model/xmls/asimov_1.xml'));
}
