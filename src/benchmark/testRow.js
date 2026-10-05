// One benchmark test = one row of a Hugging Face benchmark dataset
// (data/<config>/test.jsonl). A row describes the scenario only: what is
// commanded, what pushes happen and on what floor. How often it runs, how its
// repeats are randomised and how it is scored belong to the suite (suite.js).
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
//                      torqueAxis, torqueMag, label, tier }]; tier is
//                      "reasonable" | "beyond" | null
//   limits          { vx, vy, wz: [lo, hi] } | null
//   foot_friction   number | null
//   metrics_opt_in  string[], e.g. ["gait_symmetry"]
//
// rowToSequence() turns a row into the sequence object commandSequencer and
// computeMetrics() play and score; sequenceToRow() folds an edited sequence
// (trajectory editor) back into a row.

import { TEST_KINDS, TEST_SCHEMA_VERSION } from './protocol.js';

export const TIERS = ['reasonable', 'beyond'];
const ID_RE = /^[a-z0-9][a-z0-9_]*\/[a-z0-9][a-z0-9_.-]*$/;
const OPT_IN_METRICS = ['gait_symmetry'];
const EVENT_KEYS = ['t', 'type', 'dir', 'force', 'duration', 'targetBody', 'torqueAxis', 'torqueMag', 'label', 'tier'];

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Structural checks for one row; returns a list of problems (empty = valid). */
export function validateTestRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['row is not an object'];
  const at = typeof row.id === 'string' ? row.id : '(no id)';
  const errors = [];
  const fail = (message) => errors.push(`${at}: ${message}`);

  if (typeof row.id !== 'string' || !ID_RE.test(row.id)) fail('id must look like "<config>/<name>" (lower case, digits, _)');
  if (typeof row.config !== 'string' || !row.id?.startsWith?.(`${row.config}/`)) fail('config must equal the part of id before "/"');
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
      if (!isNumber(event.t) || event.t < 0 || event.t > row.duration) fail(`${where}.t must be within 0..duration`);
      if (!Array.isArray(event.dir) || ![2, 3].includes(event.dir.length) || !event.dir.every(isNumber)) fail(`${where}.dir must be 2 or 3 numbers`);
      if (!isNumber(event.force) || event.force <= 0) fail(`${where}.force must be > 0 (Newtons)`);
      if (!isNumber(event.duration) || event.duration <= 0) fail(`${where}.duration must be > 0`);
      if (event.tier !== null && !TIERS.includes(event.tier)) fail(`${where}.tier must be ${TIERS.join(' | ')} or null`);
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
  if (!Array.isArray(row.metrics_opt_in) || row.metrics_opt_in.some((m) => !OPT_IN_METRICS.includes(m))) {
    fail(`metrics_opt_in must list only: ${OPT_IN_METRICS.join(', ')}`);
  }
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
  if (row.events.length) {
    sequence.events = row.events.map((event) => {
      const out = { t: event.t, type: 'push', dir: event.dir, force: event.force, duration: event.duration };
      if (event.targetBody) out.targetBody = event.targetBody;
      if (event.torqueAxis) {
        out.torqueAxis = event.torqueAxis;
        out.torqueMag = event.torqueMag;
      }
      if (event.label) out.label = event.label;
      if (event.tier) out.tier = event.tier;
      return out;
    });
  }
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
      tier: event.tier ?? null,
    })),
    limits: sequence.limits ?? null,
    foot_friction: sequence.footFriction ?? null,
    metrics_opt_in: sequence.gaitSymmetry === true ? ['gait_symmetry'] : [],
  };
}
