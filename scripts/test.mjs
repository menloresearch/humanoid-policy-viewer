#!/usr/bin/env node
// npm test [<file>...]
// Runs every *.test.js / *.test.mjs under src/ and scripts/ with node --test.
// Node 20 does not expand a "**" glob given to --test, so the files are listed here.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.m?js$/.test(entry.name) ? [relative(appDir, path)] : [];
  });
}

const files = process.argv.length > 2 ? process.argv.slice(2) : ['src', 'scripts'].flatMap((dir) => testFiles(join(appDir, dir))).sort();
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: appDir, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
