#!/usr/bin/env node
// npm run dev [suite=<benchmark dataset dir>] [vite options...]
//
// Starts the Vite dev server. With suite=<dir>, the trajectory editor and the
// in-app benchmark read and write that benchmark dataset working copy (see
// scripts/suiteDir.mjs and `npm run suite pull`) instead of ./benchmark.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const passThrough = [];
for (const word of process.argv.slice(2)) {
  const suite = /^(?:--)?suite=(.+)$/.exec(word);
  if (suite) {
    const dir = resolve(suite[1]);
    if (!existsSync(join(dir, 'suite.yaml'))) {
      console.error(`${dir} has no suite.yaml; is it a benchmark dataset? (npm run suite pull <dataset> <dir>)`);
      process.exit(2);
    }
    env.HPV_SUITE_DIR = dir;
    console.log(`Editing benchmark dataset ${dir}`);
  } else {
    passThrough.push(word);
  }
}
if (process.env.npm_config_suite) {
  console.error('npm kept --suite for itself; write suite=<dir> (no dashes).');
  process.exit(2);
}

const vite = join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(process.execPath, [vite, '--host', ...passThrough], { cwd: appDir, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
