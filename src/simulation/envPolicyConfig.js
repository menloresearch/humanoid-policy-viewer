// Read the small, stable subset of Isaac Lab / mjlab env.yaml that defines
// joint position actions. The files contain Python-specific YAML tags, so
// traversing the relevant indented blocks avoids interpreting those tags.

// Isaac Lab/mjlab exports commonly place a policy's config files (env.yaml,
// agent.yaml, tracking_policy.json, ...) under params/, but some policies
// keep them at the policy root instead. Every caller that resolves one of these
// per-policy files checks params/<name> before falling back to <name>.
export function policyFileCandidates(filename) {
  return [`params/${filename}`, filename];
}

function linesOf(yaml) {
  return yaml.split(/\r?\n/).map((raw) => ({
    indent: raw.match(/^ */)[0].length,
    text: raw.trim().replace(/\s+#.*$/, '')
  })).filter((line) => line.text && !line.text.startsWith('#'));
}

function block(lines, path) {
  let scope = lines;
  for (const name of path) {
    const childIndent = Math.min(...scope.map((line) => line.indent));
    const entry = scope.findIndex((line) => line.indent === childIndent && line.text.startsWith(`${name}:`));
    if (entry < 0) return null;
    const indent = scope[entry].indent;
    let end = entry + 1;
    while (end < scope.length && (scope[end].indent > indent || (scope[end].indent === indent && scope[end].text.startsWith('- ')))) end++;
    scope = scope.slice(entry + 1, end);
  }
  return scope;
}

function fields(lines, indent) {
  const result = {};
  for (const line of lines) {
    if (line.indent !== indent) continue;
    const match = line.text.match(/^([^:]+):(?:\s*(.*))?$/);
    if (match) result[match[1].trim()] = match[2]?.trim() ?? '';
  }
  return result;
}

function scalar(value) {
  const number = Number(value);
  if (value === '' || !Number.isFinite(number)) throw new Error(`Expected a numeric env.yaml value, got ${value}`);
  return number;
}

function matchValue(entries, name, label) {
  const exact = entries.find(([pattern]) => pattern === name);
  if (exact) return scalar(exact[1]);
  const matches = entries.filter(([pattern]) => {
    try { return new RegExp(`^(?:${pattern})$`).test(name); }
    catch { throw new Error(`Invalid ${label} joint pattern in env.yaml: ${pattern}`); }
  });
  if (matches.length !== 1) throw new Error(`Expected one ${label} setting for ${name} in env.yaml; found ${matches.length}`);
  return scalar(matches[0][1]);
}

function valuesForJoints(map, jointNames, label) {
  const entries = Object.entries(map);
  return jointNames.map((name) => matchValue(entries, name, label));
}

function directFields(lines) {
  if (!lines?.length) return {};
  return fields(lines, Math.min(...lines.map((line) => line.indent)));
}

function listAfter(lines, key) {
  const index = lines.findIndex((line) => line.text.startsWith(`${key}:`));
  if (index < 0) return [];
  const indent = lines[index].indent;
  const result = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].indent < indent || !lines[i].text.startsWith('- ')) break;
    result.push(lines[i].text.slice(2).trim());
  }
  return result;
}

// An actuator group's settings. A gain or limit given per joint pattern (a
// nested map, e.g. one group for every joint with `stiffness: {.*_knee_joint:
// 150.0, ...}`) is kept as that map and resolved per joint by matchOneActuator.
function actuatorFields(item, indent) {
  const config = fields(item, indent);
  for (const key of ['stiffness', 'damping', 'effort_limit']) {
    if (config[key] !== '') continue;
    const map = block(item, [key]);
    if (map?.length) config[key] = directFields(map);
  }
  return config;
}

function isaacActuators(lines) {
  const entries = [];
  const indent = Math.min(...lines.map((line) => line.indent));
  for (let i = 0; i < lines.length;) {
    if (lines[i].indent !== indent || !lines[i].text.endsWith(':')) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && lines[end].indent > indent) end++;
    const item = lines.slice(i + 1, end);
    const config = actuatorFields(item, indent + 2);
    for (const pattern of listAfter(item, 'joint_names_expr')) {
      entries.push({ pattern, stiffness: config.stiffness, damping: config.damping, effort_limit: config.effort_limit, min_delay: config.min_delay, max_delay: config.max_delay });
    }
    i = end;
  }
  return entries;
}

