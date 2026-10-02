#!/usr/bin/env node
// npm run suite <command> ...
//
// Tooling for a benchmark dataset (the tests + suite.yaml that `npm run
// benchmark` runs). The Hugging Face dataset is the only copy of the tests:
// authors pull a working copy, edit it (by hand or in the viewer with
// `npm run dev suite=<dir>`), check it here, and publish it back as a commit
// or a pull request on the dataset. Hub dataset PRs have no CI, so a reviewer
// re-runs `validate` and `baseline` on `pull <id>@refs/pr/<n>`.
// Run with no arguments for the usage text.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { commandSequencer, setActiveCommandLimits } from '../src/simulation/commandSequencer.js';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';
import { compatibilityProblems, expandCells, parseSuite, selectTests } from '../src/benchmark/suite.js';
import { legacyToRow, rowToSequence } from '../src/benchmark/testRow.js';
import { collectProvenance } from './benchmarkProvenance.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { parseWords, swallowedNpmFlags } from './cliArgs.mjs';
import { commitFiles, hubCredentials } from './hfCommit.mjs';
import { ensureDataset } from './hfDataset.mjs';
import { cardFrontMatter, loadSuiteDir, readYamlFile, regenerateGeneratedFiles, withFrontMatter, writeRows } from './suiteDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_FILE = '.hpv-suite.json';

const USAGE = `Usage: npm run suite <command> ...

  init <dir> from-legacy=<benchmark dir>   new dataset working copy from the old benchmark/**/*.json tests
  pull <dataset>[@rev|@refs/pr/<n>] <dir>  working copy of a Hub dataset (e.g. datasets/org/bench@refs/pr/3)
  validate <dir>                           check rows, suite.yaml, generated files and the version bump
  diff <dir>                               what changed since the pulled revision
  baseline <dir> [model=<model>...]        run reference models on the working copy and on the pulled
                                           revision; writes <dir>/baseline.md
  publish <dir> [repo=<org/name>] [pr] [create] [dry-run]
                                           regenerate eval.yaml + card, validate, then commit (owner) or
                                           open a pull request; "create" makes a new PRIVATE dataset repo
  release <dataset> rev=<commit>           tag a merged revision v<version> and print the default-suite change

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
 * its prose (title, description) and without harness.tested_commit.
 */
export function scoredContentHash(rawSuite, rows) {
  const { title, description, reference_models: referenceModels, ...rest } = rawSuite;
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

const PROPOSED_TASKS = [
  { id: 'upright_rate', metric: 'upright_rate', description: 'Share of all tests finished without falling' },
  { id: 'tracking_score', metric: 'tracking_score', scope: { config: 'locomotion' }, description: '1/(1+velocity tracking RMSE) on the locomotion tests' },
  { id: 'distance_drift_score', metric: 'drift_score', scope: { config: 'distance' }, description: '1/(1+final drift in m) on the long walk' },
  { id: 'friction_upright_rate', metric: 'upright_rate', scope: { config: 'friction' }, description: 'Share of low-friction tests finished upright' },
  { id: 'push_standing_reasonable_pass', metric: 'push_pass_rate', scope: { config: 'push_standing', tier: 'reasonable' } },
  { id: 'push_walking_reasonable_pass', metric: 'push_pass_rate', scope: { config: 'push_walking', tier: 'reasonable' } },
  { id: 'push_beyond_pass', metric: 'push_pass_rate', scope: { config: ['push_standing', 'push_walking'], tier: 'beyond' } },
  { id: 'push_standing_max_force_n', metric: 'max_force_survived_n', scope: { config: 'push_standing' } },
  { id: 'push_walking_max_force_n', metric: 'max_force_survived_n', scope: { config: 'push_walking' } },
  { id: 'push_sustained_max_force_n', metric: 'max_force_survived_n', scope: { config: 'push_sustained' } },
];

function walkJson(root) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) files.push(relative(root, path));
    }
  })(root);
  return files;
}

function init(dir, legacyDir) {
  if (!legacyDir) throw new Error('init needs from-legacy=<the old benchmark/ folder>');
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const files = walkJson(legacyDir);
  if (!files.length) throw new Error(`no .json tests under ${legacyDir}`);
  const rows = files.map((file) => legacyToRow(file, JSON.parse(readFileSync(join(legacyDir, file), 'utf8'))));
  mkdirSync(dir, { recursive: true });
  writeRows(dir, rows);
  const configs = [...new Set(rows.map((row) => row.config))];
  const rawSuite = {
    suite: 'asimov-locomotion',
    title: 'Asimov Locomotion Benchmark',
    description: 'Velocity tracking, push recovery and low-friction tests for Asimov-1 locomotion policies, run in humanoid-policy-viewer (MuJoCo).',
    version: 1,
    harness: {
      repo: 'https://github.com/menloresearch/humanoid-policy-viewer',
      protocol: BENCHMARK_PROTOCOL,
      tested_commit: collectProvenance(appDir).hpv.commit,
    },
    requires: { robot: { name: 'asimov-1' }, policy_interface: 'velocity-command' },
    defaults: {
      repeats: 5,
      seed: 0,
      randomize: { action_delay: 'env_range', initial_joint_noise_rad: 0.02 },
      aggregate: 'mean',
      pass_rule: 'all_repeats',
      timeout_s: 600,
    },
    tests: [
      ...configs.filter((config) => config !== 'distance').map((config) => ({ config })),
      ...(configs.includes('distance') ? [{ config: 'distance', repeats: 1 }] : []),
    ],
    tasks: PROPOSED_TASKS.filter((task) => [].concat(task.scope?.config ?? configs).some((config) => configs.includes(config))),
    reference_models: [],
  };
  writeFileSync(join(dir, 'suite.yaml'), `# What runs and how it is scored; see humanoid-policy-viewer docs/benchmark-datasets.md.\n${stringifyYaml(rawSuite)}`);
  for (const doc of ['METHODOLOGY.md', 'VARIANCE_ANALYSIS.md']) {
    if (existsSync(join(legacyDir, doc))) copyFileSync(join(legacyDir, doc), join(dir, doc));
  }
  writeFileSync(join(dir, 'README.md'), readmeBody(rawSuite));
  regenerateGeneratedFiles(dir, { suite: parseSuite(rawSuite), rows, rawSuite });
  console.log(`Wrote ${rows.length} tests in ${configs.length} configs to ${dir}`);
  console.log('Next: review suite.yaml (repeats, randomisation, tasks), then npm run suite validate ' + dir);
}

