#!/usr/bin/env node
// npm run dev [suite=<benchmark dataset dir | datasets/<org>/<name>[@rev]>] [model=<org>/<name>[@rev]...]
//             [vite options...]
//
// Starts the Vite dev server. The trajectory editor and the in-app benchmark
// read and write the tests of a benchmark dataset folder (see
// scripts/suiteDir.mjs and docs/benchmark-datasets.md): suite=<dir>, or by
// default ./benchmark_datasets/default (gitignored), which is created with the
// example benchmark on first use (or moved there from ./benchmark, where it
// used to live). A Hugging Face dataset is pulled on first use into
// ./benchmark_datasets/<org>__<name> (gitignored), an ordinary working copy
// (edit it, `npm run suite diff` / `publish` it); later runs reuse it as is.
// That folder is where the app opens first; its "New benchmark" button adds
// more under ./benchmark_datasets/ and the app switches between them.
//
// Models: the policy list shows ./models and every Hugging Face model already
// downloaded (by `npm run hf` or model=), labelled by repo id. model=<org>/<name>
// downloads one first if it is not cached (repeatable). If HPV_MODEL_LIBRARY_DIR
// or HPV_MODEL_ROOTS is set, that library is used as is instead.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './benchmarkTargets.mjs';
import { checkCheckpointDir, readReferenceJointNames } from './checkpointChecks.mjs';
import { HF_MODEL_ROOT, defaultCacheDir, ensureModel, normalizeRepoId } from './hfModel.mjs';
import { DEFAULT_MODEL_ROOT } from './modelLibraryConfig.mjs';
import { initSuite, pull, pulledFrom } from './suite.mjs';
import { defaultSuiteDir } from './suiteDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const passThrough = [];
let suiteDir = defaultSuiteDir(appDir);
let explicit = false;
let hub = null;
const hubModels = [];
for (const word of process.argv.slice(2)) {
  const suite = /^(?:--)?suite=(.+)$/.exec(word);
  const model = /^(?:--)?model=(.+)$/.exec(word);
  if (model) {
    const [repo, revision] = model[1].split('@');
    try {
      hubModels.push({ repo: normalizeRepoId(repo), revision: revision || 'main' });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  } else if (suite) {
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
for (const name of ['suite', 'model']) {
  if (process.env[`npm_config_${name}`]) {
    console.error(`npm kept --${name} for itself; write ${name}=<value> (no dashes).`);
    process.exit(2);
  }
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
await setUpModelLibrary(env);
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

/**
 * Downloads the model= repos, then points the library at a folder of links to
 * ./models and the Hugging Face model cache, so the viewer lists both.
 */
async function setUpModelLibrary(childEnv) {
  const cacheDir = defaultCacheDir();
  for (const { repo, revision } of hubModels) {
    let model;
    try {
      model = await ensureModel(repo, { revision, cacheDir, log: console.log });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    console.log(`${model.cached ? 'Cached' : 'Downloaded'} model ${model.repo}@${model.sha.slice(0, 7)}`);
    // Listed either way; the viewer refuses a policy it would run wrongly when it is picked.
    const { errors, warnings } = checkCheckpointDir(model.modelDir, readReferenceJointNames(appDir));
    for (const problem of [...errors, ...warnings]) console.warn(`  ${errors.includes(problem) ? 'Error' : 'Warning'}: ${problem}`);
  }
  if (process.env.HPV_MODEL_LIBRARY_DIR !== undefined || process.env.HPV_MODEL_ROOTS !== undefined) return;
  // One links folder per checkout, so two checkouts' dev servers don't share ./models.
  const key = createHash('sha256').update(appDir).digest('hex').slice(0, 10);
  const library = join(cacheDir, 'dev-library', key);
  mkdirSync(library, { recursive: true });
  const link = (name, target) => {
    const path = join(library, name);
    try {
      if (readlinkSync(path) === target) return;
    } catch {}
    rmSync(path, { force: true });
    symlinkSync(target, path, 'dir');
  };
  link(DEFAULT_MODEL_ROOT, join(appDir, DEFAULT_MODEL_ROOT));
  link(HF_MODEL_ROOT, join(cacheDir, HF_MODEL_ROOT));
  childEnv.HPV_MODEL_LIBRARY_DIR = library;
  childEnv.HPV_MODEL_ROOTS = `${DEFAULT_MODEL_ROOT},${HF_MODEL_ROOT}`;
}
