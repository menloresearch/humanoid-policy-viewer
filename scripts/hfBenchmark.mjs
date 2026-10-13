// The Hugging Face side of a benchmark (the tests + benchmark.yaml that `npm
// run benchmark` runs), behind `npm run hf pull|diff|baseline|publish|release`
// (scripts/hf.mjs). The dataset is the only shared copy of the tests: authors
// pull a working copy (or start from any benchmark folder), edit it (by hand or
// in the viewer with `npm run dev benchmark=<dir>`), and publish it back as a
// commit or a pull request on the dataset. diff, baseline and publish compare
// the folder with the dataset's current main (or base=<rev>), not with what was
// pulled. Hub dataset PRs have no CI, so a reviewer re-runs `baseline` on
// `pull <id>@refs/pr/<n>`.
// It imports npm packages, so scripts/hf.mjs loads it after setup().

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { compatibilityProblems } from '../src/benchmark/settings.js';
import { HPV_REPO, collectProvenance, onPublicRepo } from './benchmarkProvenance.mjs';
import { classifyTarget } from './benchmarkTargets.mjs';
import { explainAuthError, requireToken } from './hfAuth.mjs';
import { commitFiles, hubCredentials } from './hfCommit.mjs';
import { BENCHMARK_FILES, ensureDataset, fetchDatasetInfo, hubSettings } from './hfDataset.mjs';
import { checkTests } from '../src/benchmark/check.js';
import { hubFiles, loadBenchmarkDir, readYamlFile } from './benchmarkDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Written by pull: which dataset a working copy came from, so repo= can be left out.
const PULLED_FILE = '.hpv-benchmark.json';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** This checkout: { commit, dirty, public } (public = on a branch of HPV_REPO). */
function viewerCheckout() {
  const { commit, dirty } = collectProvenance(appDir).hpv;
  return { commit, dirty, public: onPublicRepo(appDir, commit) };
}

// Where the Hub is. Tests pass a fake one: env (HF_ENDPOINT, HF_TOKEN), fetchImpl,
// hub (the @huggingface/hub functions used), cacheDir and log; and viewer, this
// checkout as viewerCheckout() describes it.
/** true or false for a typed answer; null when there is no terminal to ask on. */
async function askYesNo(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function hubIo(io = {}) {
  return { env: process.env, fetchImpl: fetch, hub: null, cacheDir: undefined, log: console.log, confirm: askYesNo, viewer: viewerCheckout, ...io };
}

export const DEFAULT_LICENSE = 'bsd-3-clause';

/**
 * The license to publish with. A license in benchmark.yaml is used as it is. With
 * no `license:` key the author is asked whether to use the default, and declining
 * cancels the publish. A blank `license:` is on purpose: warn and ask whether to
 * use the default instead; declining (or no terminal) publishes without a license.
 * dry-run never asks.
 */
async function chooseLicense(raw, { confirm, log }, dryRun) {
  if (raw.license) return raw.license;
  const blank = raw.license !== undefined;
  console.warn(blank
    ? 'Warning: benchmark.yaml has a blank license, so the card will have no license.'
    : 'Warning: benchmark.yaml has no license (set license: to a Hugging Face id such as apache-2.0, or to a license file in the folder; leave it blank for none).');
  if (dryRun) {
    if (!blank) log(`dry-run: a real publish asks whether to use ${DEFAULT_LICENSE}; the card is shown with it.`);
    return blank ? null : DEFAULT_LICENSE;
  }
  // With no key, "no" cancels, so the prompt says how to choose another license; a blank key publishes without one.
  const answer = await confirm(`Use ${DEFAULT_LICENSE} instead? ${blank
    ? '(N to publish with no license)'
    : '(N to cancel this workflow to specify your own)'} `);
  if (answer) return DEFAULT_LICENSE;
  if (blank) return null;
  throw new Error(answer === null
    ? `Not published: benchmark.yaml has no license and there is no terminal to ask on. Set license: in benchmark.yaml (leave it blank for none).`
    : 'Not published: no license chosen, nothing was uploaded. Set license: in benchmark.yaml (leave it blank for none).');
}

/**
 * Hash of everything that can change a score: the rows and benchmark.yaml without
 * its prose (title, description), its version and harness.tested_commit.
 */
export function scoredContentHash(rawBenchmark, rows) {
  const { title, description, version, reference_policies: referencePolicies, license, tags, ...rest } = rawBenchmark;
  const harness = { ...(rest.harness ?? {}) };
  delete harness.tested_commit;
  const canonical = (value) => (Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value);
  return sha256(JSON.stringify(canonical({ benchmark: { ...rest, harness }, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)) })));
}

