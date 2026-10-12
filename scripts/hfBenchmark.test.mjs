// hf publish and hf submit against a fake Hugging Face Hub kept in memory: the
// REST routes hfDataset.mjs and the tag call use, and the @huggingface/hub
// functions hfCommit.mjs uses. Nothing here reaches the network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { publish } from './hfBenchmark.mjs';
import { RESULT_SCHEMA, summarize } from '../src/benchmark/run.js';
import { submit } from './hfSubmit.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = join(appDir, 'benchmarks/default');
const scratch = mkdtempSync(join(tmpdir(), 'hpv-fake-hub-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;

function readTree(dir) {
  const files = {};
  (function walk(sub) {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else files[rel] = readFileSync(join(dir, rel), 'utf8');
    }
  })('');
  return files;
}

/** A copy of benchmarks/default to edit, with no pull record. */
function workingCopy(edit = (files) => files) {
  const dir = join(scratch, `work-${dirs++}`);
  cpSync(DEFAULT, dir, { recursive: true });
  const files = edit(readTree(dir));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  return dir;
}

const bumpVersion = (files) => ({ ...files, 'benchmark.yaml': files['benchmark.yaml'].replace(/^version: 1 /m, 'version: 2 ') });
const lengthenFirstTest = (files) => {
  const [first, ...rest] = files['data/locomotion/test.jsonl'].trim().split('\n');
  const row = JSON.parse(first);
  return { ...files, 'data/locomotion/test.jsonl': [JSON.stringify({ ...row, duration: row.duration + 1 }), ...rest].join('\n') + '\n' };
};

function fakeHub() {
  const repos = new Map(); // "dataset:org/name" -> { commits: Map(sha -> files), main, tags, prs }
  const key = (type, name) => `${type}:${name}`;
  const addCommit = (repo, files) => {
    const sha = createHash('sha1').update(`${repo.commits.size}:${JSON.stringify(files)}`).digest('hex');
    repo.commits.set(sha, files);
    return sha;
  };
  const seed = (type, name, files) => {
    const repo = repos.get(key(type, name)) ?? { commits: new Map(), main: null, tags: {}, prs: [] };
    repos.set(key(type, name), repo);
    repo.main = addCommit(repo, files);
    return repo.main;
  };
  const resolveRev = (repo, rev) => {
    if (rev === 'main') return repo.main;
    if (repo.tags[rev]) return repo.tags[rev];
    const pr = /^refs\/pr\/(\d+)$/.exec(rev);
    if (pr) return repo.prs[pr[1] - 1];
    return repo.commits.has(rev) ? rev : null;
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    let m = /^\/api\/datasets\/([^/]+\/[^/]+)\/revision\/(.+)$/.exec(pathname);
    if (m) {
      const repo = repos.get(key('dataset', m[1]));
      const sha = repo && resolveRev(repo, decodeURIComponent(m[2]));
      if (!sha) return json({ error: 'not found' }, 404);
      return json({ id: m[1], sha, siblings: Object.keys(repo.commits.get(sha)).map((rfilename) => ({ rfilename })) });
    }
    m = /^\/datasets\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(pathname);
    if (m) {
      const content = repos.get(key('dataset', m[1]))?.commits.get(m[2])?.[decodeURIComponent(m[3])];
      return content === undefined ? new Response('missing', { status: 404 }) : new Response(content);
    }
    m = /^\/api\/datasets\/([^/]+\/[^/]+)\/tag\/([0-9a-f]{40})$/.exec(pathname);
    if (m && init.method === 'POST') {
      const repo = repos.get(key('dataset', m[1]));
      const { tag } = JSON.parse(init.body);
      if (repo.tags[tag]) return json({ error: `tag ${tag} exists` }, 409);
      repo.tags[tag] = m[2];
      return json({});
    }
    throw new Error(`fake Hub: unexpected ${init.method ?? 'GET'} ${url}`);
  };

  const hub = {
    whoAmI: async () => ({ type: 'user', name: 'me', orgs: [], auth: { accessToken: { role: 'write' } } }),
    repoExists: async ({ repo }) => repos.has(key(repo.type, repo.name)),
    createRepo: async ({ repo }) => { seed(repo.type, repo.name, { '.gitattributes': '' }); },
    downloadFile: async ({ repo, path, revision }) => {
      const r = repos.get(key(repo.type, repo.name));
      const content = r?.commits.get(resolveRev(r, revision))?.[path];
      return content === undefined ? null : new Blob([content]);
    },
    commit: async ({ repo: target, operations, isPullRequest, parentCommit }) => {
      const repo = repos.get(key(target.type, target.name));
      if (!repo) throw Object.assign(new Error('repo not found'), { statusCode: 404 });
      if (!isPullRequest && parentCommit && parentCommit !== repo.main) throw Object.assign(new Error('parent is not main'), { statusCode: 412 });
      const files = { ...repo.commits.get(parentCommit ?? repo.main) };
      for (const op of operations) files[op.path] = await op.content.text();
      const oid = addCommit(repo, files);
      const url = `https://fake.hub/${target.name}/commit/${oid}`;
      if (!isPullRequest) {
        repo.main = oid;
        return { commit: { oid, url } };
      }
      repo.prs.push(oid);
      return { commit: { oid, url }, pullRequestUrl: `https://fake.hub/${target.name}/discussions/${repo.prs.length}` };
    },
  };
  const lines = [];
  const io = { env: { HF_TOKEN: 'hf_fake', HF_ENDPOINT: 'https://fake.hub' }, fetchImpl, hub, cacheDir: join(scratch, `cache-${dirs++}`), log: (line) => lines.push(line) };
  return { repos, seed, io, lines, output: () => lines.join('\n'), dataset: (name) => repos.get(key('dataset', name)), model: (name) => repos.get(key('model', name)) };
}

test('publish without a pull record compares with the Hub main given repo=', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(DEFAULT));
  const result = await publish(workingCopy(), { repo: 'me/bench' }, fake.io);
  assert.match(fake.output(), new RegExp(`Changes since datasets/me/bench@main \\(${main.slice(0, 7)}\\)`));
  assert.match(fake.output(), /Nothing that affects scores changed/);
  assert.equal(result.mode, 'direct');
  assert.equal(fake.dataset('me/bench').main, result.commit);
  assert.match(fake.output(), /Not tagged: the version is still 1/);
  assert.deepEqual(fake.dataset('me/bench').tags, {});
  await assert.rejects(() => publish(workingCopy(), {}, fake.io), /publish needs repo=<org\/name>/);
});

