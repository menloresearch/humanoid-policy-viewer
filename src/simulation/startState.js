// The robot's state when a run starts, written the way Isaac Lab / mjlab write
// a robot's init_state in env.yaml:
//   { pos: [x, y, z], rot: [w, x, y, z], lin_vel: [3], ang_vel: [3],
//     joint_pos: { <joint name or regex>: rad }, joint_vel: { <joint name or regex>: rad/s } }
// The policy's own init_state (envPolicyConfig.js) is the base. A start
// override (a test's `start`, or a viewer preset) replaces the keys it gives;
// its joint_pos / joint_vel entries replace only the joints they match.
// Velocities are in the world frame, as in Isaac Lab.
//
// Drop and settle: before the policy takes over, the robot is left limp (no
// motor torque, light joint damping) for a while, so it comes to rest the way
// gravity puts it. The run's clock starts after it.

const VECTOR_KEYS = { pos: 3, rot: 4, lin_vel: 3, ang_vel: 3 };
const JOINT_KEYS = ['joint_pos', 'joint_vel'];

// A policy without an env.yaml starts here (the height the viewer always used).
export const FALLBACK_INIT_STATE = { pos: [0, 0, 0.614], rot: [1, 0, 0, 0], lin_vel: [0, 0, 0], ang_vel: [0, 0, 0] };

// Joint damping (N*m*s/rad) while the robot settles: limp, but not so free
// that joints swing for seconds.
export const SETTLE_JOINT_DAMPING = 0.5;
export const DEFAULT_SETTLE_S = 1;
export const MAX_SETTLE_S = 10;

// Lying on its back: pitched 90 degrees backwards about y, so the chest faces up,
// in the policy's default joint pose. In asimov_1.xml its lowest collision
// geom touches the floor at a base height of ~0.144 m, so it starts ~1.6 cm up.
const LYING_ON_BACK = { pos: [0, 0, 0.16], rot: [0.7071068, 0, -0.7071068, 0] };

/** The start poses offered in the viewer and the test editor. `start: null` is the policy's own init_state. */
export const START_PRESETS = [
  { value: 'standing', title: 'Standing', start: null },
  { value: 'lying_on_back', title: 'Lying on back', start: LYING_ON_BACK },
];

/** The preset `start` is, or 'custom' for a hand-written one. */
export function startPresetOf(start) {
  const preset = START_PRESETS.find((p) => JSON.stringify(p.start) === JSON.stringify(start ?? null));
  return preset ? preset.value : 'custom';
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Problems with a start override (empty = valid). Joint patterns are checked against the policy's joints when a run starts. */
export function validateStartState(start) {
  if (!start || typeof start !== 'object' || Array.isArray(start)) return ['must be an object like env.yaml\'s init_state'];
  const errors = [];
  for (const key of Object.keys(start)) {
    if (!(key in VECTOR_KEYS) && !JOINT_KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  }
  for (const [key, size] of Object.entries(VECTOR_KEYS)) {
    if (!(key in start)) continue;
    if (!Array.isArray(start[key]) || start[key].length !== size || !start[key].every(isNumber)) errors.push(`${key} must be ${size} numbers`);
  }
  if (Array.isArray(start.rot) && start.rot.every(isNumber) && Math.hypot(...start.rot) < 1e-6) errors.push('rot must not be all zeros');
  for (const key of JOINT_KEYS) {
    if (!(key in start)) continue;
    const map = start[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      errors.push(`${key} must map joint names (or patterns) to numbers`);
      continue;
    }
    for (const [pattern, value] of Object.entries(map)) {
      if (!isNumber(value)) errors.push(`${key}["${pattern}"] must be a number`);
      try { new RegExp(pattern); } catch { errors.push(`${key}: "${pattern}" is not a valid pattern`); }
    }
  }
  return errors;
}

/** Problems with a drop-and-settle duration (seconds; null = off). */
export function validateSettle(seconds) {
  if (seconds === null || seconds === undefined) return [];
  return isNumber(seconds) && seconds > 0 && seconds <= MAX_SETTLE_S ? [] : [`must be a number of seconds in (0, ${MAX_SETTLE_S}]`];
}

// The entry of `map` for joint `name`: an exact name wins, else the one
// pattern that matches. Null when nothing matches; throws when several do.
function jointEntry(map, name, key) {
  if (name in map) return name;
  const matches = Object.keys(map).filter((pattern) => new RegExp(`^(?:${pattern})$`).test(name));
  if (matches.length > 1) throw new Error(`start ${key}: ${matches.join(', ')} all match ${name}`);
  return matches[0] ?? null;
}

function jointValues(base, map, jointNames, key) {
  const out = Float64Array.from(base);
  if (!map) return out;
  const used = new Set();
  jointNames.forEach((name, i) => {
    const entry = jointEntry(map, name, key);
    if (entry === null) return;
    out[i] = map[entry];
    used.add(entry);
  });
  const unused = Object.keys(map).filter((pattern) => !used.has(pattern));
  if (unused.length) throw new Error(`start ${key}: ${unused.join(', ')} matches none of the policy's joints`);
  return out;
}

/**
 * The full start state for a run: `policyInit` (the policy's init_state,
 * joint values as arrays aligned with `jointNames`) with `override` applied.
 * Returns { pos, rot (unit), linVel, angVel, jointPos, jointVel }.
 */
export function resolveStartState(policyInit, override, jointNames) {
  const problems = override ? validateStartState(override) : [];
  if (problems.length) throw new Error(`Invalid start state: ${problems.join('; ')}`);
  const pick = (key) => (override?.[key] ?? policyInit?.[key] ?? FALLBACK_INIT_STATE[key]).slice();
  const rot = pick('rot');
  const norm = Math.hypot(...rot);
  const zeros = new Array(jointNames.length).fill(0);
  return {
    pos: pick('pos'),
    rot: rot.map((v) => v / norm),
    linVel: pick('lin_vel'),
    angVel: pick('ang_vel'),
    jointPos: jointValues(policyInit?.joint_pos ?? zeros, override?.joint_pos, jointNames, 'joint_pos'),
    jointVel: jointValues(policyInit?.joint_vel ?? zeros, override?.joint_vel, jointNames, 'joint_vel'),
  };
}

/** `v` (world frame) in the body frame of unit quaternion `q` = [w, x, y, z]. */
export function worldToBody(q, v) {
  const [w, x, y, z] = q;
  // Rotate by the conjugate: v' = v + 2 * (-u) x ((-u) x v + w v), with u = (x, y, z).
  const ux = -x, uy = -y, uz = -z;
  const tx = uy * v[2] - uz * v[1] + w * v[0];
  const ty = uz * v[0] - ux * v[2] + w * v[1];
  const tz = ux * v[1] - uy * v[0] + w * v[2];
  return [
    v[0] + 2 * (uy * tz - uz * ty),
    v[1] + 2 * (uz * tx - ux * tz),
    v[2] + 2 * (ux * ty - uy * tx),
  ];
}
