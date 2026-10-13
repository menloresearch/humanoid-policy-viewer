// Edits a benchmark's benchmark.yaml for the viewer's Benchmark settings dialog
// (the dev server's /api/benchmark, vite.config.mjs). The dialog either sends the
// form's fields, which are patched into the file so its comments and layout
// survive, or the whole file as text. Either way the result is checked the way
// `npm run benchmark` checks it before anything is written.

import { parseDocument } from 'yaml';
import { BENCHMARK_DEFAULTS, compatibilityProblems, parseBenchmark, selectTests } from '../src/benchmark/settings.js';

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The "  - problem" lines of a parseBenchmark / selectTests error.
function listed(error) {
  const lines = String(error?.message ?? error).split('\n').filter((line) => line.startsWith('  - '));
  return lines.length ? lines.map((line) => line.slice(4)) : [String(error?.message ?? error)];
}

function parseText(text) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`benchmark.yaml is not valid YAML: ${doc.errors[0].message}`);
  return doc;
}

/** The settings the form shows, filled in with what the parser assumes when a key is left out; null if `raw` is not a mapping. */
export function benchmarkFormFields(raw) {
  if (!isPlainObject(raw)) return null;
  const defaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const randomize = isPlainObject(defaults.randomize) ? defaults.randomize : {};
  return {
    name: raw.name ?? '',
    title: raw.title ?? '',
    description: raw.description ?? '',
    version: raw.version ?? 1,
    repeats: defaults.repeats ?? BENCHMARK_DEFAULTS.repeats,
    seed: defaults.seed ?? BENCHMARK_DEFAULTS.seed,
    timeout_s: defaults.timeout_s ?? BENCHMARK_DEFAULTS.timeout_s,
    action_delay: randomize.action_delay ?? null,
    initial_joint_noise_rad: randomize.initial_joint_noise_rad ?? 0,
    tests: Array.isArray(raw.tests) ? raw.tests : raw.tests ? [raw.tests] : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : raw.tasks ? [raw.tasks] : [],
  };
}

/** Problems with a benchmark.yaml text: errors make `npm run benchmark` refuse it, warnings are about this benchmark's tests. */
export function checkBenchmarkText(text, rows) {
  let raw;
  try {
    raw = parseText(text).toJS();
  } catch (error) {
    return { raw: null, errors: [error.message], warnings: [] };
  }
  let benchmark;
  try {
    benchmark = parseBenchmark(raw);
  } catch (error) {
    return { raw, errors: listed(error), warnings: [] };
  }
  const warnings = compatibilityProblems(benchmark);
  try {
    // A benchmark with no tests yet is fine; one whose selectors miss its tests is not.
    selectTests(benchmark, rows, { requireMatches: rows.length > 0 });
  } catch (error) {
    warnings.push(...listed(error));
  }
  return { raw, errors: [], warnings };
}

// Drops the empty fields a form row leaves behind (no repeats override, no scope).
function cleanEntry(entry) {
  const clean = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'scope') {
      const scope = cleanEntry(value);
      if (Object.keys(scope).length) clean.scope = scope;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * benchmark.yaml `text` with the form's `fields` written in. Keys the form did not
 * change keep their values and comments (the yaml library re-spaces trailing
 * comments); with no change at all the text comes back untouched.
 */
export function patchBenchmarkYaml(text, fields) {
  const doc = parseText(text);
  const before = benchmarkFormFields(doc.toJS()) ?? {};
  let changed = false;
  const set = (path, value) => {
    changed = true;
    if (value === null || value === undefined || value === '') doc.deleteIn(path);
    else doc.setIn(path, value);
  };
  for (const key of ['title', 'description', 'version']) {
    if (key in fields && !same(fields[key], before[key])) set([key], fields[key]);
  }
  for (const key of ['repeats', 'seed', 'timeout_s']) {
    if (key in fields && !same(fields[key], before[key])) set(['defaults', key], fields[key]);
  }
  if ('action_delay' in fields && !same(fields.action_delay, before.action_delay)) {
    set(['defaults', 'randomize', 'action_delay'], fields.action_delay);
  }
  if ('initial_joint_noise_rad' in fields && !same(fields.initial_joint_noise_rad, before.initial_joint_noise_rad)) {
    set(['defaults', 'randomize', 'initial_joint_noise_rad'], fields.initial_joint_noise_rad || null);
  }
  for (const key of ['tests', 'tasks']) {
    if (!Array.isArray(fields[key])) continue;
    const list = fields[key].map(cleanEntry);
    if (same(list, before[key])) continue;
    // One { ... } line per entry, as the starter writes them; the list's own comment is kept.
    const node = doc.createNode(list);
    for (const item of node.items) item.flow = true;
    const old = doc.get(key, true);
    if (old) {
      node.commentBefore = old.commentBefore;
      node.comment = old.comment;
    }
    doc.set(key, node);
    changed = true;
  }
  return changed ? String(doc) : text;
}

/**
 * Applies an edit from the dialog, `{ fields }` or `{ text }`, to the current
 * benchmark.yaml `text`. Throws (listing every problem) if `npm run benchmark`
 * would refuse the result; otherwise returns the new text and any warnings.
 */
export function applyBenchmarkEdit(text, edit, rows) {
  const next = typeof edit?.text === 'string' ? edit.text : patchBenchmarkYaml(text, edit?.fields ?? {});
  const { errors, warnings } = checkBenchmarkText(next, rows);
  if (errors.length) {
    const error = new Error(`Not saved, benchmark.yaml would be invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    error.problems = errors;
    throw error;
  }
  return { text: next, warnings };
}
