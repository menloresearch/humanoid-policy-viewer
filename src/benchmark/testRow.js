// One benchmark test = one row of a Hugging Face benchmark dataset
// (data/<config>/test.jsonl). A row describes the scenario only: what is
// commanded, what pushes happen and on what floor and terrain. How often it runs, how its
// repeats are randomised and how it is scored belong to the benchmark settings (settings.js).
//
// Row fields (every row carries every key, so the dataset has one schema):
//   id              "<config>/<name>", stable; results refer to tests by it
//   config          dataset config (category), e.g. "push_walking"
//   schema_version  TEST_SCHEMA_VERSION
//   kind            "velocity-sequence"
//   name            human-readable title
//   description     free text, may be ""
//   tags            string[]
//   duration        seconds
//   commands        [{ t, vx, vy, wz }]
//   events          [{ t, type: "push", dir, force, duration, targetBody,
//                      torqueAxis, torqueMag, label }]
//   limits          { vx, vy, wz: [lo, hi] } | null
//   foot_friction   number | null
//   terrain         { type: "stairs" | "slope" | "boxes" | "rough", ...parameters }
//                   | null: the course this test walks on, built from its
//                   parameters (src/simulation/terrainGen.js)
//   goal            { x, y, radius_m } | null: an end zone the robot's base must
//                   enter for the run to count as survived
//   metrics_opt_in  string[], e.g. ["gait_symmetry"]
//   start           { pos, rot, lin_vel, ang_vel, joint_pos, joint_vel } | null:
//                   where the robot starts, in env.yaml's init_state shape; the
//                   keys it gives replace the policy's own init_state
//                   (src/simulation/startState.js). null = the policy's own.
//                   Stored as JSON text on the Hub (rowToHub / rowFromHub).
//   drop_settle_s   number | null: seconds the robot is left limp to settle
//                   before the test's clock starts; null = off
//
// rowToSequence() turns a row into the sequence object commandSequencer and
// computeMetrics() play and score; sequenceToRow() folds an edited sequence
// (trajectory editor) back into a row.

import { TEST_KINDS, TEST_SCHEMA_VERSION } from './protocol.js';
import { TERRAIN_TYPES, validateTerrain } from '../simulation/terrainGen.js';
import { validateSettle, validateStartState } from '../simulation/startState.js';

// The dataset config that holds every test (data/*/test.jsonl); not a category.
export const ALL_CONFIG = 'all';
const ID_RE = /^[a-z0-9][a-z0-9_]*\/[a-z0-9][a-z0-9_.-]*$/;
// Diagnostics a test opts into (survival is always measured). The editor's metrics checklist offers these.
export const OPT_IN_METRICS = ['gait_symmetry', 'command_tracking', 'drift', 'action_smoothness'];
// A push starts once the robot has settled and ends with time left to recover before the test does.
export const PUSH_START_MIN_S = 1;
export const PUSH_END_MARGIN_S = 2;

/** The latest start time of a push held for `pushDuration` in a test lasting `duration`. */
export function latestPushStart(duration, pushDuration) {
  return duration - PUSH_END_MARGIN_S - pushDuration;
}

// An end zone: a circle on the floor the robot's base must enter, so a policy
// cannot survive a course by stopping in front of it. Positions are sampled at
// least every ~0.25 s, so a smaller circle could be crossed between samples.
export const GOAL_MIN_RADIUS_M = 0.25;

/** Problems with a goal spec { x, y, radius_m } (metres from the robot's start; +x ahead, +y left). */
export function validateGoal(goal) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return ['must be an object like { "x": 7, "y": 0, "radius_m": 1 }'];
  const errors = [];
  for (const key of Object.keys(goal)) if (!['x', 'y', 'radius_m'].includes(key)) errors.push(`unknown key "${key}"`);
  for (const key of ['x', 'y']) {
    if (!isNumber(goal[key])) errors.push(`${key} is required (a number, metres)`);
    else if (Math.abs(goal[key] * 100 - Math.round(goal[key] * 100)) > 1e-6) errors.push(`${key} has more than 2 decimals (1 cm is the finest step)`);
  }
  if (!isNumber(goal.radius_m) || goal.radius_m < GOAL_MIN_RADIUS_M) errors.push(`radius_m must be a number >= ${GOAL_MIN_RADIUS_M}`);
  return errors;
}

const EVENT_KEYS = ['t', 'type', 'dir', 'force', 'duration', 'targetBody', 'torqueAxis', 'torqueMag', 'label'];

