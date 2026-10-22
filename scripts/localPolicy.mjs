// Runs policies from folders or .onnx files on disk instead of Hugging Face, e.g.
// ones a training repo just exported. A policy folder needs the same files as a
// Hub repo (see docs/huggingface.md); a folder with no .onnx of its own stands
// for every policy folder below it (expandLocalPolicy). They are linked, not
// copied, into a temporary policy library (see policyLibraryConfig.mjs), so the
// dev server serves each under /policy-library/<name>/ like a download and
// re-exports show up on reload.

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { policyFileCandidates } from '../src/simulation/envPolicyConfig.js';

// Anything that exists on disk, or is written like a path, is a local policy; the
// rest is left to normalizeRepoId. A Hub id has exactly one "/" and no ".onnx".
export function isLocalPolicy(input) {
  const value = String(input ?? '');
  return existsSync(expandHome(value)) || /^(\.|~|\/|[A-Za-z]:[\\/])/.test(value) || value.toLowerCase().endsWith('.onnx');
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

// Folder names in the library end up in URLs and in HPV_POLICY_ROOTS (comma separated).
function libraryName(dir) {
  return basename(dir).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'local';
}

/** Finds the policy to run: the given .onnx, or the folder's policy.onnx, or its only .onnx. */
export function findLocalPolicy(input) {
  const path = resolve(expandHome(String(input)));
  if (!existsSync(path)) throw new Error(`${input} does not exist`);
  if (statSync(path).isFile()) {
    if (!path.toLowerCase().endsWith('.onnx')) throw new Error(`${input} is not an .onnx file or a folder`);
    return { policyDir: realpathSync(dirname(path)), primary: basename(path) };
  }
  const onnx = readdirSync(path).filter((f) => f.toLowerCase().endsWith('.onnx') && statSync(join(path, f)).isFile()).sort();
  if (onnx.length === 0) throw new Error(`${input} contains no .onnx file`);
  if (!onnx.includes('policy.onnx') && onnx.length > 1) {
    throw new Error(`${input} contains several .onnx files (${onnx.join(', ')}); pass the one to run`);
  }
  return { policyDir: realpathSync(path), primary: onnx.includes('policy.onnx') ? 'policy.onnx' : onnx[0] };
}

const hasOnnx = (dir) => readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.onnx'));
const hasEnvYaml = (dir) => policyFileCandidates('env.yaml').some((file) => existsSync(join(dir, file)));

/**
 * The folders below `dir` that hold a policy: an .onnx with an env.yaml (or
 * params/env.yaml) beside it, sorted. A policy folder's own subfolders, dot
 * folders, node_modules and links are not searched.
 */
export function findPolicyFolders(dir) {
  const found = [];
  (function walk(folder) {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = join(folder, entry.name);
      if (hasOnnx(sub) && hasEnvYaml(sub)) found.push(sub);
      else walk(sub);
    }
  })(dir);
  return found.sort();
}

/**
 * The policies a word on disk names: the .onnx or policy folder itself, or, for a
 * folder with no .onnx of its own, every policy folder below it (`scanned`).
 * A scanned folder the viewer cannot pick an .onnx from has an `error` instead.
 * @returns {{ policyDir, primary, scanned, error? }[]}
 */
export function expandLocalPolicy(input) {
  const path = resolve(expandHome(String(input)));
  if (!existsSync(path)) throw new Error(`${input} does not exist`);
  if (statSync(path).isFile() || hasOnnx(path)) return [{ ...findLocalPolicy(path), scanned: false }];
  const folders = findPolicyFolders(path);
  if (!folders.length) throw new Error(`${input} contains no .onnx file, and no folder below it holds an .onnx with an env.yaml`);
  return folders.map((folder) => {
    try {
      return { ...findLocalPolicy(folder), scanned: true };
    } catch (error) {
      return { policyDir: realpathSync(folder), primary: null, scanned: true, error: error.message };
    }
  });
}

/**
 * Readable, unique labels for policy folders: each folder's shortest path suffix
 * (its name, then parent/name, ...) that no other folder in `dirs` shares and that
 * is not in `reserved` (e.g. Hub repo ids listed beside them).
 */
export function policyLabels(dirs, reserved = []) {
  const parts = dirs.map((dir) => resolve(dir).split(sep).filter(Boolean));
  const suffix = (segments, n) => segments.slice(-n).join('/');
  return parts.map((segments, i) => {
    for (let n = 1; n <= segments.length; n++) {
      const label = suffix(segments, n);
      const shared = parts.some((other, j) => j !== i && suffix(other, n) === label);
      if (!shared && !reserved.includes(label)) return label;
    }
    return `/${segments.join('/')}`;
  });
}

/**
 * Links each local policy ({ policyDir, primary, label }) into a new temporary
 * library as its own root, beside the roots of `base` ({ dir, roots }, linked
 * too), and returns the library to serve: { dir, roots, labels, values, cleanup }.
 * `labels` maps a local root to { label, primary } for the policy list; values[i]
 * selects locals[i] in the viewer (?policy=). cleanup() only removes the links.
 */
export function linkPolicyLibrary(locals, { base = null, tmpRoot = tmpdir() } = {}) {
  const dir = mkdtempSync(join(tmpRoot, 'hpv-local-'));
  const links = [];
  const link = (name, target) => {
    const path = join(dir, name);
    // A junction lets Windows link a folder without admin rights; elsewhere the type is ignored.
    symlinkSync(target, path, 'junction');
    links.push(path);
  };
  const roots = [];
  for (const root of base?.roots ?? []) {
    link(root, resolve(base.dir, root));
    roots.push(root);
  }
  const labels = {};
  const values = locals.map((policy) => {
    const name = policy.label.split('/').filter(Boolean).map(libraryName).join('__');
    let root = name;
    for (let n = 2; roots.includes(root); n++) root = `${name}-${n}`;
    link(root, policy.policyDir);
    roots.push(root);
    labels[root] = { label: policy.label, primary: policy.primary };
    return `lib:${root}/${policy.primary}`;
  });
  return {
    dir,
    roots,
    labels,
    values,
    // Never a recursive delete: that could reach through a link into a policy's folder.
    cleanup: () => {
      for (const path of links) try { unlinkSync(path); } catch { /* already gone */ }
      try { rmdirSync(dir); } catch { /* already gone */ }
    },
  };
}
