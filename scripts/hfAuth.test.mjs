import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { explainAuthError, hubToken, requireToken, tokenFilePath } from './hfAuth.mjs';

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

test('not being logged in says how to log in, with or without the hf CLI', () => {
  assert.equal(requireToken({ HF_TOKEN: 'hf_x' }, 'Publishing'), 'hf_x');
  assert.throws(() => requireToken({ HOME: join(scratch, 'nobody') }, 'Publishing datasets/me/bench'), (error) => {
    assert.match(error.message, /^Publishing datasets\/me\/bench needs a Hugging Face token, and you are not logged in/);
    assert.match(error.message, /huggingface\.co\/settings\/tokens/);
    assert.match(error.message, /export HF_TOKEN=hf_/);
    assert.match(error.message, /hf auth login/);
    assert.match(error.message, /pip install -U huggingface_hub/);
    return true;
  });
});

test('a 401 or 403 from the Hub is explained; other errors pass through', () => {
  const env = { HF_TOKEN: 'hf_stale' };
  const rejected = explainAuthError(Object.assign(new Error('Invalid username or password.'), { statusCode: 401 }), env, 'Creating datasets/me/bench');
  assert.match(rejected.message, /Creating datasets\/me\/bench failed: Hugging Face rejected your token \(from HF_TOKEN\)/);
  assert.equal(rejected.statusCode, 401);
  const forbidden = explainAuthError(Object.assign(new Error('no write access'), { statusCode: 403 }), env, 'Creating datasets/org/bench');
  assert.match(forbidden.message, /not allowed to do this \(no write access\)/);
  const other = Object.assign(new Error('server down'), { statusCode: 500 });
  assert.equal(explainAuthError(other, env, 'x'), other);
});
