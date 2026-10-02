#!/usr/bin/env node
// npm run benchmark <model...> [suite] [options]
// npm run benchmark merge <dir...> [upload] [pr] [dry-run]
//
// Benchmarks policies against a benchmark suite (a Hugging Face benchmark
// dataset or a local copy of one; see scripts/suiteDir.mjs) in headless
// Chromium, writes run.json + report.html + the .eval_results entries, and,
// when the run is shareable, uploads them to each model's Hub repo.
// Run with no arguments for the full usage text.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityProblems, expandCells, selectTests } from '../src/benchmark/suite.js';
import { rowToSequence } from '../src/benchmark/testRow.js';
import { buildBenchmarkReportHtml } from '../src/simulation/benchmarkReport.js';
import { runJobs, startViewerServer } from './benchmarkBrowser.mjs';
import { collectProvenance, policyFileHashes } from './benchmarkProvenance.mjs';
import {
  RUN_SCHEMA, buildJobs, formatTasks, isComplete, mergeRuns, parseShard, runForModel, shardJobs, summarizeRun, toReportRun, uploadBlockers,
} from './benchmarkRun.mjs';
import { classifyTarget, describeTarget } from './benchmarkTargets.mjs';
import { checkCheckpointDir, readReferenceJointNames } from './checkpointChecks.mjs';
import { parseWords, swallowedNpmFlags } from './cliArgs.mjs';
import { commitFiles, readRepoText } from './hfCommit.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { buildEvalResultEntries, evalLogsDir, evalResultsPath, mergeEvalResults } from './hfEvalResults.mjs';
import { ensureModel } from './hfModel.mjs';
import { findLocalModel } from './localModel.mjs';
import { loadSuiteDir } from './suiteDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KEYS = ['suite', 'suite-file', 'model', 'tests', 'repeats', 'jobs', 'shard', 'out'];
const FLAGS = ['pr', 'dry-run', 'no-upload', 'upload', 'force', 'watch', 'verbose', 'help'];

const USAGE = `Usage:
  npm run benchmark <model...> [<suite>] [key=value...] [flags...]
  npm run benchmark merge <run dir...> [upload] [pr] [dry-run]

A model is a Hugging Face repo (org/name, org/name@rev or its URL) or a local
folder / .onnx file. A suite is a benchmark dataset (datasets/org/name[@rev] or
its URL) or a local folder with a suite.yaml. Without a suite, the released
default (src/benchmark/default-suite.json) is used.

Options (no "--" needed):
  suite=<suite>        the suite, if not given as a word
  suite-file=<path>    another suite file inside the dataset, e.g. suites/smoke.yaml
  model=<model>        more models (repeatable)
  tests=<id,id>        run only these test ids (results are then local-only)
  repeats=<n>          override every test's repeat count (local-only)
  jobs=<n>             browser pages in parallel (default: half the CPU cores)
  shard=<i>/<n>        run slice i of n; combine with \`npm run benchmark merge\`
  out=<dir>            where to write results (default: benchmark_runs/<timestamp>)

Flags:
  dry-run              do everything except write to the Hub; shows what would be written
  no-upload            never upload
  pr                   upload as a pull request even if you could commit directly
  force                run even if this viewer does not match the suite (local-only)
  watch                show the browser and run in real time, one page
  verbose              print all browser console output

Results are uploaded only when they can be reproduced: Hub model + Hub suite,
a clean viewer checkout implementing the suite's protocol, the whole suite, and
no failed cells. Uploading needs HF_TOKEN (or \`hf auth login\`).

Examples:
  npm run benchmark menloresearch/asimov1-loco
  npm run benchmark ./models/model_Aug_18_1 suite=../asimov-locomotion-bench
  npm run benchmark menloresearch/asimov1-loco datasets/menloresearch/asimov-locomotion-bench@v1 pr
  npm run benchmark menloresearch/asimov1-loco test/fixtures/smoke-suite jobs=2`;

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

