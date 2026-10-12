// Finds the Hugging Face token the way the hf CLI does: HF_TOKEN, then
// HUGGING_FACE_HUB_TOKEN, then the file `hf auth login` saves ($HF_TOKEN_PATH,
// else $HF_HOME/token, else ~/.cache/huggingface/token). Every Hub call uses it,
// and every write checks for it first so a missing or rejected token gets a
// message that says what to do instead of the Hub's bare 401.
// Paths come from env only (no os.homedir()), so tests that pass env: {} never
// read the real token file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKENS_PAGE = 'https://huggingface.co/settings/tokens';

export function tokenFilePath(env = process.env) {
  if (env.HF_TOKEN_PATH) return env.HF_TOKEN_PATH;
  if (env.HF_HOME) return join(env.HF_HOME, 'token');
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'huggingface', 'token');
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, '.cache', 'huggingface', 'token') : null;
}

/** { token, source } where source names where the token came from; token is null if there is none. */
export function hubToken(env = process.env) {
  for (const name of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN']) {
    if (env[name]?.trim()) return { token: env[name].trim(), source: name };
  }
  const path = tokenFilePath(env);
  if (path) {
    try {
      const token = readFileSync(path, 'utf8').trim();
      if (token) return { token, source: path };
    } catch {
      // not logged in
    }
  }
  return { token: null, source: null };
}

function loginSteps() {
  return [
    `  1. Make a token at ${TOKENS_PAGE} (type "Write"; a fine-grained token needs write access to the repo's namespace).`,
    '  2. Either export it:   export HF_TOKEN=hf_...',
    '     or save it with the Hugging Face CLI:   hf auth login',
    '     (install the CLI with: pip install -U huggingface_hub)',
  ].join('\n');
}

/** Throws a "not logged in" explanation unless a token is found; returns the token otherwise. */
export function requireToken(env, action) {
  const { token } = hubToken(env);
  if (token) return token;
  const where = tokenFilePath(env);
  throw new Error(`${action} needs a Hugging Face token, and you are not logged in (no HF_TOKEN, no HUGGING_FACE_HUB_TOKEN${where ? `, no ${where}` : ''}).\n${loginSteps()}`);
}

/**
 * A Hub refusal of the token (401) or of the action (403) explained; any other
 * error is returned unchanged. `action` is e.g. 'Creating datasets/org/name'.
 */
export function explainAuthError(error, env, action) {
  const status = error?.statusCode ?? error?.status;
  if (status !== 401 && status !== 403) return error;
  const { source } = hubToken(env);
  const from = source ? ` (from ${source})` : '';
  const message = status === 401
    ? `${action} failed: Hugging Face rejected your token${from}. It may be expired, revoked or mistyped.\n${loginSteps()}`
    : `${action} failed: your Hugging Face token${from} is not allowed to do this (${error.message}). A read-only token, or a fine-grained one without write access to that namespace, cannot write.\n${loginSteps()}`;
  return Object.assign(new Error(message, { cause: error }), { statusCode: status });
}
