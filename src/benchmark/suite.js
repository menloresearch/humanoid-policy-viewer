// A benchmark suite (suite.yaml at the root of a Hugging Face benchmark dataset)
// says which tests run, how often, with what randomisation, how repeats are
// combined and which numbers become leaderboard tasks. The tests themselves are
// dataset rows (testRow.js). Example:
//
//   suite: asimov-locomotion
//   version: 1
//   harness: { repo: https://github.com/menloresearch/humanoid-policy-viewer, protocol: 1, tested_commit: <sha> }
//   requires: { robot: { name: asimov-1 }, policy_interface: velocity-command }
//   defaults:
//     repeats: 5
//     seed: 0
//     randomize: { action_delay: env_range, initial_joint_noise_rad: 0.02 }
//     aggregate: mean          # mean | median | worst
//     pass_rule: all_repeats   # all_repeats | fraction
//     timeout_s: 600           # wall-clock budget per cell
//   tests:
//     - { config: locomotion }
//     - { id: distance/square_lap_100m, repeats: 1 }
//   tasks:
//     - { id: upright_rate, metric: upright_rate }
//     - { id: push_standing_reasonable_pass, metric: push_pass_rate, scope: { config: push_standing, tier: reasonable } }
//
// Leaderboard task ids get the suite version appended (upright_rate_v1), so a
// new version starts new leaderboards instead of mixing incomparable numbers.

import { BENCHMARK_PROTOCOL, POLICY_INTERFACES, RANDOMIZERS, ROBOTS, TEST_KINDS } from './protocol.js';
import { cellSeed } from './rng.js';
import { METRICS } from './summary.js';
import { TIERS } from './testRow.js';

