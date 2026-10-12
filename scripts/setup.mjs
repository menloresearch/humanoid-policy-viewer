// First-run setup for the launchers (`npm run hf`, `npm run dev`, `npm run
// benchmark`): installs the dependencies when node_modules is missing, fetches
// the Asimov robot model when it is not checked out, and, for the benchmark,
// installs the Chromium that Playwright drives. setup() runs before anything
// imports an npm package, so it may only use Node's own modules; setupBrowser()
// needs the dependencies, so it runs after it.

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

/** `scene: false` for commands that never load the robot (they still need the dependencies). */
export function setup({ log = console.log, scene = true } = {}) {
  if (!existsSync(join(appDir, 'node_modules/vite/package.json'))) {
    log('Installing dependencies (first run only)...');
    run('npm', ['ci']);
  }
  if (scene && !sceneIsInstalled()) {
    log('Fetching the Asimov robot model (first run only)...');
    run('bash', ['scripts/init-asimov-1.sh']);
  }
}

/** Installs the Chromium this version of Playwright launches, if it is not there yet. Call after setup(). */
export async function setupBrowser({ log = console.log } = {}) {
  const { chromium } = await import('@playwright/test');
  if (existsSync(chromium.executablePath())) return;
  log('Installing Chromium for the benchmark (first run only)...');
  run('npx', ['playwright', 'install', 'chromium']);
}