test('a change that can move a score needs a version bump', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(DEFAULT));
  await assert.rejects(() => publish(workingCopy(lengthenFirstTest), { repo: 'me/bench' }, fake.io), /bump benchmark\.yaml version to 2/);
  assert.equal(fake.dataset('me/bench').main, main);
});

test('a direct commit is tagged v<version>', async () => {
  const fake = fakeHub();
  fake.seed('dataset', 'me/bench', readTree(DEFAULT));
  const result = await publish(workingCopy((files) => bumpVersion(lengthenFirstTest(files))), { repo: 'me/bench' }, fake.io);
  assert.equal(result.mode, 'direct');
  assert.deepEqual(fake.dataset('me/bench').tags, { v2: result.commit });
  assert.match(fake.output(), /Tagged datasets\/me\/bench@\w{7} as v2/);
});

test('a pull request is not tagged and says how to release it', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(DEFAULT));
  const result = await publish(workingCopy((files) => bumpVersion(lengthenFirstTest(files))), { repo: 'me/bench', pr: true }, fake.io);
  assert.equal(result.mode, 'pr');
  assert.equal(fake.dataset('me/bench').main, main);
  assert.deepEqual(fake.dataset('me/bench').tags, {});
  assert.match(fake.output(), /npm run hf release datasets\/me\/bench rev=/);
});

test('publish refuses a base= that is no longer main', async () => {
  const fake = fakeHub();
  const old = fake.seed('dataset', 'me/bench', readTree(DEFAULT));
  const main = fake.seed('dataset', 'me/bench', bumpVersion(lengthenFirstTest(readTree(DEFAULT))));
  await assert.rejects(() => publish(workingCopy(), { repo: 'me/bench', base: old }, fake.io), /stale/);
  assert.equal(fake.dataset('me/bench').main, main);
  assert.equal(fake.dataset('me/bench').commits.size, 2);
});

