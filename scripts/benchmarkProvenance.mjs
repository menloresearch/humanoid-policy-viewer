// What produced a benchmark result: viewer commit (and whether the checkout had
// uncommitted changes), protocol, robot model commit, runtime versions and the
// hashes of the policy files. Recorded in every result.json; a result whose
// viewer checkout was dirty cannot be uploaded (see uploadBlockers).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';
import { policyFileCandidates } from '../src/simulation/envPolicyConfig.js';

export const HPV_REPO = 'https://github.com/menloresearch/humanoid-policy-viewer';
const ASIMOV_1 = 'public/examples/scenes/asimov-1';

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function packageVersion(appDir, name) {
  try {
    return JSON.parse(readFileSync(join(appDir, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function collectProvenance(appDir) {
  const commit = git(appDir, ['rev-parse', 'HEAD']);
  // Untracked files are ignored: they cannot change a tracked module, and a
  // stray scratch file should not block an upload.
  const status = git(appDir, ['status', '--porcelain', '--untracked-files=no']);
  return {
    hpv: {
      repo: HPV_REPO,
      commit,
      dirty: commit ? status !== '' : null,
      protocol: BENCHMARK_PROTOCOL,
    },
    asimov1: { commit: git(join(appDir, ASIMOV_1), ['rev-parse', 'HEAD']) },
    runtime: {
      node: process.version,
      mujocoJs: packageVersion(appDir, 'mujoco-js'),
      onnxruntimeWeb: packageVersion(appDir, 'onnxruntime-web'),
      chromium: null, // filled in once the browser is up
    },
  };
}

/**
 * Whether `commit` is on a branch of HPV_REPO, as this clone last fetched it, so
 * anyone can check it out. null when it is not a git checkout.
 */
export function onPublicRepo(appDir, commit) {
  const remotes = git(appDir, ['remote', '-v']);
  if (remotes === null || !commit) return null;
  const names = new Set(remotes.split('\n')
    .filter((line) => /[/:]menloresearch\/humanoid-policy-viewer(\.git)? \(fetch\)$/.test(line))
    .map((line) => line.split('\t')[0]));
  const branches = git(appDir, ['branch', '-r', '--contains', commit, '--format=%(refname:short)']) ?? '';
  return branches.split('\n').some((branch) => names.has(branch.split('/')[0]));
}

/** sha256 of the policy ONNX and of the env.yaml the viewer will read beside it. */
export function policyFileHashes(policyDir, primary) {
  const env = policyFileCandidates('env.yaml').find((file) => existsSync(join(policyDir, file)));
  return {
    onnx: sha256File(join(policyDir, primary)),
    envYaml: env ? sha256File(join(policyDir, env)) : null,
  };
}
