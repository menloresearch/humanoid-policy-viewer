#!/usr/bin/env node
// npm run dev [benchmark=<benchmark dir | datasets/<org>/<name>[@rev]>] [policy=<org>/<name>[@rev]...]
//             [port=<n>]
//
// Starts the viewer's dev server on every interface (scripts/startViewer.mjs).
// The trajectory editor and the in-app benchmark read and write the tests of a
// benchmark folder (see scripts/benchmarkDir.mjs and docs/benchmark-datasets.md):
// benchmark=<dir>, or by default the tracked example benchmark ./benchmarks/default.
// A Hugging Face dataset is pulled on first use into ./benchmarks/<org>__<name>
// (gitignored), an ordinary working copy (edit it, `npm run suite diff` /
// `publish` it); later runs reuse it as is. That folder is where the app opens
// first; its "New benchmark" button adds more under ./benchmarks/ and the app
// switches between them.
//
// Policies: the policy list shows ./policies and every Hugging Face policy already
// downloaded (by `npm run hf` or policy=), labelled by repo id. policy=<org>/<name>
// downloads one first if it is not cached (repeatable). If HPV_POLICY_LIBRARY_DIR
// or HPV_POLICY_ROOTS is set, that library is used as is instead.
//
// Nothing here may import an npm dependency before setup() has installed them.

import { normalizeRepoId } from './hfPolicy.mjs';
import { setup } from './setup.mjs';

const USAGE = 'Usage: npm run dev [benchmark=<dir | datasets/<org>/<name>[@rev]>] [policy=<org>/<name>[@rev]...] [port=<n>]';

function fail(message) {
  console.error(message);
  process.exit(2);
}

let benchmark = null;
let port;
const policies = [];
for (const word of process.argv.slice(2)) {
  const [, key, value] = /^(?:--)?(benchmark|policy|port)=(.+)$/.exec(word) ?? [];
  if (key === 'policy') {
    try {
      normalizeRepoId(value.split('@')[0]);
    } catch (error) {
      fail(error.message);
    }
    policies.push(value);
  } else if (key === 'benchmark') {
    benchmark = value;
  } else if (key === 'port') {
    port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port must be 1-65535');
  } else {
    fail(`Unknown argument: ${word}\n${USAGE}`);
  }
}
for (const name of ['benchmark', 'policy', 'port']) {
  if (process.env[`npm_config_${name}`]) fail(`npm kept --${name} for itself; write ${name}=<value> (no dashes).`);
}

setup();
const { startViewer } = await import('./startViewer.mjs');
let viewer;
try {
  viewer = await startViewer({ benchmark, policies, host: true, port });
} catch (error) {
  fail(error.message);
}
console.log(`Tests: benchmark ${viewer.benchmarkDir}`);
viewer.server.printUrls();
viewer.server.bindCLIShortcuts({ print: true });
