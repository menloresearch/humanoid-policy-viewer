#!/usr/bin/env node
// npm run hf <policy...> [<benchmark>] [policy=<...>] [benchmark=<...>] [port=<n>] [no-open]
//
// The Hugging Face command: downloads the policy (or links one from disk) and
// starts the viewer on localhost with it selected. Hugging Face's `asimov`
// library snippet runs `npm run hf <model id>` from every `library_name: asimov`
// model page. Several policies, or a folder of policies, are all listed in the
// viewer's policy list, the first one selected. HPV only reads from the Hub;
// publishing benchmarks and submitting results are done with cyclotron.
// Run with no arguments for the usage text.
// Nothing here may import an npm dependency before setup() has installed them.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitTargets } from './benchmarkTargets.mjs';
import { parsePort, parseWords, rejectSwallowedNpmFlags } from './cliArgs.mjs';
import { HF_POLICY_ROOT, defaultCacheDir } from './hfPolicy.mjs';
import { setup } from './setup.mjs';
import { cleanupOnExit, libraryFor, printPolicyWarnings, resolvePolicies } from './viewPolicies.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CYCLOTRON = 'https://github.com/menloresearch/cyclotron';

const USAGE = `Usage:
  npm run hf <policy...> [<benchmark>] [port=<n>] [no-open]

Downloads a policy from Hugging Face (policy .onnx + env.yaml) and opens the viewer
with it selected. Example: npm run hf Menlo/asimov1-locomotion-0818
A policy is a Hub model repo (org/name, org/name@<branch|tag|commit> or its URL)
or a folder / .onnx file on disk, run in place with no download. The folder needs
the same files as a Hub repo: the .onnx and env.yaml (or params/env.yaml) next to
it. Example: npm run hf ./my-policy
Several policies, or a folder of policies (every folder below it holding an .onnx
with an env.yaml, e.g. a training run's logs), are all listed in the viewer's policy
list and the first one is selected. Example: npm run hf ./logs/rsl_rl/asimov Menlo/asimov1-locomotion-0818

A benchmark (default ./benchmarks/default) is a folder with a benchmark.yaml, or a
Hub dataset datasets/org/name[@rev] (or its URL), downloaded and opened read-only.
Policies and the benchmark can come in any order.

  policy=<...>         a policy, when the word alone could be read as something else (repeatable)
  benchmark=<...>      the benchmark, likewise
  port=<n>             dev server port (default: 3000, or the next free one)
  no-open              do not open a browser window

Write options as key=value and flags as plain words, without "--".

HPV only reads from Hugging Face. Publishing benchmarks and submitting results
are done with cyclotron (${CYCLOTRON}).

Environment:
  HF_TOKEN             access token, needed for private repos; without it, the token
                       \`hf auth login\` saved (HF_TOKEN_PATH, else HF_HOME/token, else
                       ~/.cache/huggingface/token)
  HF_ENDPOINT          alternative Hub endpoint (default: https://huggingface.co)
  HPV_CACHE_DIR        where downloads are kept (default: ~/.cache/humanoid-policy-viewer)
  More in docs/architecture.md (Environment variables).`;

// The Hub write verbs `npm run hf` had; cyclotron does all of that now.
export const RETIRED_VERBS = ['pull', 'diff', 'baseline', 'publish', 'release', 'submit'];
const VIEW = { keys: ['benchmark', 'policy', 'port'], flags: ['no-open', 'help'], repeatable: ['policy'] };
// Names the old `npm run hf` took as --flags, spelled the new way.
const HINTS = { revision: 'write the revision as org/name@rev (e.g. Menlo/asimov1-locomotion-0818@main)' };

/** The one-line answer to a retired verb (publish, submit, ...). */
export function retiredVerbMessage(verb) {
  return `npm run hf ${verb} is gone: HPV only reads from Hugging Face; publishing benchmarks and submitting results are done with cyclotron (${CYCLOTRON}).`;
}

/** The words of `npm run hf <policy...> ...`: { policies, benchmark, port, open, help } (policies and benchmark classified). */
export function viewArgs(argv, env = process.env) {
  const spec = { ...VIEW, hints: HINTS };
  rejectSwallowedNpmFlags(env, spec);
  const { positionals, options, flags } = parseWords(argv, spec);
  if (flags.has('help')) return { help: true };
  const { policies, benchmark } = splitTargets(positionals, options);
  if (!policies.length) throw new Error(`No policy given.\n\n${USAGE}`);
  return { policies, benchmark, port: parsePort(options.port), open: !flags.has('no-open') };
}

async function view(argv) {
  const { help, policies: targets, benchmark, port, open } = viewArgs(argv);
  if (help) return console.log(USAGE);

  setup();

  const cacheDir = defaultCacheDir();
  const found = await resolvePolicies(targets, { appDir, cacheDir, log: console.log });
  for (const policy of found) printPolicyWarnings(policy);
  // A policy named on the command line must run; one found in a folder of policies is left out instead.
  const fatal = found.filter((policy) => policy.errors.length && !policy.scanned);
  if (fatal.length) {
    throw new Error(fatal.map((policy) => `${policy.name} cannot be run:\n${policy.errors.map((error) => `  - ${error}`).join('\n')}`).join('\n'));
  }
  for (const policy of found.filter((p) => p.errors.length)) {
    console.warn(`\nWarning: left out ${policy.name}, which cannot be run:\n${policy.errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  const policies = found.filter((policy) => !policy.errors.length);
  if (!policies.length) throw new Error('None of these policies can be run.');
  if (!found.some((policy) => policy.warnings.length || policy.errors.length)) {
    console.log(`Checked env.yaml and agent.yaml${policies.length > 1 ? ` of ${policies.length} policies` : ''}: OK`);
  }
  console.log('');

  // Only the policies given are listed, plus every download in the Hub cache when one is from the Hub.
  const base = policies.some((policy) => policy.source === 'hub') ? { dir: cacheDir, roots: [HF_POLICY_ROOT] } : { dir: cacheDir, roots: [] };
  const library = libraryFor(policies, { base });
  if (library.dir !== base.dir) cleanupOnExit(library.cleanup);

  const [first, ...others] = policies;
  // The bare URL opens the bundled example policy; this path selects the first one given.
  const policyPath = `/?policy=${encodeURIComponent(first.value)}`;
  const { startViewer } = await import('./startViewer.mjs');
  const { server } = await startViewer({
    benchmark,
    policyLibrary: library,
    port,
    open: open ? policyPath : false,
  });
  console.log(`\nRunning ${first.name}${first.primary === 'policy.onnx' ? '' : ` (${first.primary})`}`);
  if (others.length) console.log(`Also in the policy list: ${others.map((policy) => policy.label).join(', ')}`);
  const urls = server.resolvedUrls;
  if (!urls) {
    server.printUrls();
    return;
  }
  // Print links that open this policy, so copying one from a headless or SSH session works too.
  for (const url of urls.local) console.log(`  ➜  Local:   ${new URL(policyPath, url)}`);
  for (const url of urls.network) console.log(`  ➜  Network: ${new URL(policyPath, url)}`);
}

/** What the first word asks for: the usage text, a retired Hub write verb, or policies to view. */
export function command(argv) {
  const first = argv[0];
  if (first === undefined || first === 'help') return 'help';
  if (RETIRED_VERBS.includes(first)) return 'retired';
  return 'view';
}

async function main(argv) {
  const which = command(argv);
  if (which === 'help') {
    console.log(USAGE);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  if (which === 'retired') throw new Error(retiredVerbMessage(argv[0]));
  return view(argv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
