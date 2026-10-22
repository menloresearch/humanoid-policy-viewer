// Shared ONNX policy discovery for the policy root folders named in
// HPV_POLICY_ROOTS (see policyLibraryConfig.mjs).
//
// Used by scripts/viewerServer.mjs (to serve /api/policies to the browser),
// scripts/run-benchmark.mjs (to build the default policy list), and by any
// embedding repo's tooling, so they never drift on what counts as a
// discoverable policy.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { HF_META_FILE } from './hfPolicy.mjs';

// A policy downloaded by `npm run hf` is labelled by its Hugging Face repo id,
// with the file name added when it is not the repo's primary policy.
function hfLabel(dir, fileName) {
  let meta;
  try { meta = JSON.parse(readFileSync(resolve(dir, HF_META_FILE), 'utf8')); } catch { return null; }
  if (typeof meta?.repo !== 'string') return null;
  return fileName === meta.primary ? meta.repo : `${meta.repo} (${fileName})`;
}

// A policy linked from disk: its label for its primary .onnx, "label (file)" for the others.
function namedLabel(named, rel) {
  if (!named?.label) return null;
  return rel === named.primary ? named.label : `${named.label} (${rel})`;
}

export function listPolicyRoots(baseDir, roots) {
  if (!baseDir) return [];
  return roots
    .map((root) => ({ root, directory: resolve(baseDir, root) }))
    .filter((entry) => existsSync(entry.directory))
    .map((entry) => ({ ...entry, realDirectory: realpathSync(entry.directory) }));
}

/**
 * Every .onnx under the roots, labelled by its Hugging Face repo id when it was
 * downloaded, else by labels[root] ({ label, primary }: a policy linked from disk,
 * see linkPolicyLibrary) when given, else by its library path.
 */
export function discoverPolicies(baseDir, roots, { labels = {} } = {}) {
  const policyRoots = listPolicyRoots(baseDir, roots);
  const out = [];
  for (const pr of policyRoots) {
    const walkOnnx = (dir, prefix) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkOnnx(resolve(dir, entry.name), rel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.onnx')) {
          out.push({
            root: pr.root,
            path: `${pr.root}/${rel}`,
            url: `/policy-library/${pr.root}/${rel}`,
            label: hfLabel(dir, entry.name) ?? namedLabel(labels[pr.root], rel) ?? `${pr.root}/${rel}`,
            name: entry.name,
          });
        }
      }
    };
    walkOnnx(pr.realDirectory, '');
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
