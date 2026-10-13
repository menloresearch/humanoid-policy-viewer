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
import { publish, withTestedCommit } from './hfBenchmark.mjs';
import { RESULT_SCHEMA, summarize } from '../src/benchmark/run.js';
import { submit } from './hfSubmit.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = join(appDir, 'benchmarks/default');
const scratch = mkdtempSync(join(tmpdir(), 'hpv-fake-hub-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;

// benchmarks/default ships with no `license:` key, so publish asks about it. Most tests are about something
// else and publish from this copy, which has one.
const LICENSED = join(scratch, 'licensed-default');
cpSync(DEFAULT, LICENSED, { recursive: true });
writeFileSync(join(LICENSED, 'benchmark.yaml'), readFileSync(join(LICENSED, 'benchmark.yaml'), 'utf8').replace(/^(version: .*)$/m, '$1\nlicense: bsd-3-clause'));

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
  cpSync(LICENSED, dir, { recursive: true });
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

/** This viewer checkout, as publish sees it: clean and pushed. */
const VIEWER = { commit: 'e'.repeat(40), dirty: false, public: true };
const DEFAULT_PIN = '8bcbf47d6e7b206e1a9527029eab0fb2326630eb'; // benchmarks/default's harness.tested_commit

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
  const io = { env: { HF_TOKEN: 'hf_fake', HF_ENDPOINT: 'https://fake.hub' }, fetchImpl, hub, cacheDir: join(scratch, `cache-${dirs++}`), log: (line) => lines.push(line), viewer: () => VIEWER };
  return { repos, seed, io, lines, output: () => lines.join('\n'), dataset: (name) => repos.get(key('dataset', name)), model: (name) => repos.get(key('model', name)) };
}

test('publish without a pull record compares with the Hub main given repo=', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(LICENSED));
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
  const main = fake.seed('dataset', 'me/bench', readTree(LICENSED));
  await assert.rejects(() => publish(workingCopy(lengthenFirstTest), { repo: 'me/bench' }, fake.io), /bump benchmark\.yaml version to 2/);
  assert.equal(fake.dataset('me/bench').main, main);
});

test('a direct commit is tagged v<version>', async () => {
  const fake = fakeHub();
  fake.seed('dataset', 'me/bench', readTree(LICENSED));
  const result = await publish(workingCopy((files) => bumpVersion(lengthenFirstTest(files))), { repo: 'me/bench' }, fake.io);
  assert.equal(result.mode, 'direct');
  assert.deepEqual(fake.dataset('me/bench').tags, { v2: result.commit });
  assert.match(fake.output(), /Tagged datasets\/me\/bench@\w{7} as v2/);
});

test('a pull request is not tagged and says how to release it', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(LICENSED));
  const result = await publish(workingCopy((files) => bumpVersion(lengthenFirstTest(files))), { repo: 'me/bench', pr: true }, fake.io);
  assert.equal(result.mode, 'pr');
  assert.equal(fake.dataset('me/bench').main, main);
  assert.deepEqual(fake.dataset('me/bench').tags, {});
  assert.match(fake.output(), /npm run hf release datasets\/me\/bench rev=/);
});

test('publish refuses a base= that is no longer main', async () => {
  const fake = fakeHub();
  const old = fake.seed('dataset', 'me/bench', readTree(LICENSED));
  const main = fake.seed('dataset', 'me/bench', bumpVersion(lengthenFirstTest(readTree(LICENSED))));
  await assert.rejects(() => publish(workingCopy(), { repo: 'me/bench', base: old }, fake.io), /stale/);
  assert.equal(fake.dataset('me/bench').main, main);
  assert.equal(fake.dataset('me/bench').commits.size, 2);
});