async function resolveSuite(target, suiteFile, log) {
  if (!target) {
    const fallback = JSON.parse(readFileSync(join(appDir, 'src/benchmark/default-suite.json'), 'utf8'));
    if (!fallback.revision) {
      throw new Error(`No default benchmark suite has been released yet (src/benchmark/default-suite.json). Give one: a local folder (e.g. test/fixtures/smoke-suite) or datasets/<org>/<name>.`);
    }
    target = { kind: 'suite', source: 'hub', id: fallback.dataset, revision: fallback.revision };
  }
  if (target.source === 'local') {
    return { ...loadSuiteDir(target.path, { suiteFile }), info: { source: 'local', path: target.path } };
  }
  const dataset = await ensureDataset(target.id, { revision: target.revision ?? 'main', log });
  return {
    ...loadSuiteDir(dataset.dir, { suiteFile }),
    info: { source: 'hub', id: dataset.id, revision: dataset.revision, sha: dataset.sha },
  };
}

async function resolveModel(target, index, log) {
  const key = `m${index}`;
  if (target.source === 'local') {
    const { modelDir, primary } = findLocalModel(target.path);
    return { key, id: `local:${modelDir}`, label: modelDir, source: 'local', modelDir, primary, sha: null };
  }
  const model = await ensureModel(target.id, { revision: target.revision ?? 'main', log });
  return { key, id: model.repo, label: model.repo, source: 'hub', repo: model.repo, revision: model.revision, sha: model.sha, modelDir: model.modelDir, primary: model.primary };
}

