// npm run hf -- --model <org/name>
// Downloads a policy from Hugging Face and starts the viewer with it selected.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HF_MODEL_ROOT, USAGE, ensureModel, normalizeRepoId, parseArgs, sceneIsInstalled } from './hfModel.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const repo = normalizeRepoId(args.model);

  if (!sceneIsInstalled(appDir)) {
    console.log('Fetching the Asimov robot model (first run only)...');
    const init = spawnSync('bash', [resolve(appDir, 'scripts/init-asimov-1.sh')], { stdio: 'inherit' });
    if (init.status !== 0) throw new Error('scripts/init-asimov-1.sh failed');
  }

  const model = await ensureModel(repo, { revision: args.revision, log: console.log });
  if (!model.hasEnvYaml) {
    console.warn(`Warning: ${repo} has no env.yaml, so the viewer falls back to the bundled reference gains, which may not match this policy.`);
  }

  // vite.config.mjs reads these when it loads, so they must be set first.
  process.env.HPV_MODEL_LIBRARY_DIR = model.cacheDir;
  process.env.HPV_MODEL_ROOTS = HF_MODEL_ROOT;

  const { createServer } = await import('vite');
  const server = await createServer({
    root: appDir,
    server: {
      ...(args.port ? { port: args.port } : {}),
      open: args.open ? `/?policy=${encodeURIComponent(model.policyValue)}` : false,
    },
  });
  await server.listen();
  console.log(`\nRunning ${repo}${model.primary === 'policy.onnx' ? '' : ` (${model.primary})`}`);
  server.printUrls();
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
