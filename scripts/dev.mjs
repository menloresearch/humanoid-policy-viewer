#!/usr/bin/env node
// npm run dev [<org>/<name>[@rev]...] [benchmark=<benchmark dir | datasets/<org>/<name>[@rev]>]
//             [port=<n>]
//
// Starts the viewer's dev server on every interface (scripts/startViewer.mjs).
// The trajectory editor and the in-app benchmark read and write the tests of a
// benchmark folder (see scripts/benchmarkDir.mjs and docs/benchmarks.md):
// benchmark=<dir>, or by default the tracked example benchmark ./benchmarks/default.
// A Hugging Face dataset is pulled on first use into ./benchmarks/<org>__<name>
// (gitignored), an ordinary working copy (edit it, `npm run hf diff` /
// `publish` it); later runs reuse it as is. That folder is where the app opens
// first; its "New benchmark" button adds more under ./benchmarks/ and the app
// switches between them.
//
// Policies: the policy list shows ./policies and every Hugging Face policy already
// downloaded (by `npm run hf` or this command), labelled by repo id. Each
// <org>/<name> word downloads that policy first if it is not cached. If
// HPV_POLICY_LIBRARY_DIR or HPV_POLICY_ROOTS is set, that library is used as is instead.
//
// Nothing here may import an npm dependency before setup() has installed them.

import { classifyTarget, describeTarget } from './benchmarkTargets.mjs';
import { parsePort, parseWords, rejectSwallowedNpmFlags } from './cliArgs.mjs';
import { setup } from './setup.mjs';

const USAGE = 'Usage: npm run dev [<org>/<name>[@rev]...] [benchmark=<dir | datasets/<org>/<name>[@rev]>] [port=<n>]';

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** The words of `npm run dev`: { policies, benchmark, port }. */
function devArgs(argv, env = process.env) {
  const spec = { keys: ['benchmark', 'port', 'policy'], flags: ['help'], repeatable: ['policy'] };
  rejectSwallowedNpmFlags(env, spec);
  const { positionals, options, flags } = parseWords(argv, spec);
  if (flags.has('help')) return { help: true };
  if (options.policy) throw new Error(`Write policies as plain words: npm run dev ${options.policy.join(' ')}`);
  const policies = positionals.map((word) => {
    const target = classifyTarget(word);
    if (target.kind === 'benchmark') throw new Error(`${word} is a benchmark; write benchmark=${word}`);
    if (target.source === 'local') throw new Error(`${word} is on disk: put it under ./policies (listed already) or run npm run hf ${word}`);
    return describeTarget(target);
  });
  return { policies, benchmark: options.benchmark ?? null, port: parsePort(options.port) };
}

let args;
try {
  args = devArgs(process.argv.slice(2));
} catch (error) {
  fail(`${error.message}\n${USAGE}`);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

setup();
const { startViewer } = await import('./startViewer.mjs');
let viewer;
try {
  viewer = await startViewer({ benchmark: args.benchmark, policies: args.policies, host: true, port: args.port });
} catch (error) {
  fail(error.message);
}
console.log(`Tests: benchmark ${viewer.benchmarkDir}`);
viewer.server.printUrls();
viewer.server.bindCLIShortcuts({ print: true });
