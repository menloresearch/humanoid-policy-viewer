// The policies `npm run hf` and `npm run dev` open in the viewer. Hugging Face
// policies are downloaded into the cache and listed under its hf/ root, labelled
// by repo id; policies on disk (a policy folder, an .onnx, or a folder of policy
// folders) are linked into a temporary library, each labelled by its shortest
// distinguishing path suffix (e.g. run1/exported, run2/exported).
// Node's own modules only: scripts/hf.mjs loads it before setup().

import { ensurePolicy } from './hfPolicy.mjs';
import { expandLocalPolicy, linkPolicyLibrary, policyLabels } from './localPolicy.mjs';
import { checkPolicyDir, libraryNameWarning, readReferenceJointNames } from './policyChecks.mjs';

/**
 * Downloads (Hub) or finds (disk) every policy the classified `targets` name, in
 * order and without duplicates, each with what checkPolicyDir found:
 * [{ source, name, policyDir, primary, scanned, errors, warnings, repo?, value? }].
 * `name` is how the console names it (repo id or folder); `scanned` marks one
 * found below a folder of policies rather than named itself.
 */
export async function resolvePolicies(targets, { appDir, cacheDir, env = process.env, log = console.log }) {
  const jointNames = readReferenceJointNames(appDir);
  const policies = [];
  for (const target of targets) {
    if (target.source === 'hub') {
      const policy = await ensurePolicy(target.id, { revision: target.revision ?? 'main', cacheDir, env, log });
      const { errors, warnings } = checkPolicyDir(policy.policyDir, jointNames);
      const libraryWarning = libraryNameWarning(policy.libraryName);
      policies.push({
        source: 'hub', name: policy.repo, label: policy.repo, repo: policy.repo, sha: policy.sha, cached: policy.cached,
        policyDir: policy.policyDir, primary: policy.primary, value: policy.policyValue, scanned: false,
        errors, warnings: libraryWarning ? [libraryWarning, ...warnings] : warnings,
      });
      continue;
    }
    for (const found of expandLocalPolicy(target.path)) {
      // A local folder has no model card to check.
      const { errors, warnings } = found.error ? { errors: [found.error], warnings: [] } : checkPolicyDir(found.policyDir, jointNames);
      policies.push({ source: 'local', name: found.policyDir, ...found, errors, warnings });
    }
  }
  const seen = new Set();
  return policies.filter((policy) => !seen.has(policy.policyDir) && seen.add(policy.policyDir));
}

/**
 * The library that lists `policies` (from resolvePolicies) beside the roots of
 * `base` ({ dir, roots }; it must list the Hub cache's hf/ root when there are
 * Hub policies): `base` itself when every policy is from the Hub, else a
 * temporary one with the local policies linked in (call cleanup() on exit).
 * Sets each policy's `label` and `value` (what ?policy= selects it with).
 * @returns {{ dir, roots, labels, cleanup }}
 */
export function libraryFor(policies, { base }) {
  const locals = policies.filter((policy) => policy.source === 'local');
  const hubLabels = policies.filter((policy) => policy.source === 'hub').map((policy) => policy.label);
  policyLabels(locals.map((policy) => policy.policyDir), hubLabels).forEach((label, i) => { locals[i].label = label; });
  if (!locals.length) return { dir: base.dir, roots: base.roots, labels: {}, cleanup: () => {} };
  const library = linkPolicyLibrary(locals, { base });
  library.values.forEach((value, i) => { locals[i].value = value; });
  return library;
}

/** Removes the temporary library however the process stops; a signal alone skips 'exit'. */
export function cleanupOnExit(cleanup) {
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
}

/** Prints a policy's warnings under its name (errors are the caller's to report). */
export function printPolicyWarnings(policy, { warn = console.warn } = {}) {
  if (!policy.warnings.length) return;
  warn(`\nWarning: ${policy.name} has ${policy.warnings.length} issue(s):`);
  for (const warning of policy.warnings) warn(`  - ${warning}`);
}
