#!/usr/bin/env node
// npm run benchmark <policy...> [benchmark] [options]
// npm run benchmark merge <dir...> [upload] [pr] [dry-run]
//
// Benchmarks policies against a benchmark (a Hugging Face benchmark
// dataset or a local folder; see scripts/benchmarkDir.mjs) in headless
// Chromium, writes result.json + report.html + the .eval_results entries, and,
// when the run is shareable, uploads them to each policy's Hub repo.
// Run with no arguments for the full usage text.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityProblems, expandCells, selectTests } from '../src/benchmark/settings.js';
import { rowToSequence } from '../src/benchmark/testRow.js';
import { buildBenchmarkReportHtml } from '../src/simulation/benchmarkReport.js';
import { runJobs, startViewerServer } from './benchmarkBrowser.mjs';
import { collectProvenance, policyFileHashes } from './benchmarkProvenance.mjs';
import {
  MAX_ROBOTS, RESULT_SCHEMA, buildJobs, formatOutcomes, formatTasks, isComplete, mergeResults, parseShard, resultForPolicy, shardJobs, summarizeRun, toReportRun, uploadBlockers,
} from './benchmarkRun.mjs';
import { classifyTarget, describeTarget } from './benchmarkTargets.mjs';
import { checkPolicyDir, readReferenceJointNames } from './policyChecks.mjs';
import { parseWords, swallowedNpmFlags } from './cliArgs.mjs';
import { commitFiles, readRepoText } from './hfCommit.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { buildEvalResultEntries, evalLogsDir, evalResultsPath, mergeEvalResults } from './hfEvalResults.mjs';
import { ensurePolicy } from './hfPolicy.mjs';
import { findLocalPolicy } from './localPolicy.mjs';
import { assertTestsRunnable } from './benchmarkCheck.mjs';
import { loadBenchmarkDir } from './benchmarkDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KEYS = ['benchmark', 'policy', 'tests', 'repeats', 'jobs', 'robots', 'shard', 'out'];
const FLAGS = ['pr', 'dry-run', 'no-upload', 'upload', 'force', 'watch', 'verbose', 'help'];

