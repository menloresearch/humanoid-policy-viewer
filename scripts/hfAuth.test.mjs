import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { hubToken, tokenFilePath } from './hfAuth.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'hpv-hf-auth-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function tokenFile(dir, token) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'token'), `${token}\n`);
  return join(dir, 'token');
}

test('the token comes from HF_TOKEN, then HUGGING_FACE_HUB_TOKEN, then the hf auth login file', () => {
  const home = join(scratch, 'home');
  const saved = tokenFile(join(home, '.cache', 'huggingface'), 'hf_saved');
  assert.deepEqual(hubToken({ HOME: home, HF_TOKEN: 'hf_env', HUGGING_FACE_HUB_TOKEN: 'hf_old' }), { token: 'hf_env', source: 'HF_TOKEN' });
  assert.deepEqual(hubToken({ HOME: home, HUGGING_FACE_HUB_TOKEN: 'hf_old' }), { token: 'hf_old', source: 'HUGGING_FACE_HUB_TOKEN' });
  assert.deepEqual(hubToken({ HOME: home }), { token: 'hf_saved', source: saved });
  assert.deepEqual(hubToken({ HOME: join(scratch, 'nobody') }), { token: null, source: null });
  assert.deepEqual(hubToken({}), { token: null, source: null });
});

test('the token file follows HF_TOKEN_PATH, HF_HOME and XDG_CACHE_HOME like the hf CLI', () => {
  assert.equal(tokenFilePath({ HF_TOKEN_PATH: '/x/t', HF_HOME: '/h', HOME: '/home/me' }), '/x/t');
  assert.equal(tokenFilePath({ HF_HOME: '/h', XDG_CACHE_HOME: '/c', HOME: '/home/me' }), join('/h', 'token'));
  assert.equal(tokenFilePath({ XDG_CACHE_HOME: '/c', HOME: '/home/me' }), join('/c', 'huggingface', 'token'));
  assert.equal(tokenFilePath({ HOME: '/home/me' }), join('/home/me', '.cache', 'huggingface', 'token'));
  assert.equal(tokenFilePath({}), null);
  const hfHome = join(scratch, 'hf-home');
  tokenFile(hfHome, 'hf_from_home');
  assert.equal(hubToken({ HF_HOME: hfHome }).token, 'hf_from_home');
});
