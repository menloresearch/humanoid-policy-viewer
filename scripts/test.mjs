#!/usr/bin/env node
// npm test [<file or folder>...]
// Runs every *.test.js / *.test.mjs under src/ and scripts/ (or under the folders
// given) with node --test. Node 20 does not expand a "**" glob given to --test,
// so the files are listed here. The browser tests in test/browser/ run only when
// asked: npm run test:browser.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
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

const isFolder = (path) => statSync(resolve(appDir, path), { throwIfNoEntry: false })?.isDirectory();
const files = process.argv.length > 2
  ? process.argv.slice(2).flatMap((path) => (isFolder(path) ? testFiles(resolve(appDir, path)).sort() : [path]))
  : ['src', 'scripts'].flatMap((dir) => testFiles(join(appDir, dir))).sort();
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: appDir, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