function readmeBody(rawSuite) {
  return `
# ${rawSuite.title}

${rawSuite.description}

This is a benchmark for [humanoid-policy-viewer](${rawSuite.harness.repo}). Each row of
\`data/<config>/test.jsonl\` is one test scenario: velocity commands over time, timed pushes and the floor
friction. \`suite.yaml\` says how often each test runs, how runs are randomised and scored, and which numbers
become leaderboard tasks (\`eval.yaml\`, generated from it). See \`METHODOLOGY.md\` for why the tests are what
they are.

## Run it

\`\`\`
git clone ${rawSuite.harness.repo} && cd humanoid-policy-viewer && npm ci
npm run benchmark <your-org>/<your-policy> datasets/<this dataset>
\`\`\`

Results go to the model repo's \`.eval_results/\` (directly if you own it, otherwise as a pull request) and
show up on this benchmark's leaderboards. Results are tied to the viewer commit and protocol that produced them;
task ids end in the suite version (\`_v${rawSuite.version}\`), so numbers from different suite versions never share a
leaderboard.

## Change it

\`\`\`
npm run suite pull datasets/<this dataset> ./bench && npm run dev suite=./bench    # edit
npm run suite validate ./bench && npm run suite baseline ./bench
npm run suite publish ./bench pr
\`\`\`
`;
}

async function pull(target, dir) {
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
}

/** Returns { errors, warnings, loaded }. */
function check(dir) {
  const errors = [];
  const warnings = [];
  let loaded;
  try {
    loaded = loadSuiteDir(dir);
  } catch (error) {
    return { errors: [error.message], warnings, loaded: null };
  }
  const { suite, rawSuite, rows } = loaded;
  errors.push(...compatibilityProblems(suite).map((p) => `this viewer: ${p}`));
  try {
    const cells = expandCells(selectTests(suite, rows));
    const unused = rows.filter((row) => !cells.some((cell) => cell.testId === row.id));
    if (unused.length) warnings.push(`tests not selected by suite.yaml: ${unused.map((row) => row.id).join(', ')}`);
  } catch (error) {
    errors.push(error.message);
  }
  // The player's own checks (event shapes, times, directions); limits are
  // checked against the default command range, as no policy is loaded.
  setActiveCommandLimits(null);
  for (const row of rows) {
    try {
      const { warning } = commandSequencer.loadSequence(rowToSequence(row), row.name);
      if (warning) warnings.push(`${row.id}: ${warning} (default command range)`);
      if (row.config.startsWith('push') && row.events.some((event) => !event.tier) && row.config !== 'push_sustained') {
        warnings.push(`${row.id}: push without a tier`);
      }
    } catch (error) {
      errors.push(`${row.id}: ${error.message}`);
    }
  }
  // Generated files must match suite.yaml.
  const evalPath = join(dir, 'eval.yaml');
  if (!existsSync(evalPath)) errors.push('eval.yaml is missing (run publish, or validate fix)');
  else {
    const ids = new Set((readYamlFile(evalPath)?.tasks ?? []).map((task) => task.id));
    const missing = suite.tasks.map((task) => `${task.id}_v${suite.version}`).filter((id) => !ids.has(id));
    if (missing.length) errors.push(`eval.yaml is out of date (missing ${missing.join(', ')}); run: npm run suite validate ${dir} fix`);
  }
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  if (readme !== withFrontMatter(readme, cardFrontMatter(rows, { prettyName: rawSuite.title ?? suite.suite }))) {
    errors.push(`README.md front matter is out of date; run: npm run suite validate ${dir} fix`);
  }
  // A change that can move a score needs a new suite version.
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
  return { errors, warnings, loaded };
}