test('dry-run publish of a new dataset lists the files and eval.yaml and writes nothing', async () => {
  const fake = fakeHub();
  assert.equal(await publish(DEFAULT, { repo: 'me/new', dryRun: true }, fake.io), null);
  const out = fake.output();
  assert.match(out, /would write \d+ files to datasets\/me\/new as a new dataset \(not found on the Hub; add "create"/);
  for (const path of ['benchmark.yaml', 'data/locomotion/test.jsonl', 'data/push_standing/test.jsonl', 'eval.yaml', 'README.md']) assert.match(out, new RegExp(`^  ${path}$`, 'm'));
  assert.match(out, /--- eval\.yaml \(generated\) ---\n[^]*survival_rate_v1/);
  assert.equal(fake.repos.size, 0);

  // create makes the repo, the first publish lands on it and is tagged.
  const result = await publish(DEFAULT, { repo: 'me/new', create: true }, fake.io);
  assert.deepEqual(fake.dataset('me/new').tags, { v1: result.commit });
});

function resultRun(overrides = {}) {
  const raw = parseYaml(readFileSync(join(DEFAULT, 'benchmark.yaml'), 'utf8'));
  const row = JSON.parse(readFileSync(join(DEFAULT, 'data/locomotion/test.jsonl'), 'utf8').split('\n')[0]);
  const run = {
    schema: RESULT_SCHEMA,
    generatedAt: '2026-10-12T00:00:00.000Z',
    wallSeconds: 1,
    provenance: { hpv: { repo: 'x', commit: 'c'.repeat(40), dirty: false, protocol: 1 }, asimov1: { commit: 'a'.repeat(40) }, runtime: {} },
    benchmark: { source: 'hub', id: 'me/bench', revision: 'v1', sha: 'd'.repeat(40), raw, problems: [] },
    overrides: { tests: null, repeats: null, force: false },
    shard: null,
    jobs: 1,
    robots: 1,
    policies: [{ key: 'm0', id: 'me/model', label: 'me/model', source: 'hub', repo: 'me/model', revision: 'main', sha: null, files: {} }],
    tests: [row],
    expectedCells: 1,
    cells: [{ policyKey: 'm0', cellId: `${row.id}#0`, testId: row.id, repeat: 0, seed: 0, frames: 10, error: null, metrics: { fell: { fell: false }, survival_time: row.duration } }],
    ...overrides,
  };
  return Object.assign(run, summarize(run));
}

function writeResult(run) {
  const dir = join(scratch, `result-${dirs++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(run));
  return dir;
}

test('submit writes .eval_results and eval_logs to the policy repo', async () => {
  const fake = fakeHub();
  const other = '- dataset: { id: other/bench, task_id: x_v1 }\n  value: 0.3\n';
  const sha = fake.seed('model', 'me/model', { 'policy.onnx': 'onnx', '.eval_results/me__bench.yaml': other.replace('other/bench', 'me/bench').replace('x_v1', 'old_v0') });
  const run = resultRun();
  run.policies[0].sha = sha;
  const [result] = await submit(writeResult(run), {}, fake.io);
  assert.equal(result.mode, 'direct');
  const files = fake.model('me/model').commits.get(result.commit);
  const entries = parseYaml(files['.eval_results/me__bench.yaml']);
  assert.deepEqual(entries.map((e) => e.dataset.task_id).sort(), ['old_v0', 'survival_rate_v1', 'survival_time_v1']);
  assert.equal(JSON.parse(files['eval_logs/bench/v1/result.json']).schema, RESULT_SCHEMA);
  assert.match(files['eval_logs/bench/v1/report.html'], /<html/i);
  assert.equal(files['policy.onnx'], 'onnx');
});

test('submit refuses a result on a local benchmark and says why', async () => {
  const fake = fakeHub();
  const sha = fake.seed('model', 'me/model', { 'policy.onnx': 'onnx' });
  const run = resultRun();
  run.policies[0].sha = sha;
  run.benchmark = { source: 'local', path: DEFAULT, raw: run.benchmark.raw, problems: [] };
  run.provenance.hpv.dirty = true;
  await assert.rejects(() => submit(writeResult(run), { dryRun: true }, fake.io), /Not submitted: me\/model/);
  assert.match(fake.output(), /Not submitted:\n {4}- the benchmark is a local folder[^]*uncommitted changes/);
  assert.equal(fake.model('me/model').commits.size, 1);
});