function mjlabActuators(lines) {
  const entries = [];
  const indent = Math.min(...lines.map((line) => line.indent));
  for (let i = 0; i < lines.length;) {
    if (lines[i].indent !== indent || !lines[i].text.startsWith('- ')) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && lines[end].indent > indent) end++;
    const item = lines.slice(i + 1, end);
    const config = actuatorFields(item, indent + 2);
    const firstPattern = lines[i].text.match(/^- target_names_expr:\s*(.+)$/)?.[1];
    const patterns = firstPattern && !firstPattern.startsWith('!!')
      ? [firstPattern]
      : listAfter([{ indent, text: lines[i].text.slice(2) }, ...item], 'target_names_expr');
    for (const pattern of patterns) entries.push({ pattern, stiffness: config.stiffness, damping: config.damping, effort_limit: config.effort_limit, min_delay: config.min_delay, max_delay: config.max_delay });
    i = end;
  }
  return entries;
}

// Per-joint torque cap the policy was trained with (Isaac Lab/mjlab
// `effort_limit`, N*m). The robot model's own limits are hardware maxima and
// usually differ, so the sim must follow training. Returns null when no joint
// declares a numeric value (a null effort_limit means "use the robot model's
// limit", which this file can't see) so the caller can warn; throws if only
// some joints do, since the rest would silently go unclamped.
function torqueLimitsFor(jointNames, matchOneActuator) {
  const values = jointNames.map((name) => {
    const raw = matchOneActuator(name).effort_limit;
    const number = Number(raw);
    return raw === undefined || raw === '' || !Number.isFinite(number) ? null : number;
  });
  if (values.every((value) => value === null)) return null;
  const missing = jointNames.filter((_, i) => values[i] === null);
  if (missing.length) throw new Error(`env.yaml declares effort_limit for some joints but not: ${missing.join(', ')}`);
  const invalid = jointNames.filter((_, i) => values[i] <= 0);
  if (invalid.length) throw new Error(`env.yaml effort_limit must be positive for: ${invalid.join(', ')}`);
  return values;
}

// Action-delay range (min_delay/max_delay, drawn once per policy tick — see
// mujocoUtils.js's configureActionDelay) is applied uniformly to the whole
// policy, not per-joint, so this returns a single scalar range rather than
// one value per joint like the gains above. Returns null when this env.yaml's
// actuators don't declare delay fields at all (e.g. a non-delayed actuator
// class), so callers fall back to the shared base config unchanged — same as
// before this was wired up. Throws if only some actuator groups declare it,
// or if matched groups disagree on the range, since either would mean a
// silently-wrong single delay value.
function delayForJoints(actuators, jointNames, matchOneActuator) {
  const values = jointNames.map((name) => {
    const { min_delay, max_delay } = matchOneActuator(name);
    if (min_delay === undefined && max_delay === undefined) return null;
    if (min_delay === undefined || max_delay === undefined) {
      throw new Error(`env.yaml's actuator for ${name} declares only one of min_delay/max_delay`);
    }
    return [scalar(min_delay), scalar(max_delay)];
  });
  if (values.every((v) => v === null)) return null;
  if (values.some((v) => v === null)) {
    throw new Error('env.yaml declares min_delay/max_delay for some actuator groups but not others');
  }
  const [lo, hi] = values[0];
  if (values.some(([l, h]) => l !== lo || h !== hi)) {
    throw new Error('env.yaml actuator groups declare different min_delay/max_delay ranges; per-joint action delay is not supported');
  }
  return { delay_min_lag: lo, delay_max_lag: hi };
}

