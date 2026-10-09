#!/usr/bin/env node
// npm run suite <command> ...
//
// Tooling for a benchmark dataset (the tests + suite.yaml that `npm run
// benchmark` runs). The Hugging Face dataset is the only copy of the tests:
// authors pull a working copy, edit it (by hand or in the viewer with
// `npm run dev suite=<dir>`), check it here, and publish it back as a commit
// or a pull request on the dataset. Hub dataset PRs have no CI, so a reviewer
// re-runs `baseline` on `pull <id>@refs/pr/<n>`.
// Run with no arguments for the usage text.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityProblems } from '../src/benchmark/suite.js';
import { commandedEnd, goalProblems } from '../src/benchmark/terrainCheck.js';
import { rowToSequence } from '../src/benchmark/testRow.js';
import { collectProvenance } from './benchmarkProvenance.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { parseWords, swallowedNpmFlags } from './cliArgs.mjs';
import { commitFiles, hubCredentials } from './hfCommit.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { checkTests } from './suiteCheck.mjs';
import { hubFiles, loadSuiteDir, readYamlFile } from './suiteDir.mjs';
import { initSuite } from './suiteInit.mjs';

export { initSuite };

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_FILE = '.hpv-suite.json';

const USAGE = `Usage: npm run suite <command> ...

  init <dir>                               new benchmark: starter suite.yaml + one example test
  pull <dataset>[@rev|@refs/pr/<n>] <dir>  working copy of a Hub dataset (e.g. datasets/org/bench@refs/pr/3)
  diff <dir>                               what changed since the pulled revision
  baseline <dir> [model=<model>...]        run reference models on the working copy and on the pulled
                                           revision; writes <dir>/baseline.md
  publish <dir> [repo=<org/name>] [pr] [create] [dry-run]
                                           check, build eval.yaml + the dataset card, then commit (owner) or
                                           open a pull request; "create" makes a new PRIVATE dataset repo
  release <dataset> rev=<commit>           tag a merged revision v<version> and print the default-suite change
  path-end <dir> [<test id>...]            where each test's commands end the path (x, y in m, 2 decimals)
                                           and whether its end zone contains / is crossed by the path; JSON
                                           lines, for picking a goal by hand or from a script

Edit tests in the viewer with: npm run dev suite=<dir>   (or by hand: data/<config>/test.jsonl)`;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readBase(dir) {
  const path = join(dir, BASE_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Hash of everything that can change a score: the rows and suite.yaml without
 * its prose (title, description), its version and harness.tested_commit.
 */
export function scoredContentHash(rawSuite, rows) {
  const { title, description, version, reference_models: referenceModels, ...rest } = rawSuite;
  const harness = { ...(rest.harness ?? {}) };
  delete harness.tested_commit;
  const canonical = (value) => (Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value);
  return sha256(JSON.stringify(canonical({ suite: { ...rest, harness }, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)) })));
}

// ---------------------------------------------------------------------------