test('dry-run publish of a new dataset lists the files and eval.yaml and writes nothing', async () => {
  const fake = fakeHub();
  assert.equal(await publish(LICENSED, { repo: 'me/new', dryRun: true }, fake.io), null);
  const out = fake.output();
  assert.match(out, /would write \d+ files to datasets\/me\/new as a new dataset \(not found on the Hub; add "create"/);
  for (const path of ['benchmark.yaml', 'data/locomotion/test.jsonl', 'data/push_standing/test.jsonl', 'eval.yaml', 'README.md']) assert.match(out, new RegExp(`^  ${path}$`, 'm'));
  assert.match(out, /--- eval\.yaml \(generated\) ---\n[^]*survival_rate_v1/);
  assert.equal(fake.repos.size, 0);

  // create makes the repo, the first publish lands on it and is tagged.
  const result = await publish(LICENSED, { repo: 'me/new', create: true }, fake.io);
  assert.deepEqual(fake.dataset('me/new').tags, { v1: result.commit });
});

test('publish says how to log in before touching the Hub when there is no token', async () => {
  const fake = fakeHub();
  const touched = [];
  const io = { ...fake.io, env: { HF_ENDPOINT: 'https://fake.hub' }, fetchImpl: async (url) => { touched.push(url); throw new Error('no Hub call expected'); } };
  await assert.rejects(publish(LICENSED, { repo: 'me/new', create: true }, io), /Publishing datasets\/me\/new needs a Hugging Face token, and you are not logged in[^]*export HF_TOKEN=hf_[^]*hf auth login/);
  assert.deepEqual(touched, []);
  assert.equal(fake.repos.size, 0);
  // dry-run still works without a token.
  await publish(LICENSED, { repo: 'me/new', dryRun: true }, { ...fake.io, env: { HF_ENDPOINT: 'https://fake.hub' } });
  assert.match(fake.output(), /dry-run: would write/);
});

test('a token the Hub rejects while creating a dataset is explained', async () => {
  const fake = fakeHub();
  const rejecting = async () => { throw Object.assign(new Error('Invalid username or password.'), { statusCode: 401 }); };
  const io = { ...fake.io, hub: { ...fake.io.hub, repoExists: rejecting } };
  await assert.rejects(publish(LICENSED, { repo: 'me/new', create: true }, io), /Creating datasets\/me\/new failed: Hugging Face rejected your token \(from HF_TOKEN\)[^]*settings\/tokens/);
});

const uploadedYaml = (fake, repo) => fake.dataset(repo).commits.get(fake.dataset(repo).main)['benchmark.yaml'];

test('publish puts this viewer commit in the uploaded benchmark.yaml, its layout kept, and leaves the folder alone', async () => {
  const fake = fakeHub();
  const dir = workingCopy();
  const local = readFileSync(join(dir, 'benchmark.yaml'), 'utf8');
  await publish(dir, { repo: 'me/new', create: true }, fake.io);
  assert.equal(uploadedYaml(fake, 'me/new'), local.replace(DEFAULT_PIN, VIEWER.commit));
  assert.equal(readFileSync(join(dir, 'benchmark.yaml'), 'utf8'), local);
});

test('a republish of the same version records this viewer commit, not the one before', async () => {
  const fake = fakeHub();
  fake.seed('dataset', 'me/bench', readTree(LICENSED));
  await publish(workingCopy(), { repo: 'me/bench' }, fake.io);
  assert.equal(parseYaml(uploadedYaml(fake, 'me/bench')).harness.tested_commit, VIEWER.commit);
});

test('publish refuses a viewer checkout others cannot reproduce, even in dry-run, and writes nothing', async () => {
  const fake = fakeHub();
  const main = fake.seed('dataset', 'me/bench', readTree(LICENSED));
  const cases = [
    [{ ...VIEWER, dirty: true }, /this viewer checkout has uncommitted changes, so commit eeeeeee is not the code that checked the benchmark/],
    [{ ...VIEWER, public: false }, /viewer commit eeeeeee is not on a branch of https:\/\/github\.com\/menloresearch\/humanoid-policy-viewer[^]*push it first/],
    [{ commit: null, dirty: null, public: null }, /this viewer is not a git checkout/],
  ];
  for (const [viewer, message] of cases) {
    const io = { ...fake.io, viewer: () => viewer };
    await assert.rejects(publish(workingCopy(), { repo: 'me/bench' }, io), message);
    await assert.rejects(publish(workingCopy(), { repo: 'me/bench', dryRun: true }, io), message);
  }
  assert.equal(fake.dataset('me/bench').main, main);
  assert.equal(fake.dataset('me/bench').commits.size, 1);
});

test('withTestedCommit replaces the value in place, and adds the key when there is none', () => {
  const text = 'name: x   # the name\nharness:\n  protocol: 1      # p\n  tested_commit: abc   # set by publish\nversion: 1\n';
  assert.equal(withTestedCommit(text, 'f'.repeat(40)), text.replace('abc', 'f'.repeat(40)));
  assert.equal(parseYaml(withTestedCommit('harness: { protocol: 1, tested_commit: "abc" }\n', 'f'.repeat(40))).harness.tested_commit, 'f'.repeat(40));
  for (const missing of ['harness:\n  protocol: 1\n', 'harness:\n  protocol: 1\n  tested_commit:\n']) {
    assert.deepEqual(parseYaml(withTestedCommit(missing, 'f'.repeat(40))).harness, { protocol: 1, tested_commit: 'f'.repeat(40) });
  }
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

async function publishedCard(fake, dir, repo) {
  await publish(dir, { repo, create: true }, fake.io);
  const dataset = fake.dataset(repo);
  const files = dataset.commits.get(dataset.main);
  return { files, card: parseYaml(files['README.md'].split('---\n')[1]) };
}

const withYaml = (edit) => workingCopy((files) => ({ ...files, 'benchmark.yaml': edit(files['benchmark.yaml']) }));

test('the card is tagged humanoid-policy-viewer plus the tags in benchmark.yaml, and has the license id given there', async () => {
  const fake = fakeHub();
  const plain = await publishedCard(fake, LICENSED, 'me/plain');
  assert.deepEqual(plain.card.tags, ['humanoid-policy-viewer']);
  assert.equal(plain.card.license, 'bsd-3-clause');
  assert.equal(plain.card.license_link, undefined);

  const tagged = await publishedCard(fake, withYaml((yaml) => yaml.replace(/^license: .*$/m, 'license: apache-2.0\ntags: [benchmark, humanoid-policy-viewer, locomotion]')), 'me/tagged');
  assert.deepEqual(tagged.card.tags, ['humanoid-policy-viewer', 'benchmark', 'locomotion']);
  assert.equal(tagged.card.license, 'apache-2.0');
});

test('license: can name a file in the folder, which is uploaded and linked from the card', async () => {
  const fake = fakeHub();
  const dir = withYaml((yaml) => yaml.replace(/^license: .*$/m, 'license: LICENSE'));
  writeFileSync(join(dir, 'LICENSE'), 'Our own terms.\n');
  const { files, card } = await publishedCard(fake, dir, 'me/filed');
  assert.equal(card.license, 'other');
  assert.equal(card.license_name, 'default-license');
  assert.equal(card.license_link, 'LICENSE');
  assert.equal(files.LICENSE, 'Our own terms.\n');

  // A license id next to a LICENSE file keeps the id and uploads the file too.
  const both = withYaml((yaml) => yaml);
  writeFileSync(join(both, 'LICENSE'), 'BSD text.\n');
  const preset = await publishedCard(fake, both, 'me/preset');
  assert.equal(preset.card.license, 'bsd-3-clause');
  assert.equal(preset.files.LICENSE, 'BSD text.\n');
});

/** Publishes with `answer` as the reply to the license question (a function is called with the question). */
async function publishAsking(fake, dir, repo, answer) {
  const warnings = [];
  const questions = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const io = { ...fake.io, confirm: async (question) => { questions.push(question); return answer; } };
    const result = await publish(dir, { repo, create: true }, io).then(() => 'published', (error) => error);
    const dataset = fake.dataset(repo);
    const card = dataset ? parseYaml(dataset.commits.get(dataset.main)['README.md'].split('---\n')[1]) : null;
    return { result, card, warnings, questions };
  } finally {
    console.warn = warn;
  }
}

test('with no license: key, publish warns and asks; yes uses bsd-3-clause, no cancels before uploading', async () => {
  const fake = fakeHub();
  const unset = () => withYaml((yaml) => yaml.replace(/^license: .*\n/m, ''));

  const yes = await publishAsking(fake, unset(), 'me/yes', true);
  assert.equal(yes.result, 'published');
  assert.equal(yes.card.license, 'bsd-3-clause');
  assert.ok(yes.warnings.some((line) => /has no license/.test(line)));
  assert.match(yes.questions[0], /Use bsd-3-clause instead\? \(N to cancel this workflow to specify your own\)/);

  const no = await publishAsking(fake, unset(), 'me/no', false);
  assert.match(no.result.message, /Not published: no license chosen, nothing was uploaded/);
  assert.equal(fake.dataset('me/no'), undefined);

  const noTerminal = await publishAsking(fake, unset(), 'me/pipe', null);
  assert.match(noTerminal.result.message, /no terminal to ask on/);
  assert.equal(fake.dataset('me/pipe'), undefined);
});

test('a blank license: is on purpose: publish warns and asks; no (or no terminal) goes ahead without a license', async () => {
  const fake = fakeHub();
  const blank = () => withYaml((yaml) => yaml.replace(/^license: .*$/m, 'license:'));

  const no = await publishAsking(fake, blank(), 'me/blank', false);
  assert.equal(no.result, 'published');
  assert.equal(no.card.license, undefined);
  assert.ok(no.warnings.some((line) => /blank license/.test(line)));
  assert.match(no.questions[0], /Use bsd-3-clause instead\? \(N to publish with no license\)/); // "no" does not cancel here

  const noTerminal = await publishAsking(fake, blank(), 'me/blank-pipe', null);
  assert.equal(noTerminal.result, 'published');
  assert.equal(noTerminal.card.license, undefined);

  const yes = await publishAsking(fake, blank(), 'me/blank-yes', true);
  assert.equal(yes.card.license, 'bsd-3-clause');
});

test('benchmarks/default has no license: key, so a benchmark made from it is asked about at its first publish', async () => {
  assert.doesNotMatch(readFileSync(join(DEFAULT, 'benchmark.yaml'), 'utf8'), /^license:/m);
  const asked = await publishAsking(fakeHub(), DEFAULT, 'me/fresh', false);
  assert.match(asked.result.message, /Not published: no license chosen, nothing was uploaded/);
  assert.match(asked.questions[0], /Use bsd-3-clause instead\? \(N to cancel this workflow to specify your own\)/);
});

test('a license in benchmark.yaml is never asked about, and dry-run never asks', async () => {
  const fake = fakeHub();
  const set = await publishAsking(fake, LICENSED, 'me/set', false);
  assert.equal(set.result, 'published');
  assert.deepEqual(set.questions, []);

  const unset = withYaml((yaml) => yaml.replace(/^license: .*\n/m, ''));
  const asked = [];
  const io = { ...fake.io, confirm: async (question) => { asked.push(question); return false; } };
  await publish(unset, { repo: 'me/dry', dryRun: true }, io);
  assert.deepEqual(asked, []);
  assert.match(fake.output(), /a real publish asks whether to use bsd-3-clause/);
});

test('a license that is neither a file nor an id is refused', async () => {
  const fake = fakeHub();
  await assert.rejects(
    publish(withYaml((yaml) => yaml.replace(/^license: .*$/m, 'license: Not A License')), { repo: 'me/bad', create: true }, fake.io),
    /license "Not A License" is neither a file in .* nor a Hugging Face license id/,
  );
  await assert.rejects(
    publish(withYaml((yaml) => yaml.replace(/^license: .*$/m, 'license: 3\ntags: nope')), { repo: 'me/bad2', create: true }, fake.io),
    /license must be[^]*tags must be a list of strings/,
  );
});