export const AGGREGATES = ['mean', 'median', 'worst'];
export const PASS_RULES = ['all_repeats', 'fraction'];
const TASK_ID_RE = /^[a-z][a-z0-9_]*$/;
const DEFAULTS = {
  repeats: 1,
  seed: 0,
  randomize: {},
  aggregate: 'mean',
  pass_rule: 'all_repeats',
  timeout_s: 600,
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function checkSettings(settings, where, errors) {
  if (settings.repeats !== undefined && (!Number.isInteger(settings.repeats) || settings.repeats < 1)) {
    errors.push(`${where}.repeats must be an integer >= 1`);
  }
  if (settings.seed !== undefined && !Number.isInteger(settings.seed)) errors.push(`${where}.seed must be an integer`);
  if (settings.aggregate !== undefined && !AGGREGATES.includes(settings.aggregate)) {
    errors.push(`${where}.aggregate must be one of ${AGGREGATES.join(', ')}`);
  }
  if (settings.pass_rule !== undefined && !PASS_RULES.includes(settings.pass_rule)) {
    errors.push(`${where}.pass_rule must be one of ${PASS_RULES.join(', ')}`);
  }
  if (settings.timeout_s !== undefined && !(Number.isFinite(settings.timeout_s) && settings.timeout_s > 0)) {
    errors.push(`${where}.timeout_s must be a number > 0`);
  }
  if (settings.randomize !== undefined) {
    if (!isPlainObject(settings.randomize)) {
      errors.push(`${where}.randomize must be a mapping`);
    } else {
      for (const [key, value] of Object.entries(settings.randomize)) {
        const accepts = RANDOMIZERS[key];
        if (!accepts) errors.push(`${where}.randomize.${key} is not supported by this viewer (protocol ${BENCHMARK_PROTOCOL}); supported: ${Object.keys(RANDOMIZERS).join(', ')}`);
        else if (Array.isArray(accepts) ? !accepts.includes(value) : !(Number.isFinite(value) && value >= 0)) {
          errors.push(`${where}.randomize.${key} must be ${Array.isArray(accepts) ? accepts.join(' | ') : accepts}`);
        }
      }
    }
  }
}

/** True when the randomisation actually varies anything between repeats. */
export function randomizes(randomize) {
  return (randomize?.action_delay === 'env_range') || (randomize?.initial_joint_noise_rad ?? 0) > 0;
}

/**
 * Validates a parsed suite.yaml and fills in defaults. Throws one Error listing
 * every problem, so an author fixes them all in one pass.
 */
export function parseSuite(raw) {
  const errors = [];
  if (!isPlainObject(raw)) throw new Error('suite.yaml must be a mapping');
  if (typeof raw.suite !== 'string' || !raw.suite) errors.push('suite (name) is required');
  if (!Number.isInteger(raw.version) || raw.version < 1) errors.push('version must be an integer >= 1');
  if (!isPlainObject(raw.harness) || !Number.isInteger(raw.harness.protocol)) errors.push('harness.protocol (integer) is required');
  if (!isPlainObject(raw.requires)) errors.push('requires is required');

  const defaults = { ...DEFAULTS, ...(raw.defaults ?? {}) };
  defaults.randomize = { ...(raw.defaults?.randomize ?? {}) };
  checkSettings(defaults, 'defaults', errors);

  const tests = asList(raw.tests);
  if (!tests.length) errors.push('tests must select at least one test');
  tests.forEach((entry, i) => {
    if (!isPlainObject(entry) || (!entry.id && !entry.config) || (entry.id && entry.config)) {
      errors.push(`tests[${i}] must have exactly one of id or config`);
      return;
    }
    checkSettings(entry, `tests[${i}]`, errors);
  });

  const tasks = asList(raw.tasks);
  const seen = new Set();
  tasks.forEach((task, i) => {
    if (!isPlainObject(task) || !TASK_ID_RE.test(task.id ?? '')) {
      errors.push(`tasks[${i}].id must be lower_snake_case`);
      return;
    }
    if (seen.has(task.id)) errors.push(`tasks[${i}].id "${task.id}" is used twice`);
    seen.add(task.id);
    if (/_v\d+$/.test(task.id)) errors.push(`tasks[${i}].id must not end in _v<n>; the suite version is appended for you`);
    if (!METRICS[task.metric]) errors.push(`tasks[${i}].metric "${task.metric}" is unknown; known: ${Object.keys(METRICS).join(', ')}`);
    const scope = task.scope ?? {};
    if (!isPlainObject(scope)) errors.push(`tasks[${i}].scope must be a mapping`);
    else {
      for (const key of Object.keys(scope)) if (!['config', 'id', 'tier'].includes(key)) errors.push(`tasks[${i}].scope.${key} is unknown (config, id, tier)`);
      if (scope.tier !== undefined && !TIERS.includes(scope.tier)) errors.push(`tasks[${i}].scope.tier must be ${TIERS.join(' | ')}`);
    }
  });

  if (errors.length) throw new Error(`Invalid suite.yaml:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return {
    ...raw,
    defaults,
    tests,
    tasks: tasks.map((task) => ({ ...task, scope: task.scope ?? {} })),
  };
}

/** Why this checkout cannot run the suite as published (empty = it can). */
export function compatibilityProblems(suite, { protocol = BENCHMARK_PROTOCOL } = {}) {
  const problems = [];
  if (suite.harness.protocol !== protocol) {
    const commit = suite.harness.tested_commit ? ` (it was validated on viewer commit ${suite.harness.tested_commit})` : '';
    problems.push(`the suite needs benchmark protocol ${suite.harness.protocol}, this viewer implements ${protocol}${commit}`);
  }
  const robot = suite.requires?.robot?.name ?? suite.requires?.robot;
  if (robot && !ROBOTS.includes(robot)) problems.push(`robot "${robot}" is not supported (supported: ${ROBOTS.join(', ')})`);
  const policyInterface = suite.requires?.policy_interface;
  if (policyInterface && !POLICY_INTERFACES.includes(policyInterface)) {
    problems.push(`policy interface "${policyInterface}" is not supported (supported: ${POLICY_INTERFACES.join(', ')})`);
  }
  return problems;
}

function matches(selector, row) {
  return selector.id ? row.id === selector.id : row.config === selector.config;
}

/**
 * Resolves the suite's test selectors against the dataset rows, in suite order,
 * and merges settings: suite defaults, then every selector matching the row
 * (later ones win). Throws when a selector matches nothing.
 */
export function selectTests(suite, rows) {
  const byId = new Map();
  const problems = [];
  suite.tests.forEach((selector, i) => {
    const hits = rows.filter((row) => matches(selector, row));
    if (!hits.length) problems.push(`tests[${i}] (${selector.id ?? `config ${selector.config}`}) matches no test in the dataset`);
    for (const row of hits) {
      const { id, config, ...overrides } = selector;
      const previous = byId.get(row.id);
      byId.set(row.id, {
        row,
        settings: {
          ...(previous?.settings ?? suite.defaults),
          ...overrides,
          randomize: { ...(previous?.settings ?? suite.defaults).randomize, ...(overrides.randomize ?? {}) },
        },
      });
    }
  });
  for (const { row, settings } of byId.values()) {
    if (!TEST_KINDS.includes(row.kind)) problems.push(`${row.id}: kind "${row.kind}" is not supported by this viewer`);
    // Without randomisation every repeat is the same run (the sim is deterministic).
    if (settings.repeats > 1 && !randomizes(settings.randomize)) {
      problems.push(`${row.id}: repeats is ${settings.repeats} but nothing is randomised, so every repeat would be identical`);
    }
  }
  if (problems.length) throw new Error(`Cannot run the suite:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return [...byId.values()];
}

/**
 * One cell = one (test, repeat). Policies are crossed with cells by the runner.
 * `only` restricts to some test ids; `repeats` overrides every test's count.
 */
export function expandCells(selected, { only = null, repeats = null } = {}) {
  const wanted = only ? new Set(only) : null;
  if (wanted) {
    const known = new Set(selected.map(({ row }) => row.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown test id(s): ${unknown.join(', ')}`);
  }
  const cells = [];
  for (const { row, settings } of selected) {
    if (wanted && !wanted.has(row.id)) continue;
    const count = repeats ?? settings.repeats;
    for (let repeat = 0; repeat < count; repeat++) {
      cells.push({
        cellId: `${row.id}#${repeat}`,
        testId: row.id,
        repeat,
        seed: cellSeed(settings.seed, row.id, repeat),
        randomize: settings.randomize,
        timeoutS: settings.timeout_s,
        duration: row.duration,
      });
    }
  }
  return cells;
}

export function versionedTaskId(suite, task) {
  return `${task.id}_v${suite.version}`;
}

/** The Hugging Face eval.yaml for this suite; generated, never hand-edited. */
export function buildEvalYaml(suite, { name, description }) {
  return {
    name,
    description,
    evaluation_framework: 'humanoid-policy-viewer',
    tasks: suite.tasks.map((task) => {
      const entry = { id: versionedTaskId(suite, task) };
      if (typeof task.scope.config === 'string') {
        entry.config = task.scope.config;
        entry.split = 'test';
      }
      return entry;
    }),
  };
}
