// npm run hf <org/name | folder | file.onnx>
// Downloads a policy from Hugging Face, or links one from disk, and starts the
// viewer with it selected.
// Nothing here may import an npm dependency before setup() has installed them.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPolicyDir, libraryNameWarning, readReferenceJointNames } from './policyChecks.mjs';
import { HF_POLICY_ROOT, USAGE, ensurePolicy, normalizeRepoId, parseArgs } from './hfPolicy.mjs';
import { isLocalPolicy, linkLocalPolicy } from './localPolicy.mjs';
import { setup } from './setup.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.policy) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const local = isLocalPolicy(args.policy) ? linkLocalPolicy(args.policy) : null;
  const repo = local ? null : normalizeRepoId(args.policy);
  if (local) {
    // Remove the temporary link however the server stops; a signal alone skips 'exit'.
    process.on('exit', local.cleanup);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
  }

  setup();

  const policy = local ?? await ensurePolicy(repo, { revision: args.revision, log: console.log });
  const name = local ? local.policyDir : policy.repo;

  const { errors, warnings } = checkPolicyDir(policy.policyDir, readReferenceJointNames(appDir));
  // A local folder has no model card to check.
  const libraryWarning = local ? null : libraryNameWarning(policy.libraryName);
  if (libraryWarning) warnings.unshift(libraryWarning);
  if (warnings.length) {
    console.warn(`\nWarning: ${name} has ${warnings.length} issue(s):`);
    for (const warning of warnings) console.warn(`  - ${warning}`);
  }
  if (errors.length) {
    throw new Error(`${name} cannot be run:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  if (!warnings.length) console.log('Checked env.yaml and agent.yaml: OK');
  console.log('');

  // The bare URL opens the bundled example policy; this path selects the one just checked.
  const policyPath = `/?policy=${encodeURIComponent(policy.policyValue)}`;
  const { startViewer } = await import('./startViewer.mjs');
  const { server } = await startViewer({
    policyLibrary: { dir: policy.cacheDir, roots: [local ? local.root : HF_POLICY_ROOT] },
    ...(args.port ? { port: args.port } : {}),
    open: args.open ? policyPath : false,
  });
  console.log(`\nRunning ${name}${policy.primary === 'policy.onnx' ? '' : ` (${policy.primary})`}`);
  const urls = server.resolvedUrls;
  if (!urls) {
    server.printUrls();
    return;
  }
  // Print links that open this policy, so copying one from a headless or SSH session works too.
  for (const url of urls.local) console.log(`  ➜  Local:   ${new URL(policyPath, url)}`);
  for (const url of urls.network) console.log(`  ➜  Network: ${new URL(policyPath, url)}`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
