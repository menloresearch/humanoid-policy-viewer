// Works out what a word on the `npm run hf`, `npm run dev` and `npm run benchmark`
// command lines refers to:
//
//   menloresearch/asimov1-loco[@rev]              Hub policy (model repo)
//   https://huggingface.co/org/name[/tree/rev]    Hub policy (model repo)
//   datasets/org/name[@rev]                       Hub benchmark dataset
//   https://huggingface.co/datasets/org/name[...] Hub benchmark dataset
//   ./path/to/folder-with-benchmark.yaml          local benchmark
//   ./path/to/policy-folder | file.onnx           local policy
//
// A bare org/name is always a policy: the same id can name both a model repo and a
// dataset, so a benchmark must be written with datasets/ (or given as benchmark=).
// Policies and the benchmark can come in any order (splitTargets); policy=<x> and
// benchmark=<y> say which one a word is when that is not clear from the word.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalPolicy } from './localPolicy.mjs';

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

/** @returns {{kind:'policy'|'benchmark', source:'hub'|'local', id?, revision?, path?}} */
export function classifyTarget(word, { cwd = process.cwd() } = {}) {
  const text = String(word).trim();
  const local = resolve(cwd, text);
  if (existsSync(local)) {
    if (statSync(local).isDirectory() && existsSync(join(local, 'benchmark.yaml'))) return { kind: 'benchmark', source: 'local', path: local };
    return { kind: 'policy', source: 'local', path: local };
  }
  if (isLocalPolicy(text) && !HUB_URL.test(text)) throw new Error(`${text} does not exist`);

  let rest = text.replace(HUB_URL, '').replace(/^hf:\/\//, '');
  let kind = 'policy';
  if (/^datasets\//.test(rest)) {
    kind = 'benchmark';
    rest = rest.slice('datasets/'.length);
  } else if (/^models\//.test(rest)) {
    rest = rest.slice('models/'.length);
  } else if (/^spaces\//.test(rest)) {
    throw new Error(`${text} is a Space, not a policy (model repo) or a benchmark dataset`);
  }
  const parsed = splitRevision(rest);
  if (!parsed) throw new Error(`"${text}" is not a local path, a Hugging Face policy (model repo org/name) or a benchmark dataset (datasets/org/name)`);
  return { kind, source: 'hub', ...parsed };
}

/** Human-readable form of a classified target, e.g. for logs. */
export function describeTarget(target) {
  if (target.source === 'local') return target.path;
  return `${target.kind === 'benchmark' ? 'datasets/' : ''}${target.id}${target.revision ? `@${target.revision}` : ''}`;
}

/**
 * The policies and the benchmark of a command line, in any order: plain words
 * are classified (classifyTarget); `policy` (a list) and `benchmark` are the
 * policy= and benchmark= options, which say what the word is. At most one benchmark.
 * @returns {{ policies: object[], benchmark: object | null }}
 */
export function splitTargets(words, { policy = [], benchmark } = {}, { cwd = process.cwd() } = {}) {
  const targets = words.map((word) => classifyTarget(word, { cwd }));
  for (const word of policy) {
    const target = classifyTarget(word, { cwd });
    if (target.kind === 'benchmark' && target.source === 'hub') throw new Error(`policy=${word} is a benchmark dataset, not a policy`);
    targets.push({ ...target, kind: 'policy' });
  }
  if (benchmark !== undefined) targets.push({ ...classifyTarget(benchmark, { cwd }), kind: 'benchmark' });
  const benchmarks = targets.filter((target) => target.kind === 'benchmark');
  if (benchmarks.length > 1) throw new Error(`Give one benchmark, got ${benchmarks.map(describeTarget).join(' and ')}`);
  return { policies: targets.filter((target) => target.kind === 'policy'), benchmark: benchmarks[0] ?? null };
}
