// npm run hf <org/name | folder | file.onnx>
// Downloads a policy from Hugging Face, or links one from disk, and starts the
// viewer with it selected.
// Nothing here may import an npm dependency before the install step below.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCheckpointDir, libraryNameWarning, readReferenceJointNames } from './checkpointChecks.mjs';
import { HF_MODEL_ROOT, USAGE, ensureModel, normalizeRepoId, parseArgs, sceneIsInstalled } from './hfModel.mjs';
import { isLocalModel, linkLocalModel } from './localModel.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` failed`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const local = isLocalModel(args.model) ? linkLocalModel(args.model) : null;
  const repo = local ? null : normalizeRepoId(args.model);
  if (local) {
    // Remove the temporary link however the server stops; a signal alone skips 'exit'.
    process.on('exit', local.cleanup);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
  }

  if (!existsSync(resolve(appDir, 'node_modules/vite/package.json'))) {
    console.log('Installing dependencies (first run only)...');
    run('npm', ['ci']);
  }

  if (!sceneIsInstalled(appDir)) {
    console.log('Fetching the Asimov robot model (first run only)...');
    run('bash', ['scripts/init-asimov-1.sh']);
  }

  const model = local ?? await ensureModel(repo, { revision: args.revision, log: console.log });
  const name = local ? local.modelDir : model.repo;

  const { errors, warnings } = checkCheckpointDir(model.modelDir, readReferenceJointNames(appDir));
  // A local folder has no model card to check.
  const libraryWarning = local ? null : libraryNameWarning(model.libraryName);
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

  // vite.config.mjs reads these when it loads, so they must be set first.
  process.env.HPV_MODEL_LIBRARY_DIR = model.cacheDir;
  process.env.HPV_MODEL_ROOTS = local ? local.root : HF_MODEL_ROOT;

  const { createServer } = await import('vite');
  const server = await createServer({
    root: appDir,
    server: {
      ...(args.port ? { port: args.port } : {}),
      open: args.open ? `/?policy=${encodeURIComponent(model.policyValue)}` : false,
    },
  });
  await server.listen();
  console.log(`\nRunning ${name}${model.primary === 'policy.onnx' ? '' : ` (${model.primary})`}`);
  server.printUrls();
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