// The row schema in Hugging Face `datasets` terms, declared in the dataset card
// (dataset_info.features) so the Hub never has to guess column types. Guessing
// fails: a column that is null in every row of one file (foot_friction outside
// the friction tests) cannot be merged with the numbers in another.
const float = { dtype: 'float64' };
const floats = { sequence: 'float64' };
const string = { dtype: 'string' };
// A struct has one fixed field set, so terrain declares the union of every
// course type's parameters; parameters another type does not use stay null.
const terrainFeatures = [['type', string]];
for (const def of Object.values(TERRAIN_TYPES)) {
  for (const [key, p] of Object.entries(def.params)) {
    if (!terrainFeatures.some(([name]) => name === key)) terrainFeatures.push([key, p.integer ? { dtype: 'int64' } : float]);
  }
}
export const ROW_FEATURES = [
  ['id', string], ['config', string], ['schema_version', { dtype: 'int64' }], ['kind', string], ['name', string],
  ['description', string], ['tags', { sequence: 'string' }], ['duration', float],
  ['commands', { list: [['t', float], ['vx', float], ['vy', float], ['wz', float]] }],
  ['events', {
    list: [
      ['t', float], ['type', string], ['dir', floats], ['force', float], ['duration', float], ['targetBody', string],
      ['torqueAxis', floats], ['torqueMag', float], ['label', string],
    ],
  }],
  ['limits', { struct: [['vx', floats], ['vy', floats], ['wz', floats]] }],
  ['foot_friction', float], ['terrain', { struct: terrainFeatures }],
  ['goal', { struct: [['x', float], ['y', float], ['radius_m', float]] }], ['metrics_opt_in', { sequence: 'string' }],
  // env.yaml's init_state keys joints by name pattern, which no fixed struct can declare.
  ['start', string], ['drop_settle_s', float],
];

// Columns added after the first published benchmarks; a row without one reads as null.
const LATER_KEYS = ['start', 'drop_settle_s'];

/**
 * A row as read from a test.jsonl, local or from the Hub: `start` parsed from
 * its JSON text, and the later columns an older row lacks set to null.
 */
export function rowFromHub(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const key of LATER_KEYS) if (!(key in out)) out[key] = null;
  if (typeof out.start === 'string') {
    try {
      out.start = JSON.parse(out.start);
    } catch {
      // Left as text; validateTestRow reports it.
    }
  }
  return out;
}

/** A row as published: `start` as JSON text, the type the dataset card declares. */
export function rowToHub(row) {
  return row.start && typeof row.start === 'object' ? { ...row, start: JSON.stringify(row.start) } : row;
}

/** ROW_FEATURES as the YAML structure `datasets` reads from a card. */
export function rowFeaturesYaml(features = ROW_FEATURES) {
  return features.map(([name, type]) => {
    if (type.list) return { name, list: rowFeaturesYaml(type.list) };
    if (type.struct) return { name, struct: rowFeaturesYaml(type.struct) };
    return { name, ...type };
  });
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Structural checks for one row; returns a list of problems (empty = valid). */
export function validateTestRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['row is not an object'];
  const at = typeof row.id === 'string' ? row.id : '(no id)';
  const errors = [];
  const fail = (message) => errors.push(`${at}: ${message}`);

  if (typeof row.id !== 'string' || !ID_RE.test(row.id)) fail('id must look like "<config>/<name>" (lower case, digits, _)');
  if (typeof row.config !== 'string' || !row.id?.startsWith?.(`${row.config}/`)) fail('config must equal the part of id before "/"');
  if (row.config === ALL_CONFIG) fail(`"${ALL_CONFIG}" is reserved (the dataset config holding every test); pick another category name`);
  if (row.schema_version !== TEST_SCHEMA_VERSION) fail(`schema_version must be ${TEST_SCHEMA_VERSION}`);
  if (!TEST_KINDS.includes(row.kind)) fail(`kind "${row.kind}" is not one of ${TEST_KINDS.join(', ')}`);
  if (typeof row.name !== 'string' || !row.name) fail('name must be a non-empty string');
  if (typeof row.description !== 'string') fail('description must be a string');
  if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== 'string')) fail('tags must be a list of strings');
  if (!isNumber(row.duration) || row.duration <= 0) fail('duration must be a number > 0');

  if (!Array.isArray(row.commands) || !row.commands.length) {
    fail('commands must be a non-empty list');
  } else {
    row.commands.forEach((cmd, i) => {
      if (!cmd || !['t', 'vx', 'vy', 'wz'].every((key) => isNumber(cmd[key]))) fail(`commands[${i}] needs numeric t, vx, vy, wz`);
      else if (cmd.t < 0 || cmd.t > row.duration) fail(`commands[${i}].t is outside 0..duration`);
    });
  }

  if (!Array.isArray(row.events)) {
    fail('events must be a list (may be empty)');
  } else {
    row.events.forEach((event, i) => {
      const where = `events[${i}]`;
      if (!event || event.type !== 'push') return fail(`${where}.type must be "push"`);
      for (const key of Object.keys(event)) if (!EVENT_KEYS.includes(key)) fail(`${where} has unknown key "${key}"`);
      if (!isNumber(event.t) || event.t < PUSH_START_MIN_S) fail(`${where}.t must be at least ${PUSH_START_MIN_S} s (the robot settles first)`);
      else if (isNumber(event.duration) && event.t > latestPushStart(row.duration, event.duration)) {
        fail(`${where} must end at least ${PUSH_END_MARGIN_S} s before the test does (t + duration <= ${row.duration - PUSH_END_MARGIN_S})`);
      }
      if (!Array.isArray(event.dir) || ![2, 3].includes(event.dir.length) || !event.dir.every(isNumber)) fail(`${where}.dir must be 2 or 3 numbers`);
      if (!isNumber(event.force) || event.force <= 0) fail(`${where}.force must be > 0 (Newtons)`);
      if (!isNumber(event.duration) || event.duration <= 0) fail(`${where}.duration must be > 0`);
      if (event.targetBody !== null && typeof event.targetBody !== 'string') fail(`${where}.targetBody must be a string or null`);
      if (event.label !== null && typeof event.label !== 'string') fail(`${where}.label must be a string or null`);
    });
  }

  if (row.limits !== null) {
    const ok = row.limits && typeof row.limits === 'object'
      && Object.entries(row.limits).every(([axis, pair]) => ['vx', 'vy', 'wz'].includes(axis)
        && Array.isArray(pair) && pair.length === 2 && pair.every(isNumber) && pair[0] < pair[1]);
    if (!ok) fail('limits must be null or { vx|vy|wz: [lo, hi] }');
  }
  if (row.foot_friction !== null && (!isNumber(row.foot_friction) || row.foot_friction <= 0)) fail('foot_friction must be null or a number > 0');
  if (row.terrain !== null) for (const problem of validateTerrain(row.terrain)) fail(`terrain: ${problem}`);
  if (row.goal !== null) for (const problem of validateGoal(row.goal)) fail(`goal: ${problem}`);
  if (!Array.isArray(row.metrics_opt_in) || row.metrics_opt_in.some((m) => !OPT_IN_METRICS.includes(m))) {
    fail(`metrics_opt_in must list only: ${OPT_IN_METRICS.join(', ')}`);
  }
  // A row from before these columns may lack them (rowFromHub fills them in).
  if (row.start !== null && row.start !== undefined) for (const problem of validateStartState(row.start)) fail(`start: ${problem}`);
  for (const problem of validateSettle(row.drop_settle_s)) fail(`drop_settle_s ${problem}`);
  return errors;
}