export async function pull(target, dir) {
  if (!target || !dir) throw new Error('pull needs <dataset> <dir>');
  const parsed = classifyTarget(target.startsWith('datasets/') || target.includes('/datasets/') ? target : `datasets/${target}`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const dataset = await ensureDataset(parsed.id, { revision: parsed.revision ?? 'main', log: console.log });
  cpSync(dataset.dir, dir, { recursive: true });
  const loaded = loadSuiteDir(dir);
  writeFileSync(join(dir, BASE_FILE), JSON.stringify({
    id: dataset.id,
    revision: dataset.revision,
    sha: dataset.sha,
    version: loaded.suite.version,
    scoredHash: scoredContentHash(loaded.rawSuite, loaded.rows),
  }, null, 2) + '\n');
  console.log(`Pulled datasets/${dataset.id}@${dataset.sha.slice(0, 7)} into ${dir}`);
  return dataset;
}

/** The pulled-from record of a working copy ({ id, revision, sha, ... }), or null. */
export function pulledFrom(dir) {
  return readBase(dir);
}

/**
 * Everything that must hold before a benchmark is published: the tests run
 * (checkTests), this viewer implements the suite's protocol, and a change that
 * can move a score came with a new suite version.
 */
function publishCheck(dir) {
  const loaded = loadSuiteDir(dir);
  const { suite, rawSuite, rows } = loaded;
  const { errors, warnings } = checkTests(loaded);
  errors.push(...compatibilityProblems(suite).map((p) => `this viewer: ${p}`));
  const base = readBase(dir);
  if (base) {
    const changed = base.scoredHash !== scoredContentHash(rawSuite, rows);
    if (changed && suite.version <= base.version) {
      errors.push(`tests or scoring changed since ${base.sha.slice(0, 7)} but version is still ${suite.version}; bump suite.yaml version to ${base.version + 1}`);
    }
    if (!changed && suite.version !== base.version) warnings.push('version changed but nothing that affects scores did');
  }
  if (suite.harness.tested_commit) {
    const commit = collectProvenance(appDir).hpv.commit;
    if (commit && commit !== suite.harness.tested_commit) {
      warnings.push(`suite.yaml harness.tested_commit is ${suite.harness.tested_commit.slice(0, 7)}, this viewer is ${commit.slice(0, 7)} (fine if the protocol matches)`);
    }
  }
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (errors.length) throw new Error(`Not published:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return loaded;
}

async function baseRows(dir) {
  const base = readBase(dir);
  if (!base) return null;
  const dataset = await ensureDataset(base.id, { revision: base.sha });
  return { base, dataset, loaded: loadSuiteDir(dataset.dir) };
}

function describeRowChange(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  return keys.join(', ');
}

async function diff(dir) {
  const previous = await baseRows(dir);
  if (!previous) throw new Error(`${dir} was not pulled from the Hub (no ${BASE_FILE}); nothing to compare with`);
  const current = loadSuiteDir(dir);
  const before = new Map(previous.loaded.rows.map((row) => [row.id, row]));
  const after = new Map(current.rows.map((row) => [row.id, row]));
  const lines = [];
  for (const [id, row] of after) {
    if (!before.has(id)) lines.push(`+ ${id}`);
    else if (JSON.stringify(before.get(id)) !== JSON.stringify(row)) lines.push(`~ ${id}: ${describeRowChange(before.get(id), row)}`);
  }
  for (const id of before.keys()) if (!after.has(id)) lines.push(`- ${id}`);
  const suiteChanged = describeRowChange(previous.loaded.rawSuite, current.rawSuite);
  if (suiteChanged) lines.push(`~ suite.yaml: ${suiteChanged}`);
  const scored = previous.base.scoredHash !== scoredContentHash(current.rawSuite, current.rows);
  lines.push(scored
    ? `Scores can change: needs version ${previous.base.version + 1} (suite.yaml says ${current.suite.version}).`
    : 'Nothing that affects scores changed.');
  console.log(`Changes since datasets/${previous.base.id}@${previous.base.sha.slice(0, 7)}:\n${lines.join('\n')}`);
  return lines.join('\n');
}

/** Runs the benchmark into a fresh `outDir` and returns its run.json; throws if any cell failed. */
function runBenchmarkProcess(args, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [join(appDir, 'scripts/run-benchmark.mjs'), ...args, `out=${outDir}`, 'no-upload'], { cwd: appDir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The benchmark run into ${outDir} failed (see above); no baseline written`);
  return JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8'));
}

async function baseline(dir, models) {
  const loaded = loadSuiteDir(dir);
  const reference = models.length ? models : (loaded.rawSuite.reference_models ?? []);
  if (!reference.length) throw new Error('No models: add reference_models to suite.yaml or pass model=<model>');
  const out = join(dir, '.baseline');
  const previous = await baseRows(dir).catch(() => null);
  const runs = {};
  runs.candidate = runBenchmarkProcess([...reference, resolve(dir)], join(out, 'candidate'));
  if (previous) runs.base = runBenchmarkProcess([...reference, previous.dataset.dir], join(out, 'base'));
  const lines = ['| model | task | base | candidate |', '|---|---|---|---|'];
  for (const model of runs.candidate.models) {
    const baseModel = runs.base?.models.find((m) => m.id === model.id);
    const baseTasks = new Map((runs.base?.tasks?.[baseModel?.key] ?? []).map((task) => [task.taskId.replace(/_v\d+$/, ''), task.value]));
    for (const task of runs.candidate.tasks?.[model.key] ?? []) {
      const name = task.taskId.replace(/_v\d+$/, '');
      lines.push(`| ${model.label} | ${name} | ${baseTasks.get(name) ?? '—'} | ${task.value ?? '—'} |`);
    }
  }
  const text = `Baseline: candidate vs ${previous ? `datasets/${previous.base.id}@${previous.base.sha.slice(0, 7)}` : '(no pulled base)'}, viewer ${runs.candidate.provenance.hpv.commit?.slice(0, 7)}\n\n${lines.join('\n')}\n`;
  writeFileSync(join(dir, 'baseline.md'), text);
  console.log(`\n${text}\nWrote ${join(dir, 'baseline.md')}`);
}

// eval.yaml and README.md are built by hubFiles(), never taken from disk.
const PUBLISHED = [
  /^suite\.yaml$/, /^[A-Z_]+\.md$/, /^suites\/[^/]+\.ya?ml$/, /^data\/[^/]+\/test\.jsonl$/, /^calibration\/[^/]+\.json$/,
  /^tools\/[^/]+\.(mjs|js|py)$/, // optional scripts that generate the tests, kept for reviewers
];

function publishableFiles(dir) {
  const files = [];
  (function walk(sub) {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) {
        if (!name.startsWith('.')) walk(rel);
      } else if (PUBLISHED.some((re) => re.test(rel)) && !['README.md', 'baseline.md'].includes(rel)) files.push(rel);
    }
  })('');
  return files.sort();
}

