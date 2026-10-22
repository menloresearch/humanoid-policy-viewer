#!/usr/bin/env node
// npm run dev [<policy>...] [<benchmark>] [policy=<...>] [benchmark=<...>] [port=<n>]
//
// Starts the viewer's dev server on every interface (scripts/startViewer.mjs).
// The trajectory editor and the in-app benchmark read and write the tests of a
// benchmark folder (see scripts/benchmarkDir.mjs and docs/benchmarks.md):
// benchmark=<dir>, or by default the tracked example benchmark ./benchmarks/default.
// A Hugging Face dataset (benchmark=datasets/<org>/<name>[@rev]) is downloaded
// into the cache and opened read-only. That benchmark is where the app opens
// first; its "New benchmark" button adds more under ./benchmarks/ and the app
// switches between them.
//
// Policies: the policy list shows ./policies and every Hugging Face policy already
// downloaded (by `npm run hf` or this command), labelled by repo id. Each
// <org>/<name> word downloads that policy first if it is not cached; a folder or
// .onnx on disk, or a folder of policies (every folder below it holding an .onnx
// with an env.yaml), is listed too, labelled by its shortest distinguishing path.
// Policies and the benchmark can come in any order. If HPV_POLICY_LIBRARY_DIR or
// HPV_POLICY_ROOTS is set, that library is used instead of ./policies and the cache.
//
// Nothing here may import an npm dependency before setup() has installed them.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitTargets } from './benchmarkTargets.mjs';
import { parsePort, parseWords, rejectSwallowedNpmFlags } from './cliArgs.mjs';
import { setup } from './setup.mjs';

const USAGE = `Usage: npm run dev [<policy>...] [<benchmark>] [policy=<...>] [benchmark=<...>] [port=<n>]

A policy is a Hub model repo (org/name[@rev]), a folder or .onnx on disk, or a folder
of policies; a benchmark a folder with a benchmark.yaml or a Hub dataset
(datasets/org/name[@rev], opened read-only). They can come in any order; policy= and
benchmark= say which a word is. HPV only reads from Hugging Face.`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** The words of `npm run dev`: { policies, benchmark, port } (policies and benchmark classified). */
export function devArgs(argv, env = process.env) {
  const spec = { keys: ['benchmark', 'port', 'policy'], flags: ['help'], repeatable: ['policy'] };
  rejectSwallowedNpmFlags(env, spec);
  const { positionals, options, flags } = parseWords(argv, spec);
  if (flags.has('help')) return { help: true };
  const { policies, benchmark } = splitTargets(positionals, options);
  return { policies, benchmark, port: parsePort(options.port) };
}

async function main() {
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
