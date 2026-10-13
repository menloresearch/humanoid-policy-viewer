#!/usr/bin/env node
// npm run benchmark <policy...> [benchmark] [options]
// npm run benchmark merge <dir...>
// npm run benchmark init <dir> | path-end <dir> [<test id>...]
//
// Benchmarks policies against a benchmark (a Hugging Face benchmark
// dataset or a local folder; see scripts/benchmarkDir.mjs) in headless
// Chromium and writes result.json + report.html. It never uploads: a result
// that can be reproduced is submitted afterwards with `npm run hf submit <dir>`.
// Run with no arguments for the full usage text.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityProblems } from '../src/benchmark/settings.js';
import {
  MAX_ROBOTS, RESULT_SCHEMA, buildJobs, cellResult, isComplete, mergeResults, planCells, sortCells, summarize,
} from '../src/benchmark/run.js';
import { rowToSequence } from '../src/benchmark/testRow.js';
import { buildBenchmarkReportHtml } from '../src/simulation/benchmarkReport.js';
import { runJobs } from './benchmarkBrowser.mjs';
import { collectProvenance, policyFileHashes } from './benchmarkProvenance.mjs';
import { formatOutcomes, formatTasks, parseShard, parseTests, resultTarget, shardJobs, submitHint, viewHint } from './benchmarkRun.mjs';
import { classifyTarget, describeTarget } from './benchmarkTargets.mjs';
import { checkPolicyDir, readReferenceJointNames } from './policyChecks.mjs';
import { parsePort, parseWords, rejectSwallowedNpmFlags } from './cliArgs.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { ensurePolicy } from './hfPolicy.mjs';
import { findLocalPolicy } from './localPolicy.mjs';
import { assertTestsRunnable, pathEnds } from './benchmarkCheck.mjs';
import { defaultBenchmarkDir, loadBenchmarkDir } from './benchmarkDir.mjs';
import { initBenchmark } from './benchmarkInit.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KEYS = ['benchmark', 'policy', 'tests', 'repeats', 'jobs', 'robots', 'shard', 'out', 'port'];
const FLAGS = ['force', 'watch', 'verbose', 'help', 'no-open'];
// Words this command took before submitting moved to `npm run hf submit`.
const SUBMIT_MOVED = 'results are submitted separately now: npm run hf submit <result dir> [pr] [dry-run]';
const RETIRED = ['upload', 'no-upload', 'pr', 'dry-run'];
const HINTS = Object.fromEntries(RETIRED.map((word) => [word, SUBMIT_MOVED]));

const USAGE = `Usage:
  npm run benchmark <policy...> [<benchmark>] [key=value...] [flags...]
  npm run benchmark merge <result dir...>
  npm run benchmark view <result dir | result.json> [port=<n>] [no-open]
  npm run benchmark init <dir>
  npm run benchmark path-end <dir> [<test id>...]

  merge                combine the out dirs of a sharded run (shard=)
  view                 open a result on the viewer's results page, in your browser
                       (the same page as http://localhost:<port>/?result=<folder>/result.json
                       on a running \`npm run dev\`); Ctrl+C stops it
  init                 new benchmark: a copy of benchmarks/default (three example tests)
  path-end             where each test's commands end the path (x, y in m, 2 decimals) and
                       whether its end zone contains / is crossed by the path; JSON lines,
                       for picking a goal by hand or from a script

A policy is a Hugging Face model repo (org/name, org/name@rev or its URL) or a local
folder / .onnx file. A benchmark is a Hub dataset (datasets/org/name[@rev] or
its URL) or a local folder with a benchmark.yaml. Without one, ./benchmarks/default
is used.

Options (no "--" needed):
  benchmark=<dir|id>   the benchmark, if not given as a word
  policy=<policy>      more policies (repeatable)
  tests=<id,id>        run only these test ids (results are then local-only)
  repeats=<n>          override every test's repeat count (local-only)
  jobs=<n>             browser pages in parallel (default: half the CPU cores)
  robots=<n>           most repeats of a test a page runs at once, as robots in
                       one scene (1-${MAX_ROBOTS}, default ${MAX_ROBOTS}); results do not depend on it
  shard=<i>/<n>        run slice i of n; combine with \`npm run benchmark merge\`
  out=<dir>            where to write results (default: benchmark_results/<timestamp>)

Flags:
  force                run even if this viewer does not match the benchmark (local-only)
  watch                show the browser and run in real time, one page (a test's
                       repeats walk side by side as see-through robots)
  verbose              print all browser console output

Nothing is uploaded. A result that can be reproduced (Hub policy + Hub benchmark
pinned to a commit, a clean viewer checkout implementing the benchmark's protocol,
the whole benchmark, no failed cells) is submitted to each policy's Hub repo with
\`npm run hf submit <result dir> [pr] [dry-run]\`; the run says whether it can be.

Examples:
  npm run benchmark menloresearch/asimov1-loco
  npm run benchmark ./policies/model_Aug_18_1 benchmark=./benchmarks/default
  npm run benchmark menloresearch/asimov1-loco datasets/<org>/<name>@v1
  npm run benchmark menloresearch/asimov1-loco test/fixtures/smoke-benchmark jobs=2`;

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
}