// The command range a policy was actually trained against (the RL command
// curriculum, not an actuator/gain setting) — Isaac Lab keeps it at
// commands.twist.ranges.{lin_vel_x,lin_vel_y,ang_vel_z}, each a 2-number
// tuple. Returns null (not an error) when this env.yaml has no such section
// at all — older/mjlab exports may not — so callers fall back to the shared
// global default unchanged. A section that exists but is missing one of the
// three axes is treated as a real authoring problem and throws, same as the
// delay fields above.
function commandRangesFor(lines) {
  const ranges = block(lines, ['commands', 'twist', 'ranges']);
  if (!ranges) return null;
  const axis = (key) => {
    const values = listAfter(ranges, key).map(Number);
    if (values.length !== 2 || values.some((v) => !Number.isFinite(v))) return null;
    return values;
  };
  const vx = axis('lin_vel_x');
  const vy = axis('lin_vel_y');
  const wz = axis('ang_vel_z');
  if (!vx && !vy && !wz) return null;
  if (!vx || !vy || !wz) {
    throw new Error('env.yaml has commands.twist.ranges but is missing lin_vel_x/lin_vel_y/ang_vel_z');
  }
  return { command_limits: { vx, vy, wz } };
}

// A fixed-size vector setting, written as a YAML block list (Isaac Lab's
// `!!python/tuple` followed by `- x` lines) or a flow list (`[x, y, z]`).
// Null when absent; throws when present but not `size` numbers.
function vectorAt(lines, key, size) {
  const line = lines.find((item) => item.text.startsWith(`${key}:`));
  if (!line) return null;
  const inline = line.text.slice(key.length + 1).trim();
  const items = inline.startsWith('[')
    ? inline.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean)
    : listAfter(lines, key);
  const values = items.map(Number);
  if (values.length !== size || !values.every(Number.isFinite)) throw new Error(`env.yaml init_state.${key} must be ${size} numbers`);
  return values;
}

// The robot's state at reset (init_state): base pose and velocities, and the
// joint velocities aligned with jointNames. The joint positions are the
// default pose, read separately as default_joint_pos.
function initStateFor(initState, jointNames) {
  const state = {};
  for (const [key, size] of [['pos', 3], ['rot', 4], ['lin_vel', 3], ['ang_vel', 3]]) {
    const value = vectorAt(initState, key, size);
    if (value) state[key] = value;
  }
  const jointVel = block(initState, ['joint_vel']);
  if (jointVel?.length) state.joint_vel = valuesForJoints(directFields(jointVel), jointNames, 'initial joint velocity');
  return state;
}

// Children of a YAML block that are themselves maps, as [name, lines] pairs.
function mapEntries(lines) {
  const entries = [];
  const indent = Math.min(...lines.map((line) => line.indent));
  for (let i = 0; i < lines.length;) {
    if (lines[i].indent !== indent || !lines[i].text.endsWith(':')) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && lines[end].indent > indent) end++;
    if (end > i + 1) entries.push([lines[i].text.slice(0, -1), lines.slice(i + 1, end)]);
    i = end;
  }
  return entries;
}

function optionalNumber(value) {
  const number = Number(value);
  return value === undefined || value === '' || value === 'null' || !Number.isFinite(number) ? null : number;
}

// Whether a setting such as `clip` holds a value: not absent, null or empty. A
// tuple or map written on the following lines counts.
function isSet(lines, key) {
  const value = directFields(lines)[key];
  if (value === undefined || ['null', '~', '{}', '[]'].includes(value)) return false;
  return value !== '' || (block(lines, [key])?.length ?? 0) > 0;
}

// The viewer observation each env.yaml policy term maps to, keyed by the
// observation function's name (after the module path), the `quantity` param of
// a delayed-observation wrapper, or the term's own name.
const OBS_KINDS = {
  base_ang_vel: 'ang_vel',
  projected_gravity: 'gravity',
  generated_commands: 'command',
  joint_pos_rel: 'joint_pos',
  joint_vel_rel: 'joint_vel',
  last_action: 'last_action',
};

function obsKind(name, func, params) {
  const funcName = func?.split(/[:.]/).pop();
  return OBS_KINDS[funcName] ?? OBS_KINDS[params.quantity] ?? OBS_KINDS[name] ?? null;
}

