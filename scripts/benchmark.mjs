#!/usr/bin/env node
// npm run benchmark ...: first-run setup, then the command itself (run-benchmark.mjs,
// which has the usage text). Running a benchmark needs the dependencies, the robot
// model and Chromium; `view` needs the first two; merge, init and path-end only the
// dependencies. Nothing here may import an npm dependency before setup() has installed them.

import { setup, setupBrowser } from './setup.mjs';

const words = process.argv.slice(2);
const first = words[0];
// Usage text and `help` need nothing, so a first look at the usage does not install anything.
if (words.length && !words.includes('help')) {
  try {
    const local = ['merge', 'init', 'path-end'].includes(first);
    setup({ scene: !local });
    if (!local && first !== 'view') await setupBrowser();
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
}
await import('./run-benchmark.mjs');