function checkModels(models) {
  const jointNames = readReferenceJointNames(appDir);
  for (const model of models) {
    const { errors, warnings } = checkCheckpointDir(model.modelDir, jointNames);
    for (const warning of warnings) console.warn(`Warning: ${model.label}: ${warning}`);
    if (errors.length) throw new Error(`${model.label} cannot be benchmarked:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

/**
 * A temporary model library in which every model folder is linked as its own
 * root, served under /model-library/<key>/. (The dev server only serves files
 * whose real path is inside a root, so a link cannot sit under a shared root.)
 */
function linkLibrary(models) {
  const libraryDir = mkdtempSync(join(tmpdir(), 'hpv-bench-'));
  const links = models.map((model) => {
    const link = join(libraryDir, model.key);
    symlinkSync(model.modelDir, link, 'junction');
    return link;
  });
  // Never a recursive delete: it could reach through a link into a model folder.
  const cleanup = () => {
    for (const link of links) try { unlinkSync(link); } catch { /* gone */ }
    try { rmdirSync(libraryDir); } catch { /* gone */ }
  };
  return { libraryDir, libraryRoots: models.map((model) => model.key).join(','), cleanup };
}

function writeOutputs(outDir, run) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'run.json'), JSON.stringify(run));
  writeFileSync(join(outDir, 'report.html'), buildBenchmarkReportHtml(toReportRun(run)));
}

function slug(text) {
  return text.replace(/^local:/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(-80);
}

/** Writes each model's .eval_results preview locally and uploads where allowed. */
async function publishResults(run, outDir, { upload, dryRun, forcePr }) {
  let failed = false;
  for (const model of run.models) {
    console.log(`\n${model.label}`);
    for (const line of formatTasks(run, model.key)) console.log(`  ${line}`);
    const blockers = uploadBlockers(run, model.key);
    const logsDir = run.suite.id ? evalLogsDir(run.suite.id, run.suite.raw.version) : null;
    const sourceUrl = model.repo && logsDir ? `https://huggingface.co/${model.repo}/blob/main/${logsDir}/report.html` : null;
    const entries = run.suite.id ? buildEvalResultEntries(run, model.key, { sourceUrl }) : [];
    const modelOut = join(outDir, 'models', slug(model.id));
    mkdirSync(modelOut, { recursive: true });
    if (entries.length) writeFileSync(join(modelOut, 'eval_results.yaml'), mergeEvalResults(null, entries));

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
    const modelRun = runForModel(run, model.key);
    const repo = { type: 'model', name: model.repo };
    const resultsPath = evalResultsPath(run.suite.id);
    const existing = await readRepoText({ repo, path: resultsPath, revision: model.sha }).catch(() => null);
    const files = [
      { path: resultsPath, content: mergeEvalResults(existing, entries) },
      { path: `${logsDir}/run.json`, content: JSON.stringify(modelRun) },
      { path: `${logsDir}/report.html`, content: buildBenchmarkReportHtml(toReportRun(modelRun)) },
    ];
    if (dryRun) {
      console.log(`  dry-run: would write to ${model.repo}: ${files.map((f) => f.path).join(', ')}`);
      for (const file of files) writeFileSync(join(modelOut, file.path.replace(/\//g, '__')), file.content);
      console.log(`  (copies in ${modelOut})`);
      continue;
    }
    try {
      const result = await commitFiles({
        repo,
        files,
        title: `Add ${run.suite.raw.suite} v${run.suite.raw.version} benchmark results`,
        description: `Results of \`npm run benchmark\` (humanoid-policy-viewer ${run.provenance.hpv.commit}, protocol ${run.provenance.hpv.protocol}) on datasets/${run.suite.id} at ${run.suite.sha}.`,
        parentCommit: model.sha,
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
  const targets = [...positionals, ...(options.model ?? [])].map((word) => classifyTarget(word));
  if (options.suite) targets.push({ ...classifyTarget(options.suite), kind: 'suite' });
  const suites = targets.filter((t) => t.kind === 'suite');
  const modelTargets = targets.filter((t) => t.kind === 'model');
  if (suites.length > 1) throw new Error(`Give one suite, got ${suites.map(describeTarget).join(' and ')}`);
  if (!modelTargets.length) throw new Error(`No model to benchmark.\n\n${USAGE}`);

  const watch = flags.has('watch');
  const jobsCount = watch ? 1 : parseCount(options.jobs, 'jobs') ?? defaultJobs();
  const repeats = parseCount(options.repeats, 'repeats');
  const shard = options.shard ? parseShard(options.shard) : null;
  const only = options.tests ? options.tests.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const outDir = resolve(options.out ?? join(appDir, 'benchmark_runs', timestamp()));
  const log = (line) => console.log(line);

  const loaded = await resolveSuite(suites[0], options['suite-file'] ?? 'suite.yaml', log);
  const problems = compatibilityProblems(loaded.suite);
  if (problems.length && !flags.has('force')) {
    throw new Error(`This viewer cannot run ${describeTarget(suites[0] ?? { source: 'hub', kind: 'suite', id: loaded.info.id })}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n(add "force" to run it anyway; the results will be local-only)`);
  }
  const selected = selectTests(loaded.suite, loaded.rows);
  const cells = expandCells(selected, { only, repeats });

  const models = [];
  for (const [index, target] of modelTargets.entries()) models.push(await resolveModel(target, index, log));
  checkModels(models);
  for (const model of models) model.files = policyFileHashes(model.modelDir, model.primary);

  const allJobs = buildJobs(models, cells);
  const jobs = shardJobs(allJobs, shard);
  const tests = selected.map(({ row }) => row).filter((row) => cells.some((cell) => cell.testId === row.id));
  const provenance = collectProvenance(appDir);
  if (provenance.hpv.dirty) console.warn('Warning: this viewer checkout has uncommitted changes; the results will be local-only.');

  console.log(`Suite ${loaded.suite.suite} v${loaded.suite.version} (${loaded.info.source === 'hub' ? `datasets/${loaded.info.id}@${loaded.info.sha.slice(0, 7)}` : loaded.info.path}): ${tests.length} tests, ${cells.length} cells`);
  console.log(`Models: ${models.map((m) => m.label).join(', ')}`);
  console.log(`Running ${jobs.length} job(s)${shard ? ` (shard ${shard.index}/${shard.count} of ${allJobs.length})` : ''} on ${jobsCount} page(s)${watch ? ', real time' : ''}`);

  const { libraryDir, libraryRoots, cleanup } = linkLibrary(models);
  process.on('exit', cleanup);
  const { server, url } = await startViewerServer({ appDir, libraryDir, libraryRoots });
  const results = [];
  const started = Date.now();
  let browserVersion = null;
  try {
    const policies = Object.fromEntries(models.map((m) => [m.key, { onnxPath: `/model-library/${m.key}/${m.primary}` }]));
    const sequences = Object.fromEntries(tests.map((row) => [row.id, rowToSequence(row)]));
    ({ browserVersion } = await runJobs({
      url,
      jobs,
      policies,
      sequences,
      concurrency: jobsCount,
      headless: !watch,
      realtime: watch,
      verbose: flags.has('verbose'),
      log,
      onResult: (job, result) => {
        const { cell } = job;
        results.push({
          modelKey: job.modelKey,
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
        const status = result.error ? `ERROR ${result.error}` : result.metrics?.fell?.fell ? `fell at ${result.metrics.fell.time}s` : 'ok';
        console.log(`[${results.length}/${jobs.length}] ${models.find((m) => m.key === job.modelKey).label} ${cell.cellId}: ${status} (${(result.wallMs / 1000).toFixed(1)}s)`);
      },
    }));
  } finally {
    await server.close();
    cleanup();
  }
  provenance.runtime.chromium = browserVersion;

  const run = {
    schema: RUN_SCHEMA,
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - started) / 1000),
    provenance,
    suite: { ...loaded.info, suiteFile: loaded.suiteFile, raw: loaded.rawSuite, problems },
    overrides: { tests: only, repeats, force: flags.has('force') && problems.length > 0 },
    shard,
    jobs: jobsCount,
    models: models.map(({ modelDir, ...rest }) => rest),
    tests,
    expectedCells: allJobs.length,
    cells: results.sort((a, b) => a.modelKey.localeCompare(b.modelKey) || a.cellId.localeCompare(b.cellId)),
  };
  Object.assign(run, isComplete(run) ? summarizeRun(run) : {});
  writeOutputs(outDir, run);
  console.log(`\nWrote ${join(outDir, 'run.json')} and report.html (${run.wallSeconds}s)`);

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
  if (errors.length) console.error(`\n${errors.length} cell(s) failed; see run.json.`);
  return errors.length === 0 && uploaded;
}

async function mergeCommand(args) {
  const { positionals, options, flags } = args;
  const dirs = positionals.slice(1);
  if (!dirs.length) throw new Error('merge needs the out directories of every shard');
  const runs = dirs.map((dir) => {
    const path = existsSync(join(dir, 'run.json')) ? join(dir, 'run.json') : dir;
    return JSON.parse(readFileSync(path, 'utf8'));
  });
  const merged = mergeRuns(runs);
  const outDir = resolve(options.out ?? join(appDir, 'benchmark_runs', `${timestamp()}_merged`));
  writeOutputs(outDir, merged);
  console.log(`Merged ${runs.length} shards into ${join(outDir, 'run.json')}`);
  const ok = await publishResults(merged, outDir, {
    upload: flags.has('upload') && !flags.has('no-upload'),
    dryRun: flags.has('dry-run'),
    forcePr: flags.has('pr'),
  });
  return ok && merged.cells.every((cell) => !cell.error);
}

async function main() {
  // dry-run, force and help are npm's own settings too; npm acts on those itself.
  const swallowed = swallowedNpmFlags(process.env, [...KEYS, ...FLAGS.filter((f) => !['dry-run', 'force', 'help'].includes(f))]);
  if (swallowed.length) {
    throw new Error(`npm kept ${swallowed.map((f) => `--${f}`).join(', ')} for itself. Write ${swallowed.map((f) => (KEYS.includes(f) ? `${f}=<value>` : f)).join(', ')} instead (no dashes).`);
  }
  const args = parseWords(process.argv.slice(2), { keys: KEYS, flags: FLAGS, repeatable: ['model'] });
  if (args.flags.has('help') || (!args.positionals.length && !args.options.model)) {
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