function parseCount(value, name, { min = 1 } = {}) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw new Error(`${name}= must be an integer >= ${min}`);
  return number;
}

function defaultJobs() {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

async function resolveBenchmark(target = { kind: 'benchmark', source: 'local', path: defaultBenchmarkDir(appDir) }, log) {
  if (target.source === 'local') {
    return { ...loadBenchmarkDir(target.path), info: { source: 'local', path: target.path } };
  }
  const dataset = await ensureDataset(target.id, { revision: target.revision ?? 'main', log });
  return {
    ...loadBenchmarkDir(dataset.dir),
    info: { source: 'hub', id: dataset.id, revision: dataset.revision, sha: dataset.sha },
  };
}

async function resolvePolicy(target, index, log) {
  const key = `m${index}`;
  if (target.source === 'local') {
    const { policyDir, primary } = findLocalPolicy(target.path);
    return { key, id: `local:${policyDir}`, label: policyDir, source: 'local', policyDir, primary, sha: null };
  }
  const policy = await ensurePolicy(target.id, { revision: target.revision ?? 'main', log });
  return { key, id: policy.repo, label: policy.repo, source: 'hub', repo: policy.repo, revision: policy.revision, sha: policy.sha, policyDir: policy.policyDir, primary: policy.primary };
}

function checkPolicies(policies) {
  const jointNames = readReferenceJointNames(appDir);
  for (const policy of policies) {
    const { errors, warnings } = checkPolicyDir(policy.policyDir, jointNames);
    for (const warning of warnings) console.warn(`Warning: ${policy.label}: ${warning}`);
    if (errors.length) throw new Error(`${policy.label} cannot be benchmarked:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

/**
 * A temporary policy library in which every policy folder is linked as its own
 * root, served under /policy-library/<key>/. (The dev server only serves files
 * whose real path is inside a root, so a link cannot sit under a shared root.)
 */
function linkLibrary(policies) {
  const libraryDir = mkdtempSync(join(tmpdir(), 'hpv-bench-'));
  const links = policies.map((policy) => {
    const link = join(libraryDir, policy.key);
    symlinkSync(policy.policyDir, link, 'junction');
    return link;
  });
  // Never a recursive delete: it could reach through a link into a policy folder.
  const cleanup = () => {
    for (const link of links) try { unlinkSync(link); } catch { /* gone */ }
    try { rmdirSync(libraryDir); } catch { /* gone */ }
  };
  return { libraryDir, libraryRoots: policies.map((policy) => policy.key), cleanup };
}

function writeOutputs(outDir, run) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(run));
  writeFileSync(join(outDir, 'report.html'), buildBenchmarkReportHtml(run));
}

/** Each policy's scores, then whether the result can be submitted to the Hub. */
function printSummary(run, outDir) {
  for (const policy of run.policies) {
    console.log(`\n${policy.label}`);
    for (const line of formatTasks(run, policy.key)) console.log(`  ${line}`);
    const outcomes = formatOutcomes(run, policy.key);
    if (outcomes) console.log(`  ${outcomes}`);
  }
  console.log('');
  const dir = relative(process.cwd(), outDir) || '.';
  for (const line of viewHint(dir, join(outDir, 'report.html'))) console.log(line);
  for (const line of submitHint(run, dir)) console.log(line);
}

async function runBenchmarkCommand(args) {
  const { positionals, options, flags } = args;
  const targets = [...positionals, ...(options.policy ?? [])].map((word) => classifyTarget(word));
  if (options.benchmark) targets.push({ ...classifyTarget(options.benchmark), kind: 'benchmark' });
  const benchmarks = targets.filter((t) => t.kind === 'benchmark');
  const policyTargets = targets.filter((t) => t.kind === 'policy');
  if (benchmarks.length > 1) throw new Error(`Give one benchmark, got ${benchmarks.map(describeTarget).join(' and ')}`);
  if (!policyTargets.length) throw new Error(`No policy to benchmark.\n\n${USAGE}`);

  const watch = flags.has('watch');
  const jobsCount = watch ? 1 : parseCount(options.jobs, 'jobs') ?? defaultJobs();
  const repeats = parseCount(options.repeats, 'repeats');
  const robots = parseCount(options.robots, 'robots') ?? MAX_ROBOTS;
  if (robots > MAX_ROBOTS) throw new Error(`robots= must be at most ${MAX_ROBOTS}`);
  const shard = options.shard ? parseShard(options.shard) : null;
  const only = parseTests(options.tests);
  const outDir = resolve(options.out ?? join(appDir, 'benchmark_results', timestamp()));
  const log = (line) => console.log(line);

  const loaded = await resolveBenchmark(benchmarks[0], log);
  const problems = compatibilityProblems(loaded.benchmark);
  if (problems.length && !flags.has('force')) {
    throw new Error(`This viewer cannot run ${describeTarget(benchmarks[0] ?? { kind: 'benchmark', ...loaded.info })}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n(add "force" to run it anyway; the results will be local-only)`);
  }
  // Every test must load before any browser starts, so a broken test fails in a second, not mid-run.
  assertTestsRunnable(loaded);
  const { cells, tests } = planCells(loaded.benchmark, loaded.rows, { only, repeats });

  const policies = [];
  for (const [index, target] of policyTargets.entries()) policies.push(await resolvePolicy(target, index, log));
  checkPolicies(policies);
  for (const policy of policies) policy.files = policyFileHashes(policy.policyDir, policy.primary);

  const allJobs = buildJobs(policies, cells, { maxRobots: robots });
  const jobs = shardJobs(allJobs, shard);
  const cellCount = (list) => list.reduce((sum, job) => sum + job.cells.length, 0);
  const runCells = cellCount(jobs);
  const provenance = collectProvenance(appDir);
  if (provenance.hpv.dirty) console.warn('Warning: this viewer checkout has uncommitted changes; the results will be local-only.');

  console.log(`Benchmark ${loaded.benchmark.name} v${loaded.benchmark.version} (${loaded.info.source === 'hub' ? `datasets/${loaded.info.id}@${loaded.info.sha.slice(0, 7)}` : loaded.info.path}): ${tests.length} tests, ${cells.length} cells`);
  console.log(`Policies: ${policies.map((p) => p.label).join(', ')}`);
  console.log(`Running ${runCells} cell(s) as ${jobs.length} job(s) of up to ${robots} robot(s)${shard ? ` (shard ${shard.index}/${shard.count} of ${cellCount(allJobs)} cells)` : ''} on ${jobsCount} page(s)${watch ? ', real time' : ''}`);

  const { libraryDir, libraryRoots, cleanup } = linkLibrary(policies);
  process.on('exit', cleanup);
  const { startViewer } = await import('./startViewer.mjs');
  const { server, url } = await startViewer({
    policyLibrary: { dir: libraryDir, roots: libraryRoots },
    port: 0,
    editable: false,
    logLevel: 'warn',
  });
  const results = [];
  const started = Date.now();
  let browserVersion = null;
  try {
    const policyUrls = Object.fromEntries(policies.map((p) => [p.key, { onnxPath: `/policy-library/${p.key}/${p.primary}` }]));
    const sequences = Object.fromEntries(tests.map((row) => [row.id, rowToSequence(row)]));
    ({ browserVersion } = await runJobs({
      url,
      jobs,
      policies: policyUrls,
      sequences,
      concurrency: jobsCount,
      headless: !watch,
      realtime: watch,
      verbose: flags.has('verbose'),
      log,
      onResult: (job, cell, result) => {
        results.push(cellResult(job.policyKey, cell, result, result.wallMs));
        const status = result.error ? `ERROR ${result.error}`
          : result.metrics?.fell?.fell ? `fell at ${result.metrics.fell.time}s`
          : result.metrics?.goal && !result.metrics.goal.reached ? `upright, missed end zone by ${result.metrics.goal.miss_m ?? '?'} m`
          : 'ok';
        console.log(`[${results.length}/${runCells}] ${policies.find((p) => p.key === job.policyKey).label} ${cell.cellId}: ${status} (${(result.wallMs / 1000).toFixed(1)}s)`);
      },
    }));
  } finally {
    await server.close();
    cleanup();
  }
  provenance.runtime.chromium = browserVersion;

  const run = {
    schema: RESULT_SCHEMA,
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - started) / 1000),
    provenance,
    benchmark: { ...loaded.info, raw: loaded.rawBenchmark, problems },
    overrides: { tests: only, repeats, force: flags.has('force') && problems.length > 0 },
    shard,
    jobs: jobsCount,
    robots,
    policies: policies.map(({ policyDir, ...rest }) => rest),
    tests,
    expectedCells: cellCount(allJobs),
    cells: sortCells(results),
  };
  Object.assign(run, isComplete(run) ? summarize(run) : {});
  writeOutputs(outDir, run);
  console.log(`\nWrote ${join(outDir, 'result.json')} and report.html (${run.wallSeconds}s)`);

  const errors = run.cells.filter((cell) => cell.error);
  if (shard) {
    console.log(`Shard ${shard.index}/${shard.count} done. When every shard has finished: npm run benchmark merge <their out dirs...>`);
    return errors.length === 0;
  }
  printSummary(run, outDir);
  if (errors.length) console.error(`\n${errors.length} cell(s) failed; see result.json.`);
  return errors.length === 0;
}

async function mergeCommand(args) {
  const { positionals, options } = args;
  const dirs = positionals.slice(1);
  if (!dirs.length) throw new Error('merge needs the out directories of every shard');
  const runs = dirs.map((dir) => {
    const path = existsSync(join(dir, 'result.json')) ? join(dir, 'result.json') : dir;
    return JSON.parse(readFileSync(path, 'utf8'));
  });
  const merged = mergeResults(runs);
  const outDir = resolve(options.out ?? join(appDir, 'benchmark_results', `${timestamp()}_merged`));
  writeOutputs(outDir, merged);
  console.log(`Merged ${runs.length} shards into ${join(outDir, 'result.json')}`);
  printSummary(merged, outDir);
  return merged.cells.every((cell) => !cell.error);
}

/** Serves the viewer on one saved result and opens its results page; runs until Ctrl+C. */
async function viewCommand({ positionals, options, flags }) {
  if (!positionals[1]) throw new Error('view needs a result folder or its result.json');
  if (positionals.length > 2) throw new Error('view takes one result');
  const target = resultTarget(positionals[1]);
  const path = `/?result=${encodeURIComponent(target.file)}`;
  const { startViewer } = await import('./startViewer.mjs');
  const { server } = await startViewer({
    resultsDir: target.resultsDir,
    port: parsePort(options.port),
    open: flags.has('no-open') ? false : path,
    editable: false,
    logLevel: 'warn',
  });
  console.log(`Viewing ${join(target.dir, 'result.json')}`);
  for (const url of server.resolvedUrls?.local ?? []) console.log(`  ➜  ${new URL(path, url)}`);
  console.log(`Report file: ${join(target.dir, 'report.html')}\nCtrl+C to stop.`);
  // Keeps running: the open server holds the process; a signal ends it.
  return new Promise((done) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().then(() => done(true)));
  });
}

function initCommand({ positionals }) {
  if (!positionals[1]) throw new Error('init needs <dir>');
  initBenchmark(resolve(positionals[1]));
  return true;
}

function pathEndCommand({ positionals }) {
  if (!positionals[1]) throw new Error('path-end needs <dir>');
  const { rows } = loadBenchmarkDir(resolve(positionals[1]));
  for (const line of pathEnds(rows, positionals.slice(2))) console.log(JSON.stringify(line));
  return true;
}

const COMMANDS = { merge: mergeCommand, view: viewCommand, init: initCommand, 'path-end': pathEndCommand };

async function main() {
  rejectSwallowedNpmFlags(process.env, { keys: KEYS, flags: FLAGS, hints: HINTS });
  const args = parseWords(process.argv.slice(2), { keys: KEYS, flags: FLAGS, repeatable: ['policy'], hints: HINTS });
  const retired = args.positionals.filter((word) => RETIRED.includes(word));
  if (retired.length) throw new Error(`"${retired.join(' ')}": ${SUBMIT_MOVED}`);
  if (args.flags.has('help') || (!args.positionals.length && !args.options.policy)) {
    console.log(USAGE);
    return args.flags.has('help');
  }
  return (COMMANDS[args.positionals[0]] ?? runBenchmarkCommand)(args);
}

main().then((ok) => {
  process.exitCode = ok ? 0 : 1;
}).catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
