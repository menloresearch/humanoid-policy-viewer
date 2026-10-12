// What produced a benchmark result: viewer commit (and whether the checkout had
// uncommitted changes), protocol, robot model commit, runtime versions and the
// hashes of the policy files. Recorded in every run.json; a result whose
// viewer checkout was dirty cannot be uploaded (see uploadBlockers).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';
import { checkpointFileCandidates } from '../src/simulation/envPolicyConfig.js';

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

/** sha256 of the policy ONNX and of the env.yaml the viewer will read beside it. */
export function policyFileHashes(modelDir, primary) {
  const env = checkpointFileCandidates('env.yaml').find((file) => existsSync(join(modelDir, file)));
  return {
    onnx: sha256File(join(modelDir, primary)),
    envYaml: env ? sha256File(join(modelDir, env)) : null,
  };
}
