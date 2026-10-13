// Runs a policy from a folder or .onnx file on disk instead of Hugging Face, e.g.
// one a training repo just exported. The folder needs the same files as a Hub
// repo (see docs/huggingface.md). It is linked, not copied, into a temporary
// policy library (see policyLibraryConfig.mjs), so the dev server serves it under
// /policy-library/<name>/ like a download and re-exports show up on reload.

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

/**
 * Links the policy's folder into a new temporary library and returns where it is
 * and how to select it. Call cleanup() on exit; it only removes the link.
 */
export function linkLocalPolicy(input, { tmpRoot = tmpdir() } = {}) {
  const { policyDir, primary } = findLocalPolicy(input);
  const cacheDir = mkdtempSync(join(tmpRoot, 'hpv-local-'));
  const root = libraryName(policyDir);
  // A junction lets Windows link a folder without admin rights; elsewhere the type is ignored.
  const link = join(cacheDir, root);
  symlinkSync(policyDir, link, 'junction');
  return {
    cacheDir,
    root,
    policyDir,
    primary,
    policyValue: `lib:${root}/${primary}`,
    // Never a recursive delete: that could reach through the link into the policy's folder.
    cleanup: () => {
      try { unlinkSync(link); rmdirSync(cacheDir); } catch { /* already gone */ }
    },
  };
}