function slotIndices(name, termLines, jointNames) {
  const assetLines = block(termLines, ['params', 'asset_cfg']) ?? [];
  const names = listAfter(assetLines, 'joint_names');
  if (names.length === 0) throw new Error(`${name} does not list its joint_names, so its joint order is unknown`);
  if (names.length > 1 && directFields(assetLines).preserve_order !== 'true') {
    throw new Error(`${name} does not set preserve_order, so its joint order follows the robot asset, which the viewer cannot see`);
  }
  return names.map((joint) => {
    const index = jointNames.indexOf(joint);
    if (index < 0) throw new Error(`${name} reads ${joint}, which the viewer's robot does not have`);
    return index;
  });
}

// The body the viewer reads angular velocity and gravity at: the robot's root,
// as Isaac Lab's base_ang_vel and projected_gravity do.
const IMU_BODY = 'pelvis_link';

// A term may read the IMU quantity at another body through
// params.asset_cfg.body_names (e.g. a torso IMU at waist_yaw_link), which the
// viewer does not compute.
function atRootBody(name, termLines) {
  const bodies = listAfter(block(termLines, ['params', 'asset_cfg']) ?? [], 'body_names');
  const other = bodies.filter((body) => body !== IMU_BODY);
  if (other.length) throw new Error(`${name} is read at ${other.join(', ')} in training, but the viewer reads it at the pelvis (${IMU_BODY})`);
}

function unscaled(name, scale) {
  if (scale !== null && scale !== 1) throw new Error(`${name} is scaled by ${scale}, which the viewer does not support for this observation`);
}

function obsEntryFor(name, termLines, kind, scale, lines, jointNames) {
  const params = directFields(block(termLines, ['params']));
  if (kind === 'ang_vel') { atRootBody(name, termLines); return { name: 'AsimovAngVel', scale: scale ?? 1 }; }
  if (kind === 'gravity') { atRootBody(name, termLines); unscaled(name, scale); return { name: 'AsimovProjectedGravity' }; }
  if (kind === 'last_action') { unscaled(name, scale); return { name: 'AsimovPrevActions' }; }
  if (kind === 'joint_pos') {
    unscaled(name, scale);
    return { name: 'AsimovJointPosSlot', slot_name: name.replace(/^joint_pos_?/, '') || 'all', indices: slotIndices(name, termLines, jointNames) };
  }
  if (kind === 'joint_vel') {
    return { name: 'AsimovJointVelSlot', slot_name: name.replace(/^joint_vel_?/, '') || 'all', scale: scale ?? 1, indices: slotIndices(name, termLines, jointNames) };
  }
  // A command term: which command it reads decides what it is.
  unscaled(name, scale);
  const command = block(lines, ['commands', params.command_name]);
  const settings = directFields(command);
  const classType = settings.class_type ?? '';
  if (/VelocityCommand$/.test(classType)) return { name: 'AsimovCommand' };
  if (/GaitClockCommand$/.test(classType)) {
    const period = (key) => {
      const value = optionalNumber(settings[key]);
      if (value === null) throw new Error(`${name} reads command ${params.command_name}, which is missing ${key}`);
      return value;
    };
    return {
      name: 'AsimovGaitClock',
      order: 'sin_cos',
      zero_at_rest: true,
      period_slow: period('period_slow'),
      period_fast: period('period_fast'),
      speed_slow: period('speed_slow'),
      speed_fast: period('speed_fast'),
      stand_threshold: optionalNumber(settings.stand_threshold) ?? 0.1,
    };
  }
  throw new Error(`${name} reads command ${params.command_name ?? '(unnamed)'} of type ${classType || 'unknown'}`);
}

