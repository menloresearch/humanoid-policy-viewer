// Works out what a word on the `npm run benchmark` command line refers to:
//
//   menloresearch/asimov1-loco[@rev]              Hub model
//   https://huggingface.co/org/name[/tree/rev]    Hub model
//   datasets/org/name[@rev]                       Hub benchmark dataset (suite)
//   https://huggingface.co/datasets/org/name[...] Hub benchmark dataset (suite)
//   ./path/to/folder-with-suite.yaml              local suite
//   ./path/to/model-folder | file.onnx            local model
//
// A bare org/name is always a model: the same id can name both a model and a
// dataset, so a suite must be written with datasets/ (or given as suite=).

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalModel } from './localModel.mjs';

const ID = '[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._-]*';
const HUB_URL = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\//;

function splitRevision(rest) {
  // org/name@rev, or org/name/tree/<rev> as copied from the Hub's file browser
  const tree = new RegExp(`^(${ID})/tree/(.+?)/?$`).exec(rest);
  if (tree) return { id: tree[1], revision: decodeURIComponent(tree[2]) };
  const at = new RegExp(`^(${ID})(?:@(.+))?/?$`).exec(rest);
  if (at) return { id: at[1], revision: at[2] ?? null };
  return null;
}

/** @returns {{kind:'model'|'suite', source:'hub'|'local', id?, revision?, path?}} */
export function classifyTarget(word, { cwd = process.cwd() } = {}) {
  const text = String(word).trim();
  const local = resolve(cwd, text);
  if (existsSync(local)) {
    if (statSync(local).isDirectory() && existsSync(join(local, 'suite.yaml'))) return { kind: 'suite', source: 'local', path: local };
    return { kind: 'model', source: 'local', path: local };
  }
  if (isLocalModel(text) && !HUB_URL.test(text)) throw new Error(`${text} does not exist`);

  let rest = text.replace(HUB_URL, '').replace(/^hf:\/\//, '');
  let kind = 'model';
  if (/^datasets\//.test(rest)) {
    kind = 'suite';
    rest = rest.slice('datasets/'.length);
  } else if (/^models\//.test(rest)) {
    rest = rest.slice('models/'.length);
  } else if (/^spaces\//.test(rest)) {
    throw new Error(`${text} is a Space, not a model or a benchmark dataset`);
  }
  const parsed = splitRevision(rest);
  if (!parsed) throw new Error(`"${text}" is not a local path, a Hugging Face model (org/name) or a benchmark dataset (datasets/org/name)`);
  return { kind, source: 'hub', ...parsed };
}

/** Human-readable form of a classified target, e.g. for logs. */
export function describeTarget(target) {
  if (target.source === 'local') return target.path;
  return `${target.kind === 'suite' ? 'datasets/' : ''}${target.id}${target.revision ? `@${target.revision}` : ''}`;
}
