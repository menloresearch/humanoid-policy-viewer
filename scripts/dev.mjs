#!/usr/bin/env node
// npm run dev [suite=<benchmark dataset dir>] [vite options...]
//
// Starts the Vite dev server. The trajectory editor and the in-app benchmark
// read and write the tests of a benchmark dataset folder (see
// scripts/suiteDir.mjs and docs/benchmark-datasets.md): suite=<dir>, or by
// default ./benchmark (gitignored), which is created with a starter suite on
// first use.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSuite } from './suite.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const passThrough = [];
let suiteDir = join(appDir, 'benchmark');
let explicit = false;
for (const word of process.argv.slice(2)) {
  const suite = /^(?:--)?suite=(.+)$/.exec(word);
  if (suite) {
    suiteDir = resolve(suite[1]);
    explicit = true;
  } else {
    passThrough.push(word);
  }
}
if (process.env.npm_config_suite) {
  console.error('npm kept --suite for itself; write suite=<dir> (no dashes).');
  process.exit(2);
}

if (!existsSync(join(suiteDir, 'suite.yaml'))) {
  if (explicit) {
    console.error(`${suiteDir} has no suite.yaml. Create a benchmark with \`npm run suite init ${suiteDir}\` or pull one with \`npm run suite pull <dataset> ${suiteDir}\`.`);
    process.exit(2);
  }
  if (existsSync(suiteDir) && readdirSync(suiteDir).length) {
    console.error(`${suiteDir} exists but is not a benchmark dataset (no suite.yaml); move it away or pass suite=<dir>.`);
    process.exit(2);
  }
  initSuite(suiteDir);
}
env.HPV_SUITE_DIR = suiteDir;
console.log(`Tests: benchmark dataset ${suiteDir}`);

const vite = join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(process.execPath, [vite, '--host', ...passThrough], { cwd: appDir, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