// The policy's observation recipe, read from observations.policy: one viewer
// observation per term, in order, with the term's history stacked the way
// Isaac Lab and mjlab flatten it (term by term, oldest first). Returns
// { obs_config } when every term maps to something the viewer computes,
// { obs_config_error } naming the terms that do not, and null when env.yaml
// has no observations.policy (the reference recipe is used then).
function policyObsConfigFor(lines, jointNames) {
  const group = block(lines, ['observations', 'policy']);
  if (!group?.length) return null;
  const groupSettings = directFields(group);
  // mjlab nests the terms under `terms:`; Isaac Lab lists them in the group.
  const terms = mapEntries(block(group, ['terms']) ?? group);
  const groupHistory = optionalNumber(groupSettings.history_length);

  const policy = [];
  const problems = [];
  for (const [name, termLines] of terms) {
    const settings = directFields(termLines);
    if (!('func' in settings)) continue;
    const params = directFields(block(termLines, ['params']));
    const kind = obsKind(name, settings.func, params);
    try {
      if (!kind) throw new Error(`${name} (${settings.func}) is not something the viewer computes`);
      if (isSet(termLines, 'clip')) throw new Error(`${name} is clipped, which the viewer does not do`);
      if (isSet(termLines, 'modifiers')) throw new Error(`${name} has modifiers, which the viewer does not apply`);
      const entry = obsEntryFor(name, termLines, kind, optionalNumber(settings.scale), lines, jointNames);
      const history = groupHistory ?? optionalNumber(settings.history_length) ?? 0;
      const flatten = groupSettings.flatten_history_dim ?? settings.flatten_history_dim;
      if (history > 1 && flatten === 'false') throw new Error(`${name} keeps its history unflattened`);
      policy.push(history > 1 ? { ...entry, history_length: history } : entry);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length) return { obs_config_error: `env.yaml's policy observations cannot be reproduced: ${problems.join('; ')}` };
  return policy.length ? { obs_config: { policy } } : null;
}

// A YAML float, .inf and -.inf included; null when the text is not one.
function yamlFloat(text) {
  const infinity = text.match(/^([-+]?)\.inf$/i);
  if (infinity) return infinity[1] === '-' ? -Infinity : Infinity;
  const number = Number(text);
  return text === '' || Number.isNaN(number) ? null : number;
}

// actions.joint_pos.clip: Isaac Lab's { joint pattern: (min, max) } bounds on
// the joint position target, which JointAction.process_actions applies after
// scale and offset. Resolved like Isaac Lab's resolve_matching_names_values: a
// pattern applies to every joint it fully matches, a joint no pattern matches
// is not clipped, and a joint two patterns match or a pattern that matches no
// joint is an error (Isaac Lab raises on both). Returns one [min, max] per joint
// in jointNames order, or null when the actions are not clipped. Throws when
// the clip cannot be applied as in training.
function actionClipFor(action, jointNames) {
  if (!isSet(action, 'clip')) return null;
  const cannot = (reason) => new Error(`its actions.joint_pos.clip cannot be applied: ${reason}`);
  const lines = block(action, ['clip']);
  if (!lines?.length) throw cannot('expected a block of "<joint pattern>: (min, max)" entries');
  const indent = Math.min(...lines.map((line) => line.indent));
  const clip = jointNames.map(() => [-Infinity, Infinity]);
  const matchedBy = jointNames.map(() => null);
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (end < lines.length && (lines[end].indent > indent || lines[end].text.startsWith('- '))) end++;
    const entry = lines[i].text.match(/^(.+?):(?:\s+(.*))?$/);
    if (lines[i].text.startsWith('- ') || !entry) throw cannot('expected a block of "<joint pattern>: (min, max)" entries');
    const [, pattern, rest = ''] = entry;
    // A tuple is written `!!python/tuple` and then one `- value` line per item; a list may be inline.
    const value = rest.replace(/^!!python\/tuple\b\s*/, '');
    const following = lines.slice(i + 1, end);
    let items = null;
    if (value === '' && following.every((line) => line.text.startsWith('- '))) {
      items = following.map((line) => line.text.slice(2).trim());
    } else if (/^\[.*\]$/.test(value) && !following.length) {
      items = value.slice(1, -1).split(',').map((item) => item.trim());
    }
    const range = items?.map(yamlFloat);
    if (range?.length !== 2 || range.includes(null)) throw cannot(`${pattern} is not a (min, max) pair of numbers`);
    let regex;
    try { regex = new RegExp(`^(?:${pattern})$`); } catch { throw cannot(`${pattern} is not a valid joint pattern`); }
    let matched = false;
    jointNames.forEach((joint, j) => {
      if (!regex.test(joint)) return;
      if (matchedBy[j] !== null) throw cannot(`${joint} is matched by both ${matchedBy[j]} and ${pattern}`);
      matchedBy[j] = pattern;
      clip[j] = range;
      matched = true;
    });
    if (!matched) throw cannot(`${pattern} matches none of the policy's joints`);
    i = end;
  }
  return clip;
}