async function publish(dir, { repo, pr, create, dryRun }) {
  const loaded = publishCheck(dir);
  const base = readBase(dir);
  const name = repo ?? base?.id;
  if (!name) throw new Error('publish needs repo=<org/name> (this working copy was not pulled from the Hub)');
  // A pulled copy carries the Hub's eval.yaml; its older task ids are kept.
  const previousEvalYaml = existsSync(join(dir, 'eval.yaml')) ? readYamlFile(join(dir, 'eval.yaml')) : null;
  const files = [
    ...publishableFiles(dir).map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') })),
    ...hubFiles(loaded, { previousEvalYaml }),
  ];
  const diffText = base && base.id === name ? await diff(dir).catch((error) => `(diff failed: ${error.message})`) : '(new dataset)';
  const baselineText = existsSync(join(dir, 'baseline.md')) ? readFileSync(join(dir, 'baseline.md'), 'utf8') : '(no baseline run: npm run suite baseline <dir>)';
  const description = `Published with \`npm run suite publish\` from humanoid-policy-viewer ${collectProvenance(appDir).hpv.commit ?? ''}.\n\n### Changes\n\`\`\`\n${diffText}\n\`\`\`\n\n### Baseline\n${baselineText}\n\nReviewers: \`npm run suite pull datasets/${name}@refs/pr/<n> <dir>\`, then \`npm run suite baseline <dir>\`.`;
  if (dryRun) {
    console.log(`dry-run: would write ${files.length} files to datasets/${name}${pr ? ' as a pull request' : ''}:\n  ${files.map((f) => f.path).join('\n  ')}`);
    console.log(`\n--- eval.yaml (generated) ---\n${files.find((f) => f.path === 'eval.yaml').content}`);
    console.log(`--- pull request / commit description ---\n${description}`);
    return;
  }
  if (create) {
    const { createRepo, repoExists } = await import('@huggingface/hub');
    const { accessToken, hubUrl } = hubCredentials();
    if (!(await repoExists({ repo: { type: 'dataset', name }, accessToken, hubUrl }))) {
      await createRepo({ repo: { type: 'dataset', name }, private: true, accessToken, hubUrl });
      console.log(`Created PRIVATE dataset datasets/${name}`);
    }
  }
  const result = await commitFiles({
    repo: { type: 'dataset', name },
    files,
    title: `${loaded.suite.suite} v${loaded.suite.version}`,
    description,
    parentCommit: base?.id === name ? base.sha : undefined,
    forcePr: pr,
    log: console.log,
  });
  console.log(`Published (${result.mode === 'pr' ? 'pull request' : 'commit'}): ${result.url}`);
  if (result.mode !== 'pr') console.log(`When ready: npm run suite release datasets/${name} rev=${result.commit}`);
}

