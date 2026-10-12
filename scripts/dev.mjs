#!/usr/bin/env node
// npm run dev [benchmark=<benchmark dir | datasets/<org>/<name>[@rev]>] [policy=<org>/<name>[@rev]...]
//             [vite options...]
//
// Starts the Vite dev server. The trajectory editor and the in-app benchmark
// read and write the tests of a benchmark folder (see
// scripts/benchmarkDir.mjs and docs/benchmark-datasets.md): benchmark=<dir>, or by
// default the tracked example benchmark ./benchmarks/default. A Hugging Face
// dataset is pulled on first use into ./benchmarks/<org>__<name> (gitignored),
// an ordinary working copy (edit it, `npm run suite diff` / `publish` it);
// later runs reuse it as is. That folder is where the app opens first; its
// "New benchmark" button adds more under ./benchmarks/ and the app switches
// between them.
//
// Policies: the policy list shows ./policies and every Hugging Face policy already
// downloaded (by `npm run hf` or policy=), labelled by repo id. policy=<org>/<name>
// downloads one first if it is not cached (repeatable). If HPV_POLICY_LIBRARY_DIR
// or HPV_POLICY_ROOTS is set, that library is used as is instead.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './benchmarkTargets.mjs';
import { checkPolicyDir, readReferenceJointNames } from './policyChecks.mjs';
import { HF_POLICY_ROOT, defaultCacheDir, ensurePolicy, normalizeRepoId } from './hfPolicy.mjs';
import { DEFAULT_POLICY_ROOT } from './policyLibraryConfig.mjs';
import { pull, pulledFrom } from './suite.mjs';
import { BENCHMARK_FILE, defaultBenchmarkDir } from './benchmarkDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const passThrough = [];
let benchmarkDir = defaultBenchmarkDir(appDir);
let hub = null;
const hubPolicies = [];
for (const word of process.argv.slice(2)) {
  const benchmark = /^(?:--)?benchmark=(.+)$/.exec(word);
  const policy = /^(?:--)?policy=(.+)$/.exec(word);
  if (policy) {
    const [repo, revision] = policy[1].split('@');
    try {
      hubPolicies.push({ repo: normalizeRepoId(repo), revision: revision || 'main' });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  } else if (benchmark) {
    const target = isHubDataset(benchmark[1]) ? classifyTarget(benchmark[1]) : null;
    if (target?.kind === 'benchmark' && target.source === 'hub') {
      hub = target;
      benchmarkDir = join(appDir, 'benchmarks', target.id.replace('/', '__'));
    } else {
      benchmarkDir = resolve(benchmark[1]);
    }
  } else {
    passThrough.push(word);
  }
}
for (const name of ['benchmark', 'policy']) {
  if (process.env[`npm_config_${name}`]) {
    console.error(`npm kept --${name} for itself; write ${name}=<value> (no dashes).`);
    process.exit(2);
  }
}

if (hub) await hubWorkingCopy(hub, benchmarkDir);

if (!existsSync(join(benchmarkDir, BENCHMARK_FILE))) {
  console.error(`${benchmarkDir} has no benchmark.yaml. Create a benchmark with \`npm run suite init ${benchmarkDir}\` or pull one with \`npm run suite pull <dataset> ${benchmarkDir}\`.`);
  process.exit(2);
}
env.HPV_SUITE_DIR = benchmarkDir;
await setUpPolicyLibrary(env);
console.log(`Tests: benchmark ${benchmarkDir}`);

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
 * Downloads the policy= repos, then points the library at a folder of links to
 * ./policies and the Hugging Face policy cache, so the viewer lists both.
 */
async function setUpPolicyLibrary(childEnv) {
  const cacheDir = defaultCacheDir();
  for (const { repo, revision } of hubPolicies) {
    let policy;
    try {
      policy = await ensurePolicy(repo, { revision, cacheDir, log: console.log });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    console.log(`${policy.cached ? 'Cached' : 'Downloaded'} policy ${policy.repo}@${policy.sha.slice(0, 7)}`);
    // Listed either way; the viewer refuses a policy it would run wrongly when it is picked.
    const { errors, warnings } = checkPolicyDir(policy.policyDir, readReferenceJointNames(appDir));
    for (const problem of [...errors, ...warnings]) console.warn(`  ${errors.includes(problem) ? 'Error' : 'Warning'}: ${problem}`);
  }
  if (process.env.HPV_POLICY_LIBRARY_DIR !== undefined || process.env.HPV_POLICY_ROOTS !== undefined) return;
  // One links folder per checkout, so two checkouts' dev servers don't share ./policies.
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
  link(DEFAULT_POLICY_ROOT, join(appDir, DEFAULT_POLICY_ROOT));
  link(HF_POLICY_ROOT, join(cacheDir, HF_POLICY_ROOT));
  childEnv.HPV_POLICY_LIBRARY_DIR = library;
  childEnv.HPV_POLICY_ROOTS = `${DEFAULT_POLICY_ROOT},${HF_POLICY_ROOT}`;
}
