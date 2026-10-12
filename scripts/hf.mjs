#!/usr/bin/env node
// npm run hf <org/name[@rev] | folder | file.onnx> [benchmark=<...>] [port=<n>] [no-open]
// npm run hf pull|diff|baseline|publish|release|submit ...
//
// The Hugging Face command. With a policy it downloads the policy (or links one
// from disk) and starts the viewer with it selected. Its verbs work on a
// benchmark dataset on the Hub (scripts/hfBenchmark.mjs), or submit benchmark
// results to the policies' model repos (scripts/hfSubmit.mjs).
// Run with no arguments for the usage text.
// Nothing here may import an npm dependency before setup() has installed them.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './benchmarkTargets.mjs';
import { parsePort, parseWords, rejectSwallowedNpmFlags } from './cliArgs.mjs';
import { HF_POLICY_ROOT, ensurePolicy } from './hfPolicy.mjs';
import { linkLocalPolicy } from './localPolicy.mjs';
import { checkPolicyDir, libraryNameWarning, readReferenceJointNames } from './policyChecks.mjs';
import { setup } from './setup.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  npm run hf <policy> [benchmark=<dir | datasets/org/name[@rev]>] [port=<n>] [no-open]
  npm run hf <verb> ...

With a policy, downloads it from Hugging Face (policy .onnx + env.yaml) and opens
the viewer with it selected. Example: npm run hf Menlo/asimov1-locomotion-0818
A policy is a Hub model repo (org/name, org/name@<branch|tag|commit> or its URL)
or a folder / .onnx file on disk, run in place with no download. The folder needs
the same files as a Hub repo: the .onnx and env.yaml (or params/env.yaml) next to
it. Example: npm run hf ./my-policy

  benchmark=<...>      the benchmark the viewer opens (default ./benchmarks/default)
  port=<n>             dev server port (default: 3000, or the next free one)
  no-open              do not open a browser window

Verbs, for a benchmark dataset on the Hub:
  pull <dataset>[@rev|@refs/pr/<n>] <dir>  working copy of a Hub dataset (e.g. datasets/org/bench@refs/pr/3)
  diff <dir> [repo=] [base=]               what changed compared with the dataset's main (or base=<rev>)
  baseline <dir> [repo=] [base=] [policy=<policy>...]
                                           run reference policies on the folder and on main (or base=);
                                           writes <dir>/baseline.md
  publish <dir> [repo=<org/name>] [base=<rev>] [pr] [create] [dry-run]
                                           check against main (or base=, which must still be main), build
                                           eval.yaml + the dataset card, then commit and tag v<version>
                                           (owner) or open a pull request; "create" makes a new PRIVATE
                                           dataset repo
  release <dataset> rev=<commit>           tag a revision v<version> (a merged pull request)

  repo= is the dataset (org/name); it can be left out for a folder made by pull.

For benchmark results:
  submit <result dir> [pr] [dry-run]       add the results of \`npm run benchmark\` to each policy's model
                                           repo (.eval_results + eval_logs): a commit if you own it, else
                                           (or with pr) a pull request. Only reproducible results.

Write options as key=value and flags as plain words, without "--".

Environment:
  HF_TOKEN             access token, needed for private repos and for writing
  HF_ENDPOINT          alternative Hub endpoint (default: https://huggingface.co)
  HPV_CACHE_DIR        where downloads are kept (default: ~/.cache/humanoid-policy-viewer)`;

const VERBS = {
  pull: {},
  diff: { keys: ['repo', 'base'] },
  baseline: { keys: ['policy', 'repo', 'base'], repeatable: ['policy'] },
  publish: { keys: ['repo', 'base'], flags: ['pr', 'create', 'dry-run'] },
  release: { keys: ['rev'] },
  submit: { flags: ['pr', 'dry-run'] },
};
const VIEW = { keys: ['benchmark', 'port'], flags: ['no-open'] };
// Names the old `npm run hf` took as --flags, spelled the new way.
const HINTS = { revision: 'write the revision as org/name@rev (e.g. Menlo/asimov1-locomotion-0818@main)' };

function words(argv, spec) {
  const options = { keys: spec.keys ?? [], flags: [...(spec.flags ?? []), 'help'], repeatable: spec.repeatable ?? [], hints: HINTS };
  rejectSwallowedNpmFlags(process.env, options);
  return parseWords(argv, options);
}

/** The dir argument of a verb, resolved; a missing one is an error, not the current folder. */
function needDir(verb, dir) {
  if (!dir) throw new Error(`${verb} needs <dir>\n\n${USAGE}`);
  return resolve(dir);
}

async function runVerb(verb, argv) {
  const { positionals, options, flags } = words(argv, VERBS[verb]);
  if (flags.has('help')) return console.log(USAGE);
  const [a, b] = positionals;
  const { repo, base } = options;
  setup();
  if (verb === 'submit') {
    const { submit } = await import('./hfSubmit.mjs');
    return submit(needDir(verb, a), { pr: flags.has('pr'), dryRun: flags.has('dry-run') });
  }
  const hub = await import('./hfBenchmark.mjs');
  switch (verb) {
    case 'pull': return hub.pull(a, b && resolve(b));
    case 'diff': return hub.diff(needDir(verb, a), { repo, base });
    case 'baseline': return hub.baseline(needDir(verb, a), options.policy ?? [], { repo, base });
    case 'publish': return hub.publish(needDir(verb, a), { repo, base, pr: flags.has('pr'), create: flags.has('create'), dryRun: flags.has('dry-run') });
    case 'release': return hub.release(a, options.rev);
  }
}

/** The words of `npm run hf <policy> ...`: { word, target, benchmark, port, open, help }. */
export function viewArgs(argv) {
  const { positionals, options, flags } = words(argv, VIEW);
  if (flags.has('help')) return { help: true };
  const [word, ...extra] = positionals;
  if (!word) throw new Error(`No policy given.\n\n${USAGE}`);
  if (extra.length) throw new Error(`One policy at a time (got ${positionals.join(' ')}); npm run dev lists several.`);
  const target = classifyTarget(word);
  if (target.kind === 'benchmark') throw new Error(`${word} is a benchmark, not a policy; open it with npm run dev benchmark=${word}`);
  return { word, target, benchmark: options.benchmark ?? null, port: parsePort(options.port), open: !flags.has('no-open') };
}

async function view(argv) {
  const { help, word, target, benchmark, port, open } = viewArgs(argv);
  if (help) return console.log(USAGE);
  const local = target.source === 'local' ? linkLocalPolicy(word) : null;
  if (local) {
    // Remove the temporary link however the server stops; a signal alone skips 'exit'.
    process.on('exit', local.cleanup);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
  }

  setup();

  const policy = local ?? await ensurePolicy(target.id, { revision: target.revision ?? 'main', log: console.log });
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
    benchmark,
    policyLibrary: { dir: policy.cacheDir, roots: [local ? local.root : HF_POLICY_ROOT] },
    port,
    open: open ? policyPath : false,
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

/** What the first word asks for: a verb, the usage text, or a policy to view. */
export function command(argv) {
  const first = argv[0];
  if (first === undefined || first === 'help') return 'help';
  if (Object.hasOwn(VERBS, first)) return first;
  return 'view';
}

async function main(argv) {
  const which = command(argv);
  if (which === 'help') {
    console.log(USAGE);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  return which === 'view' ? view(argv) : runVerb(which, argv.slice(1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