// The joints the policy's actions drive: actions.joint_pos.joint_names resolved
// against the viewer's joints as Isaac Lab's resolve_matching_names resolves
// them against the robot's. A pattern applies to every joint it fully matches;
// a joint two patterns match, or a pattern that matches no joint, is an error
// (Isaac Lab raises on both). Returns { indices } into jointNames, in the
// viewer's joint order, with `errors`, the `patterns` themselves and, per
// joint, the pattern that matched it (`matchedBy`). When
// env.yaml does not list them (e.g. an mjlab layout), the actions drive every
// joint, as before.
function actionJointsFor(action, jointNames) {
  const patterns = listAfter(action, 'joint_names');
  if (!patterns.length) return { indices: jointNames.map((_, i) => i), patterns, errors: [] };
  const errors = [];
  const matchedBy = jointNames.map(() => null);
  for (const pattern of patterns) {
    let regex;
    try { regex = new RegExp(`^(?:${pattern})$`); } catch {
      errors.push(`its actions.joint_pos.joint_names has an invalid joint pattern: ${pattern}`);
      continue;
    }
    let matched = false;
    jointNames.forEach((joint, j) => {
      if (!regex.test(joint)) return;
      matched = true;
      if (matchedBy[j] === null) matchedBy[j] = pattern;
      else errors.push(`its actions.joint_pos.joint_names match ${joint} with both ${matchedBy[j]} and ${pattern}`);
    });
    if (!matched) errors.push(`its actions.joint_pos.joint_names drive ${pattern}, which matches none of the viewer's robot joints`);
  }
  const indices = jointNames.flatMap((_, j) => (matchedBy[j] === null ? [] : [j]));
  return { indices, patterns, matchedBy, errors };
}

// The policy period the viewer runs every policy at (main.js, mujocoUtils.js and
// Demo.vue step it at 50 Hz).
const POLICY_PERIOD_S = 0.02;

// Where training drove the robot differently than the viewer would: another
// policy rate, or actions sent to the joints in another order or without the
// default offset. The policy would load and run, but every action would land at
// the wrong time or on the wrong joint. Settings env.yaml does not record (e.g.
// an mjlab layout's sim.dt or action joints) are not checked. A clip on the
// actions is applied (actionClipFor) rather than refused. The viewer sends the
// actions to the action joints (actionJointsFor) in its own joint order.
function controlErrorsFor(lines, action, jointNames, actionJoints) {
  const errors = [];
  const dt = optionalNumber(directFields(block(lines, ['sim']) ?? []).dt);
  const decimation = optionalNumber(fields(lines, 0).decimation);
  if (dt !== null && decimation !== null && Math.abs(dt * decimation - POLICY_PERIOD_S) > 1e-9) {
    errors.push(`it ran every ${+(dt * decimation).toFixed(6)} s in training (sim.dt ${dt} x decimation ${decimation}), but the viewer runs it every ${POLICY_PERIOD_S} s`);
  }
  const settings = directFields(action);
  const { patterns, indices, matchedBy } = actionJoints;
  const driven = indices.map((i) => jointNames[i]);
  const outOfOrder = (trained) => {
    const first = driven.findIndex((joint, i) => trained[i] !== joint);
    return first < 0 ? null : `its actions.joint_pos.joint_names are in another order: action ${first + 1} drove ${trained[first] ?? 'no joint'} in training, but drives ${driven[first]} in the viewer`;
  };
  errors.push(...actionJoints.errors);
  if (patterns.length > 0 && patterns.every((joint) => jointNames.includes(joint))) {
    // Joint names: the order training sent the actions in is the list's.
    if (patterns.length > 1 && settings.preserve_order !== 'true') {
      errors.push('its actions.joint_pos does not set preserve_order, so training sent the actions in the robot asset\'s joint order, which the viewer cannot see');
    } else {
      const error = outOfOrder(patterns);
      if (error) errors.push(error);
    }
  } else if (indices.length < jointNames.length && settings.preserve_order === 'true') {
    // Patterns for some of the joints: Isaac Lab orders the actions pattern by
    // pattern. Within one pattern, and for patterns that drive every joint
    // (such as `.*`), the order follows the robot asset, which the viewer
    // cannot see, so it is taken to be the viewer's.
    const trained = patterns.flatMap((pattern) => driven.filter((joint) => matchedBy[jointNames.indexOf(joint)] === pattern));
    const error = outOfOrder(trained);
    if (error) errors.push(error);
  }
  if (settings.use_default_offset === 'false') {
    errors.push('its actions were not added to the default pose in training (actions.joint_pos.use_default_offset: false), but the viewer adds them');
  }
  return errors;
}

