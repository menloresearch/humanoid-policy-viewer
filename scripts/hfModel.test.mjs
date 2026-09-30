import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureModel, normalizeRepoId, parseArgs, selectFiles } from './hfModel.mjs';

test('parseArgs accepts --model forms, a bare positional, and options', () => {
  assert.equal(parseArgs(['--model', 'Menlo/x']).model, 'Menlo/x');
  assert.equal(parseArgs(['--model=Menlo/x']).model, 'Menlo/x');
  assert.equal(parseArgs(['Menlo/x']).model, 'Menlo/x');
  const args = parseArgs(['Menlo/x', '--revision=v1', '--port', '4000', '--no-open']);
  assert.deepEqual([args.revision, args.port, args.open], ['v1', 4000, false]);
});

test('parseArgs rejects unknown flags, missing values and bad ports', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.throws(() => parseArgs(['--model']), /needs a value/);
  assert.throws(() => parseArgs(['--model', '--no-open']), /needs a value/);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port/);
});

test('normalizeRepoId accepts ids and Hub URLs, rejects anything else', () => {
  assert.equal(normalizeRepoId('Menlo/asimov1-locomotion-0818'), 'Menlo/asimov1-locomotion-0818');
  assert.equal(normalizeRepoId('https://huggingface.co/Menlo/asimov1-locomotion-0818/'), 'Menlo/asimov1-locomotion-0818');
  for (const bad of ['', 'Menlo', '../x/y', 'a/b/c', 'a/b c']) assert.throws(() => normalizeRepoId(bad), /not a Hugging Face repo id/);
});

test('selectFiles picks every onnx, the env.yaml, and prefers policy.onnx', () => {
  const picked = selectFiles(['README.md', 'agent.yaml', 'env.yaml', 'exported/a.onnx', 'policy.onnx']);
  assert.deepEqual(picked, { onnx: ['exported/a.onnx', 'policy.onnx'], env: ['env.yaml'], primary: 'policy.onnx' });
  assert.equal(selectFiles(['params/env.yaml', 'm.onnx']).env[0], 'params/env.yaml');
  assert.equal(selectFiles(['b.onnx', 'a.onnx']).primary, 'a.onnx');
  assert.throws(() => selectFiles(['env.yaml']), /no .onnx/);
});

// A fake Hub serving one repo whose commit can change between calls.
function fakeHub(state) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/api/models/')) {
      if (state.offline) throw new TypeError('fetch failed');
      if (state.missing) return new Response('', { status: 401 });
      return Response.json({ sha: state.sha, siblings: state.files.map((rfilename) => ({ rfilename })) });
    }
    return new Response(`${state.sha}:${new URL(url).pathname.split('/').pop()}`);
  };
  return { fetchImpl, calls };
}

test('ensureModel downloads into a model library layout, then reuses and refreshes the cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'hpv-hf-'));
  try {
    const state = { sha: 'a'.repeat(40), files: ['README.md', 'env.yaml', 'policy.onnx'] };
    const hub = fakeHub(state);
    const opts = { cacheDir, env: {}, fetchImpl: hub.fetchImpl };

    const first = await ensureModel('Menlo/demo', opts);
    assert.equal(first.cached, false);
    assert.equal(first.policyValue, 'ckpt:hf/Menlo__demo/policy.onnx');
    assert.equal(first.hasEnvYaml, true);
    assert.equal(readFileSync(join(cacheDir, 'hf/Menlo__demo/policy.onnx'), 'utf8'), `${state.sha}:policy.onnx`);
    assert.equal(existsSync(join(cacheDir, 'hf/Menlo__demo/README.md')), false);

    const downloads = () => hub.calls.filter((u) => u.includes('/resolve/')).length;
    assert.equal(downloads(), 2);
    assert.equal((await ensureModel('Menlo/demo', opts)).cached, true);
    assert.equal(downloads(), 2);

    state.offline = true;
    assert.equal((await ensureModel('Menlo/demo', opts)).cached, true);
    state.offline = false;

    state.sha = 'b'.repeat(40);
    state.files = ['policy.onnx'];
    const updated = await ensureModel('Menlo/demo', opts);
    assert.equal(updated.cached, false);
    assert.equal(updated.hasEnvYaml, false);
    assert.equal(existsSync(join(cacheDir, 'hf/Menlo__demo/env.yaml')), false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ensureModel explains a missing or private repo and leaves no cache behind', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'hpv-hf-'));
  try {
    const hub = fakeHub({ missing: true });
    await assert.rejects(ensureModel('Menlo/nope', { cacheDir, env: {}, fetchImpl: hub.fetchImpl }), /HF_TOKEN/);
    assert.equal(existsSync(join(cacheDir, 'hf')), false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