const USAGE = `Usage:
  npm run benchmark <policy...> [<benchmark>] [key=value...] [flags...]
  npm run benchmark merge <result dir...> [upload] [pr] [dry-run]

A policy is a Hugging Face model repo (org/name, org/name@rev or its URL) or a local
folder / .onnx file. A benchmark is a Hub dataset (datasets/org/name[@rev] or
its URL) or a local folder with a benchmark.yaml. Without one, the released
default (src/benchmark/default-suite.json) is used.

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
  dry-run              do everything except write to the Hub; shows what would be written
  no-upload            never upload
  pr                   upload as a pull request even if you could commit directly
  force                run even if this viewer does not match the benchmark (local-only)
  watch                show the browser and run in real time, one page (a test's
                       repeats walk side by side as see-through robots)
  verbose              print all browser console output

Results are uploaded only when they can be reproduced: Hub policy + Hub benchmark,
a clean viewer checkout implementing the benchmark's protocol, the whole benchmark, and
no failed cells. Uploading needs HF_TOKEN (or \`hf auth login\`).

Examples:
  npm run benchmark menloresearch/asimov1-loco
  npm run benchmark ./policies/model_Aug_18_1 benchmark=./benchmarks/default
  npm run benchmark menloresearch/asimov1-loco datasets/<org>/<name>@v1 pr
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

async function resolveBenchmark(target, log) {
  if (!target) {
    const fallback = JSON.parse(readFileSync(join(appDir, 'src/benchmark/default-suite.json'), 'utf8'));
    if (!fallback.dataset || !fallback.revision) {
      throw new Error(`No default benchmark has been released yet (src/benchmark/default-suite.json). Give one: a local folder (e.g. test/fixtures/smoke-benchmark) or datasets/<org>/<name>.`);
    }
    target = { kind: 'benchmark', source: 'hub', id: fallback.dataset, revision: fallback.revision };
  }
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
  return { libraryDir, libraryRoots: policies.map((policy) => policy.key).join(','), cleanup };
}

function writeOutputs(outDir, run) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(run));
  writeFileSync(join(outDir, 'report.html'), buildBenchmarkReportHtml(toReportRun(run)));
}

function slug(text) {
  return text.replace(/^local:/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(-80);
}

/** Writes each policy's .eval_results preview locally and uploads where allowed. */
async function publishResults(run, outDir, { upload, dryRun, forcePr }) {
  let failed = false;
  for (const policy of run.policies) {
    console.log(`\n${policy.label}`);
    for (const line of formatTasks(run, policy.key)) console.log(`  ${line}`);
    const outcomes = formatOutcomes(run, policy.key);
    if (outcomes) console.log(`  ${outcomes}`);
    const blockers = uploadBlockers(run, policy.key);
    const logsDir = run.benchmark.id ? evalLogsDir(run.benchmark.id, run.benchmark.raw.version) : null;
    const sourceUrl = policy.repo && logsDir ? `https://huggingface.co/${policy.repo}/blob/main/${logsDir}/report.html` : null;
    const entries = run.benchmark.id ? buildEvalResultEntries(run, policy.key, { sourceUrl }) : [];
    const policyOut = join(outDir, 'policies', slug(policy.id));
    mkdirSync(policyOut, { recursive: true });
    if (entries.length) writeFileSync(join(policyOut, 'eval_results.yaml'), mergeEvalResults(null, entries));

    if (blockers.length) {
      if (upload) {
        console.log('  Not uploaded:');
        for (const reason of blockers) console.log(`    - ${reason}`);
      }
      continue;
    }
    if (!upload) {
      console.log('  Shareable; not uploaded (no-upload).');
      continue;
    }
    const policyResult = resultForPolicy(run, policy.key);
    const repo = { type: 'model', name: policy.repo };
    const resultsPath = evalResultsPath(run.benchmark.id);
    const existing = await readRepoText({ repo, path: resultsPath, revision: policy.sha }).catch(() => null);
    const files = [
      { path: resultsPath, content: mergeEvalResults(existing, entries) },
      { path: `${logsDir}/result.json`, content: JSON.stringify(policyResult) },
      { path: `${logsDir}/report.html`, content: buildBenchmarkReportHtml(toReportRun(policyResult)) },
    ];
    if (dryRun) {
      console.log(`  dry-run: would write to ${policy.repo}: ${files.map((f) => f.path).join(', ')}`);
      for (const file of files) writeFileSync(join(policyOut, file.path.replace(/\//g, '__')), file.content);
      console.log(`  (copies in ${policyOut})`);
      continue;
    }
    try {
      const result = await commitFiles({
        repo,
        files,
        title: `Add ${run.benchmark.raw.name} v${run.benchmark.raw.version} benchmark results`,
        description: `Results of \`npm run benchmark\` (humanoid-policy-viewer ${run.provenance.hpv.commit}, protocol ${run.provenance.hpv.protocol}) on datasets/${run.benchmark.id} at ${run.benchmark.sha}.`,
        parentCommit: policy.sha,
        forcePr,
        log: (line) => console.log(`  ${line}`),
      });
      console.log(`  Uploaded (${result.mode === 'pr' ? 'pull request' : 'commit'}): ${result.url}`);
    } catch (error) {
      failed = true;
      console.error(`  Upload failed: ${error.message}`);
    }
  }
  return !failed;
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
  const only = options.tests ? options.tests.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const outDir = resolve(options.out ?? join(appDir, 'benchmark_results', timestamp()));
  const log = (line) => console.log(line);

  const loaded = await resolveBenchmark(benchmarks[0], log);
  const problems = compatibilityProblems(loaded.benchmark);
  if (problems.length && !flags.has('force')) {
    throw new Error(`This viewer cannot run ${describeTarget(benchmarks[0] ?? { source: 'hub', kind: 'benchmark', id: loaded.info.id })}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n(add "force" to run it anyway; the results will be local-only)`);
  }
  // Every test must load before any browser starts, so a broken test fails in a second, not mid-run.
  assertTestsRunnable(loaded);
  const selected = selectTests(loaded.benchmark, loaded.rows);
  const cells = expandCells(selected, { only, repeats });

  const policies = [];
  for (const [index, target] of policyTargets.entries()) policies.push(await resolvePolicy(target, index, log));
  checkPolicies(policies);
  for (const policy of policies) policy.files = policyFileHashes(policy.policyDir, policy.primary);

  const allJobs = buildJobs(policies, cells, { maxRobots: robots });
  const jobs = shardJobs(allJobs, shard);
  const cellCount = (list) => list.reduce((sum, job) => sum + job.cells.length, 0);
  const runCells = cellCount(jobs);
  const tests = selected.map(({ row }) => row).filter((row) => cells.some((cell) => cell.testId === row.id));
  const provenance = collectProvenance(appDir);
  if (provenance.hpv.dirty) console.warn('Warning: this viewer checkout has uncommitted changes; the results will be local-only.');

  console.log(`Benchmark ${loaded.benchmark.name} v${loaded.benchmark.version} (${loaded.info.source === 'hub' ? `datasets/${loaded.info.id}@${loaded.info.sha.slice(0, 7)}` : loaded.info.path}): ${tests.length} tests, ${cells.length} cells`);
  console.log(`Policies: ${policies.map((p) => p.label).join(', ')}`);
  console.log(`Running ${runCells} cell(s) as ${jobs.length} job(s) of up to ${robots} robot(s)${shard ? ` (shard ${shard.index}/${shard.count} of ${cellCount(allJobs)} cells)` : ''} on ${jobsCount} page(s)${watch ? ', real time' : ''}`);

  const { libraryDir, libraryRoots, cleanup } = linkLibrary(policies);
  process.on('exit', cleanup);
  const { server, url } = await startViewerServer({ appDir, libraryDir, libraryRoots });
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
        results.push({
          policyKey: job.policyKey,
          cellId: cell.cellId,
          testId: cell.testId,
          repeat: cell.repeat,
          seed: cell.seed,
          frames: result.frames ?? 0,
          expectedFrames: result.expectedFrames ?? null,
          error: result.error ?? null,
          warning: result.warning ?? null,
          clampedCommands: result.clampedCommands ?? 0,
          appliedCommands: result.appliedCommands ?? null,
          actionDelayLag: result.actionDelayLag ?? null,
          wallMs: result.wallMs,
          metrics: result.metrics ?? null,
        });
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
    cells: results.sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.cellId.localeCompare(b.cellId)),
  };
  Object.assign(run, isComplete(run) ? summarizeRun(run) : {});
  writeOutputs(outDir, run);
  console.log(`\nWrote ${join(outDir, 'result.json')} and report.html (${run.wallSeconds}s)`);

  const errors = run.cells.filter((cell) => cell.error);
  if (shard) {
    console.log(`Shard ${shard.index}/${shard.count} done. When every shard has finished: npm run benchmark merge <their out dirs...>`);
    return errors.length === 0;
  }
  const uploaded = await publishResults(run, outDir, {
    upload: !flags.has('no-upload'),
    dryRun: flags.has('dry-run'),
    forcePr: flags.has('pr'),
  });
  if (errors.length) console.error(`\n${errors.length} cell(s) failed; see result.json.`);
  return errors.length === 0 && uploaded;
}