export function parseEnvPolicySettings(yaml, jointNames) {
  const lines = linesOf(yaml);
  const isaac = block(lines, ['scene', 'robot', 'actuators']);
  const mjlab = !isaac && block(lines, ['scene', 'entities', 'robot', 'articulation', 'actuators']);
  const initState = isaac
    ? block(lines, ['scene', 'robot', 'init_state'])
    : block(lines, ['scene', 'entities', 'robot', 'init_state']);
  const pose = initState && block(initState, ['joint_pos']);
  const action = block(lines, ['actions', 'joint_pos']);
  if (!pose || !action || (!isaac && !mjlab)) throw new Error('env.yaml is missing robot joint pose, actuators, or joint position action');

  const actuators = isaac ? isaacActuators(isaac) : mjlabActuators(mjlab);
  const matchOneActuator = (name) => {
    const matching = actuators.filter(({ pattern }) => {
      try { return new RegExp(`^(?:${pattern})$`).test(name); }
      catch { throw new Error(`Invalid actuator joint pattern in env.yaml: ${pattern}`); }
    });
    if (matching.length !== 1) throw new Error(`Expected one actuator for ${name} in env.yaml; found ${matching.length}`);
    const actuator = { ...matching[0] };
    for (const key of ['stiffness', 'damping', 'effort_limit']) {
      if (actuator[key] && typeof actuator[key] === 'object') {
        actuator[key] = String(matchValue(Object.entries(actuator[key]), name, key));
      }
    }
    return actuator;
  };
  const gainFor = (name, key) => scalar(matchOneActuator(name)[key]);

  // A policy may drive only some of the robot's joints (e.g. the legs). The
  // action settings are for those joints; every joint, the ones the policy does
  // not drive included, gets its default pose, gains and torque limit, since
  // the viewer holds those at the default pose (policyRunner.js).
  const actionJoints = actionJointsFor(action, jointNames);
  const actionJointNames = actionJoints.indices.map((i) => jointNames[i]);

  const scaleLine = action.find((line) => line.text.startsWith('scale:') && line.indent === Math.min(...action.map((item) => item.indent)));
  if (!scaleLine) throw new Error('env.yaml is missing actions.joint_pos.scale');
  const scaleText = scaleLine.text.slice('scale:'.length).trim();
  let actionScale;
  if (scaleText) {
    actionScale = actionJointNames.map(() => scalar(scaleText));
  } else {
    const index = action.indexOf(scaleLine);
    let end = index + 1;
    while (end < action.length && action[end].indent > scaleLine.indent) end++;
    actionScale = valuesForJoints(directFields(action.slice(index + 1, end)), actionJointNames, 'action scale');
  }

  const defaultJointPos = valuesForJoints(directFields(pose), jointNames, 'default pose');
  // One delay for the whole target; it only matters on the joints the policy moves.
  const delay = delayForJoints(actuators, actionJointNames, matchOneActuator);
  const commandRanges = commandRangesFor(lines);
  const torqueLimit = torqueLimitsFor(jointNames, matchOneActuator);
  const controlErrors = controlErrorsFor(lines, action, jointNames, actionJoints);
  let targetClip = null;
  try {
    // Isaac Lab resolves the clip against the action term's joints.
    targetClip = actionClipFor(action, actionJointNames);
  } catch (error) {
    controlErrors.push(error.message);
  }
  // None at all only with control errors, which refuse the policy anyway.
  const someJoints = actionJoints.indices.length > 0 && actionJoints.indices.length < jointNames.length;

  return {
    ...(torqueLimit ? { torque_limit: torqueLimit } : {}),
    ...(someJoints ? { action_joint_indices: actionJoints.indices } : {}),
    action_scale: actionScale,
    stiffness: jointNames.map((name) => gainFor(name, 'stiffness')),
    damping: jointNames.map((name) => gainFor(name, 'damping')),
    default_joint_pos: defaultJointPos,
    init_state: { ...initStateFor(initState, jointNames), joint_pos: defaultJointPos },
    ...(delay ?? {}),
    ...(commandRanges ?? {}),
    ...(targetClip ? { target_clip: targetClip } : {}),
    ...(policyObsConfigFor(lines, jointNames) ?? {}),
    ...(controlErrors.length ? { control_errors: controlErrors } : {}),
  };
}