function validate(dir, { fix = false } = {}) {
  if (fix) {
    const loaded = loadSuiteDir(dir);
    regenerateGeneratedFiles(dir, loaded);
  }
  const { errors, warnings, loaded } = check(dir);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  if (!errors.length) console.log(`OK: ${loaded.rows.length} tests, suite ${loaded.suite.suite} v${loaded.suite.version}`);
  return { ok: errors.length === 0, errors, warnings, loaded };
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

function runBenchmarkProcess(args) {
  const result = spawnSync(process.execPath, [join(appDir, 'scripts/run-benchmark.mjs'), ...args, 'no-upload'], { cwd: appDir, stdio: 'inherit' });
  return result.status === 0;
}

async function baseline(dir, models) {
  const loaded = loadSuiteDir(dir);
  const reference = models.length ? models : (loaded.rawSuite.reference_models ?? []);
  if (!reference.length) throw new Error('No models: add reference_models to suite.yaml or pass model=<model>');
  const out = join(dir, '.baseline');
  const previous = await baseRows(dir).catch(() => null);
  const runs = {};
  runBenchmarkProcess([...reference, resolve(dir), `out=${join(out, 'candidate')}`]);
  runs.candidate = JSON.parse(readFileSync(join(out, 'candidate', 'run.json'), 'utf8'));
  if (previous) {
    runBenchmarkProcess([...reference, previous.dataset.dir, `out=${join(out, 'base')}`]);
    runs.base = JSON.parse(readFileSync(join(out, 'base', 'run.json'), 'utf8'));
  }
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

const PUBLISHED = [/^suite\.yaml$/, /^eval\.yaml$/, /^README\.md$/, /^[A-Z_]+\.md$/, /^suites\/[^/]+\.ya?ml$/, /^data\/[^/]+\/test\.jsonl$/, /^calibration\/[^/]+\.json$/];

function publishableFiles(dir) {
  const files = [];
  (function walk(sub) {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) {
        if (!name.startsWith('.')) walk(rel);
      } else if (PUBLISHED.some((re) => re.test(rel)) && rel !== 'baseline.md') files.push(rel);
    }
  })('');
  return files.sort();
}

async function publish(dir, { repo, pr, create, dryRun }) {
  const loaded = loadSuiteDir(dir);
  regenerateGeneratedFiles(dir, loaded);
  const { ok } = validate(dir);
  if (!ok) throw new Error('Not published: fix the errors above first');
  const base = readBase(dir);
  const name = repo ?? base?.id;
  if (!name) throw new Error('publish needs repo=<org/name> (this working copy was not pulled from the Hub)');
  const files = publishableFiles(dir).map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }));
  const diffText = base && base.id === name ? await diff(dir).catch((error) => `(diff failed: ${error.message})`) : '(new dataset)';
  const baselineText = existsSync(join(dir, 'baseline.md')) ? readFileSync(join(dir, 'baseline.md'), 'utf8') : '(no baseline run: npm run suite baseline <dir>)';
  const description = `Published with \`npm run suite publish\` from humanoid-policy-viewer ${collectProvenance(appDir).hpv.commit ?? ''}.\n\n### Changes\n\`\`\`\n${diffText}\n\`\`\`\n\n### Baseline\n${baselineText}\n\nReviewers: \`npm run suite pull datasets/${name}@refs/pr/<n> <dir>\`, then \`validate\` and \`baseline\`.`;
  if (dryRun) {
    console.log(`dry-run: would write ${files.length} files to datasets/${name}${pr ? ' as a pull request' : ''}:\n  ${files.map((f) => f.path).join('\n  ')}\n\n${description}`);
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

async function main() {
  const keys = ['from-legacy', 'model', 'repo', 'rev'];
  const flags = ['pr', 'create', 'dry-run', 'fix', 'help'];
  const swallowed = swallowedNpmFlags(process.env, ['from-legacy', 'model', 'repo', 'rev', 'pr', 'create', 'fix']);
  if (swallowed.length) throw new Error(`npm kept ${swallowed.map((f) => `--${f}`).join(', ')} for itself; write them without dashes.`);
  const { positionals, options, flags: set } = parseWords(process.argv.slice(2), { keys, flags, repeatable: ['model'] });
  const [command, a, b] = positionals;
  switch (command) {
    case 'init': return init(resolve(a ?? ''), options['from-legacy'] && resolve(options['from-legacy']));
    case 'pull': return pull(a, b && resolve(b));
    case 'validate': {
      if (!a) throw new Error('validate needs <dir>');
      if (!validate(resolve(a), { fix: set.has('fix') }).ok) process.exitCode = 1;
      return;
    }
    case 'diff': return diff(resolve(a ?? ''));
    case 'baseline': return baseline(resolve(a ?? ''), options.model ?? []);
    case 'publish': return publish(resolve(a ?? ''), { repo: options.repo, pr: set.has('pr'), create: set.has('create'), dryRun: set.has('dry-run') });
    case 'release': return release(a, options.rev);
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