async function mergeCommand(args) {
  const { positionals, options, flags } = args;
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
  const ok = await publishResults(merged, outDir, {
    upload: flags.has('upload') && !flags.has('no-upload'),
    dryRun: flags.has('dry-run'),
    forcePr: flags.has('pr'),
  });
  return ok && merged.cells.every((cell) => !cell.error);
}

async function main() {
  // npm answers --help itself; every other flag, --dry-run and --force included, it strips and runs the script anyway.
  const swallowed = swallowedNpmFlags(process.env, [...KEYS, ...FLAGS.filter((f) => f !== 'help')]);
  if (swallowed.length) {
    throw new Error(`npm kept ${swallowed.map((f) => `--${f}`).join(', ')} for itself. Write ${swallowed.map((f) => (KEYS.includes(f) ? `${f}=<value>` : f)).join(', ')} instead (no dashes).`);
  }
  const args = parseWords(process.argv.slice(2), { keys: KEYS, flags: FLAGS, repeatable: ['policy'] });
  if (args.flags.has('help') || (!args.positionals.length && !args.options.policy)) {
    console.log(USAGE);
    return args.flags.has('help');
  }
  return args.positionals[0] === 'merge' ? mergeCommand(args) : runBenchmarkCommand(args);
}

main().then((ok) => {
  process.exitCode = ok ? 0 : 1;
}).catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
