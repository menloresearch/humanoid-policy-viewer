// Shared trajectory-sequence discovery for ./benchmark, mirroring
// modelDiscovery.mjs's role for ONNX checkpoints: used by both
// vite.config.mjs (to serve /api/sequences to the dev browser) and
// build-static-catalog.mjs (to bake the same listing + file contents into
// public/static-data/sequences.json for the static build).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function walkJson(dir, prefix, onFile) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkJson(resolve(dir, entry.name), rel, onFile);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      onFile(rel, resolve(dir, entry.name));
    }
  }
}

/** `{file, folder, name, duration, keypointCount, eventCount}[]`, sorted by file. */
export function listSequenceEntries(seqDir) {
  if (!existsSync(seqDir)) return [];
  const out = [];
  walkJson(seqDir, '', (rel, full) => {
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      out.push({
        file: rel,
        folder,
        name: typeof parsed.name === 'string' ? parsed.name : rel,
        duration: Number(parsed.duration) || 0,
        keypointCount: Array.isArray(parsed.commands) ? parsed.commands.length : 0,
        eventCount: Array.isArray(parsed.events) ? parsed.events.length : 0,
      });
    } catch {
      out.push({ file: rel, folder, name: rel, duration: 0, keypointCount: 0, eventCount: 0, invalid: true });
    }
  });
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
