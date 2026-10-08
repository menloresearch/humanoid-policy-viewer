#!/usr/bin/env node
// npm run dev [suite=<benchmark dataset dir | datasets/<org>/<name>[@rev]>] [vite options...]
//
// Starts the Vite dev server. The trajectory editor and the in-app benchmark
// read and write the tests of a benchmark dataset folder (see
// scripts/suiteDir.mjs and docs/benchmark-datasets.md): suite=<dir>, or by
// default ./benchmark (gitignored), which is created with a starter suite on
// first use. A Hugging Face dataset is pulled on first use into
// ./benchmark_datasets/<org>__<name> (gitignored), an ordinary working copy
// (edit it, `npm run suite diff` / `publish` it); later runs reuse it as is.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './benchmarkTargets.mjs';
import { initSuite, pull, pulledFrom } from './suite.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const passThrough = [];
let suiteDir = join(appDir, 'benchmark');
let explicit = false;
let hub = null;
for (const word of process.argv.slice(2)) {
  const suite = /^(?:--)?suite=(.+)$/.exec(word);
  if (suite) {
    const target = isHubDataset(suite[1]) ? classifyTarget(suite[1]) : null;
    if (target?.kind === 'suite' && target.source === 'hub') {
      hub = target;
      suiteDir = join(appDir, 'benchmark_datasets', target.id.replace('/', '__'));
    } else {
      suiteDir = resolve(suite[1]);
    }
    explicit = true;
  } else {
    passThrough.push(word);
  }
}
if (process.env.npm_config_suite) {
  console.error('npm kept --suite for itself; write suite=<dir> (no dashes).');
  process.exit(2);
}

if (hub) await hubWorkingCopy(hub, suiteDir);

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

// "datasets/org/name[@rev]" or a huggingface.co/datasets/... URL, not a path that happens to exist on disk.
function isHubDataset(text) {
  if (existsSync(resolve(text))) return false;
  return /^datasets\//.test(text) || /huggingface\.co\/datasets\/|hf\.co\/datasets\//.test(text);
}

/** Pulls the dataset into `dir` on first use; afterwards keeps the working copy (and any edits) as is. */
async function hubWorkingCopy(target, dir) {
  const want = target.revision ?? 'main';
  if (!existsSync(dir) || !readdirSync(dir).length) {
    try {
      await pull(`datasets/${target.id}@${want}`, dir);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    return;
  }
  const base = pulledFrom(dir);
  if (base?.id !== target.id) {
    console.error(`${dir} exists but is not a working copy of datasets/${target.id}; move it away to pull afresh.`);
    process.exit(2);
  }
  console.log(`Using your working copy of datasets/${base.id} (pulled ${base.revision}@${base.sha.slice(0, 7)}) in ${dir}.`);
  if (target.revision && target.revision !== base.revision) {
    console.log(`  You asked for @${target.revision}; delete that folder to pull it instead (your edits there would be lost).`);
  }
  console.log(`  See what you changed: npm run suite diff ${dir}`);
}