async function release(target, rev) {
  if (!target || !rev) throw new Error('release needs <dataset> rev=<commit>');
  const parsed = classifyTarget(target.startsWith('datasets/') || target.includes('/datasets/') ? target : `datasets/${target}`);
  const dataset = await ensureDataset(parsed.id, { revision: rev });
  const { suite } = loadSuiteDir(dataset.dir);
  const tag = `v${suite.version}`;
  const { accessToken, hubUrl } = hubCredentials();
  if (!accessToken) throw new Error('release needs a Hugging Face token (HF_TOKEN or hf auth login)');
  const response = await fetch(`${hubUrl}/api/datasets/${dataset.id}/tag/${dataset.sha}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, message: `${suite.suite} ${tag}` }),
  });
  if (!response.ok) throw new Error(`Tagging failed (${response.status}): ${await response.text()}`);
  console.log(`Tagged datasets/${dataset.id}@${dataset.sha.slice(0, 7)} as ${tag}.`);
  console.log(`Now point the viewer at it in src/benchmark/default-suite.json:\n  "dataset": "${dataset.id}", "revision": "${tag}"`);
}

/** One JSON line per test: where its commands end the path, and how its end zone relates to it. */
function pathEnd(dir, ids) {
  const { rows } = loadSuiteDir(dir);
  const unknown = ids.filter((id) => !rows.some((row) => row.id === id));
  if (unknown.length) throw new Error(`Unknown test id(s): ${unknown.join(', ')}`);
  for (const row of rows.filter((r) => !ids.length || ids.includes(r.id))) {
    const sequence = rowToSequence(row);
    const end = commandedEnd(sequence);
    const goal = row.goal;
    console.log(JSON.stringify({
      id: row.id,
      path_end: end,
      goal,
      goal_contains_end: goal ? (end.x - goal.x) ** 2 + (end.y - goal.y) ** 2 <= goal.radius_m ** 2 : null,
      path_enters_goal: goal ? goalProblems(sequence).length === 0 : null,
    }));
  }
}

async function main() {
  const keys = ['model', 'repo', 'rev'];
  const flags = ['pr', 'create', 'dry-run', 'help'];
  const swallowed = swallowedNpmFlags(process.env, [...keys, ...flags.filter((f) => f !== 'help')]);
  if (swallowed.length) throw new Error(`npm kept ${swallowed.map((f) => `--${f}`).join(', ')} for itself; write them without dashes.`);
  const { positionals, options, flags: set } = parseWords(process.argv.slice(2), { keys, flags, repeatable: ['model'] });
  const [command, a, b] = positionals;
  switch (command) {
    case 'init': {
      if (!a) throw new Error('init needs <dir>');
      return initSuite(resolve(a));
    }
    case 'pull': return pull(a, b && resolve(b));
    case 'diff': return diff(resolve(a ?? ''));
    case 'baseline': return baseline(resolve(a ?? ''), options.model ?? []);
    case 'publish': return publish(resolve(a ?? ''), { repo: options.repo, pr: set.has('pr'), create: set.has('create'), dryRun: set.has('dry-run') });
    case 'release': return release(a, options.rev);
    case 'path-end': return pathEnd(resolve(a ?? ''), positionals.slice(2));
    default:
      console.log(USAGE);
      if (command && command !== 'help') process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
