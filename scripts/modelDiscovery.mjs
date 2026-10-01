// Shared ONNX checkpoint discovery for the model root folders named in
// HPV_MODEL_ROOTS (see modelLibraryConfig.mjs).
//
// Used by vite.config.mjs (to serve /api/models to the browser),
// scripts/run-benchmark.mjs (to build the default policy list), and by any
// embedding repo's tooling, so they never drift on what counts as a
// discoverable model.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function listModelRoots(baseDir, roots) {
  if (!baseDir) return [];
  return roots
    .map((root) => ({ root, directory: resolve(baseDir, root) }))
    .filter((entry) => existsSync(entry.directory))
    .map((entry) => ({ ...entry, realDirectory: realpathSync(entry.directory) }));
}

export function listModels(baseDir, roots) {
  const modelRoots = listModelRoots(baseDir, roots);
  const out = [];
  for (const mr of modelRoots) {
    const walkOnnx = (dir, prefix) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkOnnx(resolve(dir, entry.name), rel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.onnx')) {
          out.push({
            root: mr.root,
            path: `${mr.root}/${rel}`,
            url: `/model-library/${mr.root}/${rel}`,
            label: `${mr.root}/${rel}`,
            name: entry.name,
          });
        }
      }
    };
    walkOnnx(mr.realDirectory, '');
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
