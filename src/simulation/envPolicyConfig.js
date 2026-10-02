// Read the small, stable subset of Isaac Lab / mjlab env.yaml that defines
// joint position actions. The files contain Python-specific YAML tags, so
// traversing the relevant indented blocks avoids interpreting those tags.

// Isaac Lab/mjlab exports commonly place a checkpoint's config files (env.yaml,
// agent.yaml, tracking_policy.json, ...) under params/, but some checkpoints
// keep them at the model root instead. Every caller that resolves one of these
// per-checkpoint files checks params/<name> before falling back to <name>.
export function checkpointFileCandidates(filename) {
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

function isaacActuators(lines) {
  const entries = [];
  const indent = Math.min(...lines.map((line) => line.indent));
  for (let i = 0; i < lines.length;) {
    if (lines[i].indent !== indent || !lines[i].text.endsWith(':')) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && lines[end].indent > indent) end++;
    const item = lines.slice(i + 1, end);
    const config = fields(item, indent + 2);
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
    const config = fields(item, indent + 2);
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

// The command range a checkpoint was actually trained against (the RL command
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

export function parseEnvPolicySettings(yaml, jointNames) {
  const lines = linesOf(yaml);
  const isaac = block(lines, ['scene', 'robot', 'actuators']);
  const mjlab = !isaac && block(lines, ['scene', 'entities', 'robot', 'articulation', 'actuators']);
  const pose = isaac
    ? block(lines, ['scene', 'robot', 'init_state', 'joint_pos'])
    : block(lines, ['scene', 'entities', 'robot', 'init_state', 'joint_pos']);
  const action = block(lines, ['actions', 'joint_pos']);
  if (!pose || !action || (!isaac && !mjlab)) throw new Error('env.yaml is missing robot joint pose, actuators, or joint position action');

  const actuators = isaac ? isaacActuators(isaac) : mjlabActuators(mjlab);
  const matchOneActuator = (name) => {
    const matching = actuators.filter(({ pattern }) => {
      try { return new RegExp(`^(?:${pattern})$`).test(name); }
      catch { throw new Error(`Invalid actuator joint pattern in env.yaml: ${pattern}`); }
    });
    if (matching.length !== 1) throw new Error(`Expected one actuator for ${name} in env.yaml; found ${matching.length}`);
    return matching[0];
  };
  const gainFor = (name, key) => scalar(matchOneActuator(name)[key]);

  const scaleLine = action.find((line) => line.text.startsWith('scale:') && line.indent === Math.min(...action.map((item) => item.indent)));
  if (!scaleLine) throw new Error('env.yaml is missing actions.joint_pos.scale');
  const scaleText = scaleLine.text.slice('scale:'.length).trim();
  let actionScale;
  if (scaleText) {
    actionScale = jointNames.map(() => scalar(scaleText));
  } else {
    const index = action.indexOf(scaleLine);
    let end = index + 1;
    while (end < action.length && action[end].indent > scaleLine.indent) end++;
    actionScale = valuesForJoints(directFields(action.slice(index + 1, end)), jointNames, 'action scale');
  }

  const delay = delayForJoints(actuators, jointNames, matchOneActuator);
  const commandRanges = commandRangesFor(lines);
  const torqueLimit = torqueLimitsFor(jointNames, matchOneActuator);

  return {
    ...(torqueLimit ? { torque_limit: torqueLimit } : {}),
    action_scale: actionScale,
    stiffness: jointNames.map((name) => gainFor(name, 'stiffness')),
    damping: jointNames.map((name) => gainFor(name, 'damping')),
    default_joint_pos: valuesForJoints(directFields(pose), jointNames, 'default pose'),
    ...(delay ?? {}),
    ...(commandRanges ?? {}),
  };
}

// Folder holding a checkpoint's training files: <root>/<model> for a
// /model-library/ path (the ONNX may sit deeper), or <root> itself when the ONNX
// sits directly in it (as with a folder run by `npm run hf <folder>`); otherwise
// the folder the ONNX itself is in (e.g. a checkpoint bundled under examples/).
function checkpointDirUrl(onnxPath) {
  if (!onnxPath) return null;
  if (onnxPath.startsWith('/model-library/')) {
    const parts = onnxPath.slice('/model-library/'.length).split('/');
    if (parts.length < 2) return null;
    return `/model-library/${parts.slice(0, parts.length === 2 ? 1 : 2).join('/')}`;
  }
  const slash = onnxPath.lastIndexOf('/');
  return slash < 0 ? null : onnxPath.slice(0, slash);
}

export async function loadEnvPolicySettings(onnxPath, jointNames) {
  const modelUrl = checkpointDirUrl(onnxPath);
  if (!modelUrl) return null;
  for (const filename of checkpointFileCandidates('env.yaml')) {
    const url = `${modelUrl}/${filename}`;
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    // Static SPA hosts may answer a missing asset request with index.html.
    if (response.headers.get('content-type')?.includes('text/html')) continue;
    return parseEnvPolicySettings(await response.text(), jointNames);
  }
  // This checkpoint ships no env.yaml at all — the caller (mujocoUtils.js
  // reloadPolicy) will silently keep whatever
  // stiffness/damping/action_scale/default_joint_pos were already in the
  // reference config. That's the exact shared-gains bug this file
  // exists to prevent (see benchmark/METHODOLOGY.md), so it's not allowed to
  // pass without a trace even though we still return null rather than throw
  // — throwing here would make an otherwise-loadable checkpoint (e.g. one
  // still mid-export) unviewable in the interactive demo.
  // A bundled policy (e.g. upstream's tracking policies) legitimately has no
  // training env.yaml; only a model-library checkpoint is expected to.
  if (onnxPath.startsWith('/model-library/')) {
    console.warn(`[envPolicyConfig] no env.yaml found for ${modelUrl} (checked params/env.yaml and env.yaml) — falling back to the reference config's gains for this checkpoint`);
  }
  return null;
}
