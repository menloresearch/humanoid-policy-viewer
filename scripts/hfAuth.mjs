// Finds the Hugging Face token the way the hf CLI does: HF_TOKEN, then
// HUGGING_FACE_HUB_TOKEN, then the file `hf auth login` saves ($HF_TOKEN_PATH,
// else $HF_HOME/token, else ~/.cache/huggingface/token). Every Hub download
// sends it, so private policies and benchmarks can be read; HPV never writes.
// Paths come from env only (no os.homedir()), so tests that pass env: {} never
// read the real token file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
