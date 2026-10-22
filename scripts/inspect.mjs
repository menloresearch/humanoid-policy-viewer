#!/usr/bin/env node
// node scripts/inspect.mjs benchmark <dir> [<commit>]
// node scripts/inspect.mjs policy <folder | file.onnx>
//
// Offline inspection for the tools that publish benchmarks and submit results
// (cyclotron): what this viewer reads from a benchmark folder or a policy, as one
// JSON object on stdout, so they never import HPV's internals. Also reachable as
// `npm run -s benchmark inspect <dir> [<commit>]` and `npm run -s benchmark
// policy-info <path>` (-s keeps npm's own banner off stdout). It needs only the
// npm dependencies: no robot model, no browser, no network, no Hugging Face.
// A problem that stops the folder from loading at all is printed on stderr, exit 1.
//
// benchmark (schema hpv-inspection/1):
//   raw             benchmark.yaml, parsed
//   rows            every test row, as the viewer reads it (start as an object)
//   tasks           leaderboard tasks for eval.yaml: [{ id, config, split }] (taskDescriptors)
//   errors          problems that stop a run (checkTests) or a publish (an unusable license:)
//   warnings        likely mistakes (checkTests)
//   problems        why this viewer cannot run the benchmark as specified (compatibilityProblems)
//   cells, tests    the run plan (planCells): every cell a full run has, and the tests in it
//   scored_hash     hash of everything that can change a score (scoredContentHash)
//   files           the publishable files in the folder (BENCHMARK_FILES), sorted
//   provenance      this viewer checkout: commit, dirty, protocol, robot model commit, runtime
//   public          whether that commit is on a fetched branch of the public HPV repo
//   card            dataset card front matter: configs, features, tags, license fields
//   benchmark_yaml  benchmark.yaml with harness.tested_commit set to <commit>; null without one
//   publish_files   { path: exact text to upload } for every file in `files` but README.md:
//                   benchmark.yaml as benchmark_yaml (as on disk without a commit), each
//                   data/*/test.jsonl in its Hub form (hubRowsText), the rest as they are.
//                   README.md is the card's body; the publisher puts `card` in front of it.
//
// policy (schema hpv-policy-inspection/1):
//   policyDir, primary   the folder and the .onnx the viewer would run (findLocalPolicy)
//   hashes               { onnx, envYaml }: sha256 of the files a result records (policyFileHashes)
//   errors, warnings     what checkPolicyDir finds in its env.yaml and agent.yaml

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTests } from '../src/benchmark/check.js';
import { planCells } from '../src/benchmark/run.js';
import { compatibilityProblems, taskDescriptors } from '../src/benchmark/settings.js';
import {
  BENCHMARK_FILE, BENCHMARK_FILES, cardFrontMatter, hubRowsText, licenseFields, loadBenchmarkDir, scoredContentHash, withTestedCommit,
} from './benchmarkDir.mjs';
import { collectProvenance, onPublicRepo, policyFileHashes } from './benchmarkProvenance.mjs';
import { findLocalPolicy } from './localPolicy.mjs';
import { checkPolicyDir, readReferenceJointNames } from './policyChecks.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INSPECTION_SCHEMA = 'hpv-inspection/1';
export const POLICY_INSPECTION_SCHEMA = 'hpv-policy-inspection/1';

export const USAGE = `Usage:
  node scripts/inspect.mjs benchmark <dir> [<commit>]   (npm run -s benchmark inspect <dir> [<commit>])
  node scripts/inspect.mjs policy <folder | file.onnx>  (npm run -s benchmark policy-info <path>)

Prints what this viewer reads from a benchmark folder (schema ${INSPECTION_SCHEMA}) or a
policy (schema ${POLICY_INSPECTION_SCHEMA}) as JSON. <commit> is the viewer commit to
record as harness.tested_commit in the benchmark.yaml to publish. Offline: nothing
is downloaded or uploaded. See docs/benchmarks.md.`;

/** Every file under `dir` a benchmark is published with, sorted; dot folders are skipped. */
export function benchmarkFiles(dir) {
  const files = [];
  (function walk(sub) {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(rel);
      } else if (entry.isFile() && BENCHMARK_FILES.some((re) => re.test(rel))) files.push(rel);
    }
  })('');
  return files.sort();
}

function checkCommit(commit) {
  if (commit != null && !/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`"${commit}" is not a commit hash`);
  return commit ?? null;
}

/** What this viewer reads from the benchmark folder `dir` (see the top of this file). */
export function inspectBenchmark(dir, { commit = null, appDir = APP_DIR } = {}) {
  const directory = resolve(dir);
  checkCommit(commit);
  const loaded = loadBenchmarkDir(directory);
  const { benchmark, rawBenchmark, rows } = loaded;
  const checks = checkTests(loaded);
  const errors = [...checks.errors];
  const name = rawBenchmark.title ?? benchmark.name;
  let license = {};
  try {
    license = licenseFields(directory, rawBenchmark.license, benchmark.name);
  } catch (error) {
    errors.push(error.message);
  }
  const plan = checks.errors.length ? { cells: [], tests: [] } : planCells(benchmark, rows);
  const files = benchmarkFiles(directory);
  const yamlText = readFileSync(join(directory, BENCHMARK_FILE), 'utf8');
  const benchmarkYaml = commit ? withTestedCommit(yamlText, commit) : null;
  const publishFiles = {};
  for (const path of files) {
    if (path === 'README.md') continue;
    if (path === BENCHMARK_FILE) publishFiles[path] = benchmarkYaml ?? yamlText;
    else {
      const text = readFileSync(join(directory, path), 'utf8');
      publishFiles[path] = /^data\/[^/]+\/test\.jsonl$/.test(path) ? hubRowsText(text) : text;
    }
  }
  const provenance = collectProvenance(appDir);
  return {
    schema: INSPECTION_SCHEMA,
    raw: rawBenchmark,
    rows,
    tasks: taskDescriptors(benchmark),
    errors,
    warnings: checks.warnings,
    problems: compatibilityProblems(benchmark),
    cells: plan.cells,
    tests: plan.tests,
    scored_hash: scoredContentHash(rawBenchmark, rows),
    files,
    provenance,
    public: onPublicRepo(appDir, provenance.hpv.commit),
    card: cardFrontMatter(rows, { license, tags: rawBenchmark.tags, prettyName: name }),
    benchmark_yaml: benchmarkYaml,
    publish_files: publishFiles,
  };
}

/** The policy the viewer would run from `path` (a folder or an .onnx file), its file hashes and its problems. */
export function inspectPolicy(path, { appDir = APP_DIR } = {}) {
  const { policyDir, primary } = findLocalPolicy(path);
  const { errors, warnings } = checkPolicyDir(policyDir, readReferenceJointNames(appDir));
  return { schema: POLICY_INSPECTION_SCHEMA, policyDir, primary, hashes: policyFileHashes(policyDir, primary), errors, warnings };
}

/** The inspection `argv` asks for: ['benchmark', dir, commit?] or ['policy', path]. */
export function inspect(argv) {
  const [command, path, ...rest] = argv;
  if (command === 'benchmark' && path && rest.length <= 1) return inspectBenchmark(path, { commit: rest[0] ?? null });
  if (command === 'policy' && path && !rest.length) return inspectPolicy(path);
  throw new Error(USAGE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(inspect(process.argv.slice(2)))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