/** benchmark.yaml text with harness.tested_commit set to `commit`, its comments and layout kept. */
export function withTestedCommit(text, commit) {
  const doc = parseDocument(text);
  const node = doc.getIn(['harness', 'tested_commit'], true);
  if (node?.range && node.range[1] > node.range[0]) return text.slice(0, node.range[0]) + commit + text.slice(node.range[1]);
  doc.setIn(['harness', 'tested_commit'], commit);
  return doc.toString();
}

const withoutTestedCommit = (raw) => ({ ...raw, harness: { ...raw.harness, tested_commit: undefined } });

// ---------------------------------------------------------------------------

function datasetTarget(word) {
  return classifyTarget(word.startsWith('datasets/') || word.includes('/datasets/') ? word : `datasets/${word}`);
}

export async function pull(target, dir, io) {
  const { log, ...hub } = hubIo(io);
  if (!target || !dir) throw new Error('pull needs <dataset> <dir>');
  const parsed = datasetTarget(target);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const dataset = await ensureDataset(parsed.id, { revision: parsed.revision ?? 'main', env: hub.env, fetchImpl: hub.fetchImpl, cacheDir: hub.cacheDir, log });
  cpSync(dataset.dir, dir, { recursive: true });
  writeFileSync(join(dir, PULLED_FILE), JSON.stringify({ id: dataset.id, revision: dataset.revision, sha: dataset.sha }, null, 2) + '\n');
  log(`Pulled datasets/${dataset.id}@${dataset.sha.slice(0, 7)} into ${dir}`);
  return dataset;
}