// Folder holding a policy's training files: <root>/<policy> for a
// /policy-library/ path (the ONNX may sit deeper), or <root> itself when the ONNX
// sits directly in it (as with a folder run by `npm run hf <folder>`); otherwise
// the folder the ONNX itself is in (e.g. a policy bundled under examples/).
function policyDirUrl(onnxPath) {
  if (!onnxPath) return null;
  if (onnxPath.startsWith('/policy-library/')) {
    const parts = onnxPath.slice('/policy-library/'.length).split('/');
    if (parts.length < 2) return null;
    return `/policy-library/${parts.slice(0, parts.length === 2 ? 1 : 2).join('/')}`;
  }
  const slash = onnxPath.lastIndexOf('/');
  return slash < 0 ? null : onnxPath.slice(0, slash);
}

// A policy may ship its own tracking_policy.json (params/ or policy root) to
// override parts of the shared base policy config. Recurrent policies do not
// need one: their state is read off the ONNX graph (policyState.js). Returns
// the parsed JSON, or null when the policy has none (the common case: the
// base config applies as-is).
export async function loadOwnPolicyConfig(onnxPath) {
  const policyUrl = policyDirUrl(onnxPath);
  if (!policyUrl) return null;
  for (const filename of policyFileCandidates('tracking_policy.json')) {
    const url = `${policyUrl}/${filename}`;
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    // Static SPA hosts may answer a missing asset request with index.html.
    if (response.headers.get('content-type')?.includes('text/html')) continue;
    return await response.json();
  }
  return null;
}

export async function loadEnvPolicySettings(onnxPath, jointNames) {
  const policyUrl = policyDirUrl(onnxPath);
  if (!policyUrl) return null;
  for (const filename of policyFileCandidates('env.yaml')) {
    const url = `${policyUrl}/${filename}`;
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    // Static SPA hosts may answer a missing asset request with index.html.
    if (response.headers.get('content-type')?.includes('text/html')) continue;
    return parseEnvPolicySettings(await response.text(), jointNames);
  }
  // This policy ships no env.yaml at all — the caller (mujocoUtils.js
  // reloadPolicy) will silently keep whatever
  // stiffness/damping/action_scale/default_joint_pos were already in the
  // reference config. That's the exact shared-gains bug this file
  // exists to prevent (every policy scored with the same gains), so it's not allowed to
  // pass without a trace even though we still return null rather than throw
  // — throwing here would make an otherwise-loadable policy (e.g. one
  // still mid-export) unviewable in the interactive demo.
  // A bundled policy (e.g. upstream's tracking policies) legitimately has no
  // training env.yaml; only a policy-library policy is expected to.
  if (onnxPath.startsWith('/policy-library/')) {
    console.warn(`[envPolicyConfig] no env.yaml found for ${policyUrl} (checked params/env.yaml and env.yaml) — falling back to the reference config's gains for this policy`);
  }
  return null;
}
