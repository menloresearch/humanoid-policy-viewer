// First-run setup for the launchers (`npm run hf`, `npm run dev`): installs the
// dependencies when node_modules is missing and fetches the Asimov robot model
// when it is not checked out. It runs before anything imports an npm package,
// so it may only use Node's own modules.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function sceneIsInstalled(dir = appDir) {
  return existsSync(join(dir, 'public/examples/scenes/asimov-1/sim-model/xmls/asimov_1.xml'));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` failed`);
}

export function setup({ log = console.log } = {}) {
  if (!existsSync(join(appDir, 'node_modules/vite/package.json'))) {
    log('Installing dependencies (first run only)...');
    run('npm', ['ci']);
  }
  if (!sceneIsInstalled()) {
    log('Fetching the Asimov robot model (first run only)...');
    run('bash', ['scripts/init-asimov-1.sh']);
  }
}