/** The pulled-from record of a working copy ({ id, revision, sha }), or null. */
export function pulledFrom(dir) {
  const path = join(dir, PULLED_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The dataset a folder is compared with and published to: repo=, else the one it was pulled from. */
function datasetName(verb, dir, repo, { required = true } = {}) {
  if (repo) return repo.replace(/^datasets\//, '');
  const pulled = pulledFrom(dir);
  if (pulled) return pulled.id;
  if (required) throw new Error(`${verb} needs repo=<org/name>: ${dir} was not pulled from the Hub`);
  return null;
}

/**
 * The Hub revision a folder is compared with and published onto: the dataset's
 * current main, or base=<rev>. null when no base= was given and the dataset does
 * not exist yet (or is private without a token, or has no benchmark.yaml).
 */
async function resolveBase(name, rev, io) {
  const { endpoint, token } = hubSettings(io.env);
  let info;
  try {
    info = await fetchDatasetInfo(name, rev ?? 'main', { endpoint, token, fetchImpl: io.fetchImpl });
  } catch (error) {
    if (!rev && [401, 404].includes(error.status)) return null;
    throw error;
  }
  if (!info.files.includes('benchmark.yaml')) {
    if (rev) throw new Error(`datasets/${name}@${rev} has no benchmark.yaml`);
    return null;
  }
  const dataset = await ensureDataset(name, { revision: info.sha, env: io.env, fetchImpl: io.fetchImpl, cacheDir: io.cacheDir });
  return { id: dataset.id, revision: rev ?? 'main', sha: dataset.sha, dir: dataset.dir, loaded: loadBenchmarkDir(dataset.dir) };
}

function describeBase(base) {
  return `datasets/${base.id}@${base.revision === base.sha ? base.sha.slice(0, 7) : `${base.revision} (${base.sha.slice(0, 7)})`}`;
}

/**
 * Everything that must hold before a benchmark is published: the tests run
 * (checkTests), this viewer implements the benchmark's protocol, this viewer is a
 * clean checkout of a commit on HPV_REPO, and a change that can move a score
 * (compared with `base`) came with a new benchmark version.
 */
function publishCheck(dir, base, viewer) {
  const loaded = loadBenchmarkDir(dir);
  const { benchmark, rawBenchmark, rows } = loaded;
  const { errors, warnings } = checkTests(loaded);
  errors.push(...compatibilityProblems(benchmark).map((p) => `this viewer: ${p}`));
  if (!viewer.commit) errors.push('this viewer is not a git checkout, so there is no viewer commit to publish the benchmark with');
  else {
    if (viewer.dirty) errors.push(`this viewer checkout has uncommitted changes, so commit ${viewer.commit.slice(0, 7)} is not the code that checked the benchmark; commit them first`);
    if (!viewer.public) errors.push(`viewer commit ${viewer.commit.slice(0, 7)} is not on a branch of ${HPV_REPO} (as last fetched), so others cannot check it out; push it first`);
  }
  if (base) {
    const previous = base.loaded.benchmark.version;
    const changed = scoredContentHash(base.loaded.rawBenchmark, base.loaded.rows) !== scoredContentHash(rawBenchmark, rows);
    if (changed && benchmark.version <= previous) {
      errors.push(`tests or scoring changed since ${describeBase(base)} but version is still ${benchmark.version}; bump benchmark.yaml version to ${previous + 1}`);
    }
    if (!changed && benchmark.version !== previous) warnings.push('version changed but nothing that affects scores did');
  }
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (errors.length) throw new Error(`Not published:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return loaded;
}

function describeRowChange(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  return keys.join(', ');
}

/**
 * What changed from `base` to `current` (a loaded folder), and whether scores can
 * move. harness.tested_commit is left to publish, which sets it.
 */
function changesText(base, current) {
  const before = new Map(base.loaded.rows.map((row) => [row.id, row]));
  const after = new Map(current.rows.map((row) => [row.id, row]));
  const lines = [];
  for (const [id, row] of after) {
    if (!before.has(id)) lines.push(`+ ${id}`);
    else if (JSON.stringify(before.get(id)) !== JSON.stringify(row)) lines.push(`~ ${id}: ${describeRowChange(before.get(id), row)}`);
  }
  for (const id of before.keys()) if (!after.has(id)) lines.push(`- ${id}`);
  const settingsChanged = describeRowChange(withoutTestedCommit(base.loaded.rawBenchmark), withoutTestedCommit(current.rawBenchmark));
  if (settingsChanged) lines.push(`~ benchmark.yaml: ${settingsChanged}`);
  const scored = scoredContentHash(base.loaded.rawBenchmark, base.loaded.rows) !== scoredContentHash(current.rawBenchmark, current.rows);
  lines.push(scored
    ? `Scores can change: needs version ${base.loaded.benchmark.version + 1} (benchmark.yaml says ${current.benchmark.version}).`
    : 'Nothing that affects scores changed.');
  return `Changes since ${describeBase(base)}:\n${lines.join('\n')}`;
}

export async function diff(dir, { repo, base: rev } = {}, io) {
  io = hubIo(io);
  const name = datasetName('diff', dir, repo);
  const base = await resolveBase(name, rev, io);
  if (!base) throw new Error(`datasets/${name} has no benchmark on the Hub yet (or it is private and you are not logged in); nothing to compare with`);
  const text = changesText(base, loadBenchmarkDir(dir));
  io.log(text);
  return text;
}

/** Runs the benchmark into a fresh `outDir` and returns its result.json; throws if any cell failed. */
function runBenchmarkProcess(args, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [join(appDir, 'scripts/run-benchmark.mjs'), ...args, `out=${outDir}`], { cwd: appDir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The benchmark run into ${outDir} failed (see above); no baseline written`);
  return JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
}

export async function baseline(dir, policies, { repo, base: rev } = {}, io) {
  io = hubIo(io);
  const loaded = loadBenchmarkDir(dir);
  const reference = policies.length ? policies : (loaded.rawBenchmark.reference_policies ?? []);
  if (!reference.length) throw new Error('No policies: add reference_policies to benchmark.yaml or pass policy=<policy>');
  const name = datasetName('baseline', dir, repo, { required: false });
  const previous = name ? await resolveBase(name, rev, io) : null;
  const out = join(dir, '.baseline');
  const runs = {};
  runs.candidate = runBenchmarkProcess([...reference, resolve(dir)], join(out, 'candidate'));
  if (previous) runs.base = runBenchmarkProcess([...reference, previous.dir], join(out, 'base'));
  const lines = ['| policy | task | base | candidate |', '|---|---|---|---|'];
  for (const policy of runs.candidate.policies) {
    const basePolicy = runs.base?.policies.find((p) => p.id === policy.id);
    const baseTasks = new Map((runs.base?.tasks?.[basePolicy?.key] ?? []).map((task) => [task.taskId.replace(/_v\d+$/, ''), task.value]));
    for (const task of runs.candidate.tasks?.[policy.key] ?? []) {
      const taskName = task.taskId.replace(/_v\d+$/, '');
      lines.push(`| ${policy.label} | ${taskName} | ${baseTasks.get(taskName) ?? '—'} | ${task.value ?? '—'} |`);
    }
  }
  const text = `Baseline: candidate vs ${previous ? describeBase(previous) : '(nothing on the Hub to compare with)'}, viewer ${runs.candidate.provenance.hpv.commit?.slice(0, 7)}\n\n${lines.join('\n')}\n`;
  writeFileSync(join(dir, 'baseline.md'), text);
  io.log(`\n${text}\nWrote ${join(dir, 'baseline.md')}`);
}

// eval.yaml and README.md are built by hubFiles(), never taken from disk.
function publishableFiles(dir) {
  const files = [];
  (function walk(sub) {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) {
        if (!name.startsWith('.')) walk(rel);
      } else if (BENCHMARK_FILES.some((re) => re.test(rel)) && rel !== 'README.md') files.push(rel);
    }
  })('');
  return files.sort();
}

/** Tags a dataset commit: `hf release`, and `hf publish` after a direct commit. */
async function tagDataset({ id, sha, tag, message }, io) {
  requireToken(io.env, `Tagging datasets/${id}`);
  const { accessToken, hubUrl } = hubCredentials(io.env);
  const response = await io.fetchImpl(`${hubUrl}/api/datasets/${id}/tag/${sha}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, message }),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`Tagging failed (${response.status}): ${await response.text()}`), { statusCode: response.status });
    throw explainAuthError(error, io.env, `Tagging datasets/${id}`);
  }
}

export async function publish(dir, { repo, base: rev, pr = false, create = false, dryRun = false } = {}, io) {
  io = hubIo(io);
  const { log } = io;
  const name = datasetName('publish', dir, repo);
  // Before any Hub work, so someone who is not logged in finds out first (dry-run needs no token).
  if (!dryRun) requireToken(io.env, `Publishing datasets/${name}`);
  const base = await resolveBase(name, rev, io);
  if (rev && base) {
    // Publishing on top of anything but main would hide what was published since.
    const { endpoint, token } = hubSettings(io.env);
    const main = await fetchDatasetInfo(name, 'main', { endpoint, token, fetchImpl: io.fetchImpl });
    if (main.sha !== base.sha) {
      throw new Error(`base=${rev} is stale: datasets/${name} main is now ${main.sha.slice(0, 7)}, not ${base.sha.slice(0, 7)}. See what changed with npm run hf diff ${dir} repo=${name}, then publish without base= (or with base=${main.sha}).`);
    }
  }
  const viewer = io.viewer();
  const checked = publishCheck(dir, base, viewer);
  // Record the viewer commit that checked it in the uploaded benchmark.yaml (not the folder's).
  const harness = { ...checked.rawBenchmark.harness, tested_commit: viewer.commit };
  const loaded = {
    ...checked,
    benchmark: { ...checked.benchmark, harness },
    rawBenchmark: { ...checked.rawBenchmark, harness, license: await chooseLicense(checked.rawBenchmark, io, dryRun) },
  };
  // Older task ids in the Hub's eval.yaml are kept (a pulled copy has the same file).
  const evalYamlPath = [base && join(base.dir, 'eval.yaml'), join(dir, 'eval.yaml')].find((path) => path && existsSync(path));
  const previousEvalYaml = evalYamlPath ? readYamlFile(evalYamlPath) : null;
  const files = [
    ...publishableFiles(dir).map((path) => {
      const content = readFileSync(join(dir, path), 'utf8');
      return { path, content: path === 'benchmark.yaml' ? withTestedCommit(content, viewer.commit) : content };
    }),
    ...hubFiles(loaded, { previousEvalYaml }),
  ];
  const changes = base ? changesText(base, loaded) : `(new dataset: datasets/${name} has no benchmark yet)`;
  const baselineText = existsSync(join(dir, 'baseline.md')) ? readFileSync(join(dir, 'baseline.md'), 'utf8') : '(no baseline run: npm run hf baseline <dir>)';
  const description = `Published with \`npm run hf publish\` from humanoid-policy-viewer ${viewer.commit}.\n\n### Changes\n\`\`\`\n${changes}\n\`\`\`\n\n### Baseline\n${baselineText}\n\nReviewers: \`npm run hf pull datasets/${name}@refs/pr/<n> <dir>\`, then \`npm run hf baseline <dir>\`.`;
  const { version } = loaded.benchmark;
  const tag = `v${version}`;
  if (dryRun) {
    const onto = base ? `on top of ${describeBase(base)}` : `as a new dataset (not found on the Hub${create ? '' : '; add "create" to make it'})`;
    log(`dry-run: would write ${files.length} files to datasets/${name} ${onto}${pr ? ', as a pull request' : ''}:\n  ${files.map((f) => f.path).join('\n  ')}`);
    log(`\n--- eval.yaml (generated) ---\n${files.find((f) => f.path === 'eval.yaml').content}`);
    log(`--- pull request / commit description ---\n${description}`);
    return null;
  }
  log(changes);
  if (create) {
    const { createRepo, repoExists } = io.hub ?? await import('@huggingface/hub');
    const { accessToken, hubUrl } = hubCredentials(io.env);
    try {
      if (!(await repoExists({ repo: { type: 'dataset', name }, accessToken, hubUrl }))) {
        await createRepo({ repo: { type: 'dataset', name }, private: true, accessToken, hubUrl });
        log(`Created PRIVATE dataset datasets/${name}`);
      }
    } catch (error) {
      throw explainAuthError(error, io.env, `Creating datasets/${name}`);
    }
  }
  const result = await commitFiles({
    repo: { type: 'dataset', name },
    files,
    title: `${loaded.benchmark.name} ${tag}`,
    description,
    parentCommit: base?.sha,
    forcePr: pr,
    env: io.env,
    hub: io.hub,
    log,
  });
  log(`Published (${result.mode === 'pr' ? 'pull request' : 'commit'}): ${result.url}`);
  if (result.mode === 'pr') {
    log(`Once it is merged, tag it: npm run hf release datasets/${name} rev=<merged commit>`);
  } else if (base && base.loaded.benchmark.version === version) {
    log(`Not tagged: the version is still ${version}, so nothing that affects scores changed.`);
  } else {
    try {
      await tagDataset({ id: name, sha: result.commit, tag, message: `${loaded.benchmark.name} ${tag}` }, io);
    } catch (error) {
      throw new Error(`Committed ${result.commit}, but tagging it ${tag} failed: ${error.message}\nRetry with: npm run hf release datasets/${name} rev=${result.commit}`);
    }
    log(`Tagged datasets/${name}@${result.commit.slice(0, 7)} as ${tag}; benchmark against datasets/${name}@${tag}.`);
  }
  return result;
}

export async function release(target, rev, io) {
  io = hubIo(io);
  if (!target || !rev) throw new Error('release needs <dataset> rev=<commit>');
  const parsed = datasetTarget(target);
  const dataset = await ensureDataset(parsed.id, { revision: rev, env: io.env, fetchImpl: io.fetchImpl, cacheDir: io.cacheDir });
  const { benchmark } = loadBenchmarkDir(dataset.dir);
  const tag = `v${benchmark.version}`;
  await tagDataset({ id: dataset.id, sha: dataset.sha, tag, message: `${benchmark.name} ${tag}` }, io);
  io.log(`Tagged datasets/${dataset.id}@${dataset.sha.slice(0, 7)} as ${tag}; benchmark against datasets/${dataset.id}@${tag}.`);
}