/** Builds the sequence object commandSequencer.loadSequence() and computeMetrics() consume. */
export function rowToSequence(row) {
  const sequence = {
    name: row.name,
    duration: row.duration,
    commands: row.commands.map(({ t, vx, vy, wz }) => ({ t, vx, vy, wz })),
  };
  if (row.limits) sequence.limits = row.limits;
  if (row.foot_friction !== null && row.foot_friction !== undefined) sequence.footFriction = row.foot_friction;
  if (row.terrain) sequence.terrain = { ...row.terrain };
  if (row.goal) sequence.goal = { ...row.goal };
  if (row.start) sequence.start = structuredClone(row.start);
  if (row.drop_settle_s) sequence.dropSettleS = row.drop_settle_s;
  if (row.events.length) {
    sequence.events = row.events.map((event) => {
      const out = { t: event.t, type: 'push', dir: event.dir, force: event.force, duration: event.duration };
      if (event.targetBody) out.targetBody = event.targetBody;
      if (event.torqueAxis) {
        out.torqueAxis = event.torqueAxis;
        out.torqueMag = event.torqueMag;
      }
      if (event.label) out.label = event.label;
      return out;
    });
  }
  if (row.metrics_opt_in.length) sequence.metricsOptIn = [...row.metrics_opt_in];
  if (row.metrics_opt_in.includes('gait_symmetry')) sequence.gaitSymmetry = true;
  return sequence;
}

/**
 * Folds an edited sequence (from the trajectory editor) back into a row, keeping
 * the row's identity and the fields the editor does not know (description, tags).
 */
export function sequenceToRow(id, sequence, previous = null) {
  const config = id.split('/')[0];
  return {
    id,
    config,
    schema_version: TEST_SCHEMA_VERSION,
    kind: previous?.kind ?? 'velocity-sequence',
    name: sequence.name,
    description: previous?.description ?? '',
    tags: previous?.tags ?? [],
    duration: sequence.duration,
    commands: sequence.commands.map(({ t, vx = 0, vy = 0, wz = 0 }) => ({ t, vx, vy, wz })),
    events: (sequence.events ?? []).map((event) => ({
      t: event.t,
      type: event.type,
      dir: event.dir,
      force: event.force,
      duration: event.duration,
      targetBody: event.targetBody ?? null,
      torqueAxis: event.torqueAxis ?? null,
      torqueMag: event.torqueMag ?? null,
      label: event.label ?? null,
    })),
    limits: sequence.limits ?? null,
    foot_friction: sequence.footFriction ?? null,
    terrain: sequence.terrain ? { ...sequence.terrain } : null,
    goal: sequence.goal ? { ...sequence.goal } : null,
    // In OPT_IN_METRICS order; older sequences only carry the gaitSymmetry flag.
    metrics_opt_in: OPT_IN_METRICS.filter((m) => (sequence.metricsOptIn ?? (sequence.gaitSymmetry === true ? ['gait_symmetry'] : [])).includes(m)),
    start: sequence.start ? structuredClone(sequence.start) : null,
    drop_settle_s: sequence.dropSettleS ?? null,
  };
}
