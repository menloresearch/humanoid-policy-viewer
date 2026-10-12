// Terrain courses built from parameters. A benchmark test describes its course
// in its own row ({ type: 'stairs', step_height_m: 0.05, ... }); this module
// turns that into
//   - an MJCF fragment of static boxes, spliced into the robot scene by
//     terrainScene.js,
//   - heightAt(x, y): the ground height under a point, so a fall is judged by
//     the robot's height above the ground it stands on, not above world zero,
//   - bounds: the course's extent, for the spawn and path checks.
//
// Every course starts `start_m` in front of the spawn point and runs along +x,
// centred on y = 0. Course geoms never set a contact priority: the robot's foot
// geoms carry priority 1, so a test's foot_friction override wins on terrain
// exactly as on the floor.
//
// What a spec produces is part of BENCHMARK_PROTOCOL: changing the geometry a
// published spec builds moves every result on it. Random layouts (boxes, rough)
// come from the spec's own seed (hashed, then mulberry32), never from Math.random.

import { hashSeed, mulberry32 } from '../benchmark/rng.js';

const COMMON = {
  start_m: { default: 1.5, min: 0, max: 50, label: 'start (m ahead of the robot)' },
  width_m: { default: 6, min: 0.5, max: 20, label: 'width (m)' },
};

/** Course types, their parameters (with defaults and allowed ranges) and a description. */
export const TERRAIN_TYPES = {
  stairs: {
    label: 'stairs',
    description: 'steps up, a flat top, the same steps down',
    params: {
      ...COMMON,
      step_height_m: { default: 0.05, min: 0.005, max: 0.3, label: 'step height (m)' },
      steps: { default: 5, min: 1, max: 30, integer: true, label: 'steps each way' },
      tread_m: { default: 0.35, min: 0.1, max: 2, label: 'tread (m)' },
      top_m: { default: 1.5, min: 0, max: 20, label: 'top length (m)' },
    },
  },
  slope: {
    label: 'ramp',
    description: 'a ramp up, a flat top, a ramp down',
    params: {
      ...COMMON,
      angle_deg: { default: 10, min: 1, max: 35, label: 'angle (deg)' },
      height_m: { default: 0.3, min: 0.01, max: 2, label: 'height (m)' },
      top_m: { default: 1.5, min: 0, max: 20, label: 'top length (m)' },
    },
  },
  boxes: {
    label: 'scattered boxes',
    description: 'low boxes at random positions and angles across a lane',
    params: {
      ...COMMON,
      width_m: { default: 1.2, min: 0.5, max: 20, label: 'lane width (m)' },
      length_m: { default: 5.8, min: 0.5, max: 50, label: 'length (m)' },
      count: { default: 14, min: 1, max: 300, integer: true, label: 'boxes' },
      min_height_m: { default: 0.03, min: 0.005, max: 0.3, label: 'min height (m)' },
      max_height_m: { default: 0.07, min: 0.005, max: 0.3, label: 'max height (m)' },
      min_size_m: { default: 0.2, min: 0.05, max: 2, label: 'min footprint (m)' },
      max_size_m: { default: 0.4, min: 0.05, max: 2, label: 'max footprint (m)' },
      seed: { default: 7, min: 0, max: 2 ** 31 - 1, integer: true, label: 'layout seed' },
    },
  },
  rough: {
    label: 'rough tiles',
    description: 'square tiles of random heights',
    params: {
      ...COMMON,
      length_m: { default: 6.3, min: 0.3, max: 50, label: 'length (m)' },
      tile_m: { default: 0.3, min: 0.05, max: 2, label: 'tile size (m)' },
      min_height_m: { default: 0.005, min: 0.001, max: 0.3, label: 'min height (m)' },
      max_height_m: { default: 0.04, min: 0.001, max: 0.3, label: 'max height (m)' },
      seed: { default: 11, min: 0, max: 2 ** 31 - 1, integer: true, label: 'layout seed' },
    },
  },
};

const MAX_GEOMS = 2500;

/** A complete spec of `type` with every parameter at its default. */
export function defaultTerrain(type) {
  const def = TERRAIN_TYPES[type];
  if (!def) throw new Error(`unknown terrain type "${type}"`);
  return { type, ...Object.fromEntries(Object.entries(def.params).map(([key, p]) => [key, p.default])) };
}

/** Problems with a spec (empty = valid). A spec must name every parameter of its type and nothing else. */
export function validateTerrain(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['must be an object like { "type": "stairs", ... }'];
  const def = TERRAIN_TYPES[spec.type];
  if (!def) return [`type must be one of ${Object.keys(TERRAIN_TYPES).join(', ')}`];
  const errors = [];
  for (const key of Object.keys(spec)) if (key !== 'type' && !def.params[key]) errors.push(`${spec.type} has no parameter "${key}"`);
  for (const [key, p] of Object.entries(def.params)) {
    const value = spec[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${key} is required (a number)`);
    else if (p.integer && !Number.isInteger(value)) errors.push(`${key} must be a whole number`);
    else if (value < p.min || value > p.max) errors.push(`${key} must be between ${p.min} and ${p.max}`);
  }
  if (errors.length) return errors;
  if ('min_height_m' in def.params && spec.min_height_m > spec.max_height_m) errors.push('min_height_m must not exceed max_height_m');
  if ('min_size_m' in def.params && spec.min_size_m > spec.max_size_m) errors.push('min_size_m must not exceed max_size_m');
  if (spec.type === 'rough') {
    const [nx, ny] = roughTileCounts(spec);
    if (nx < 1 || ny < 1) errors.push('tile_m is bigger than the patch, so there are no tiles; use smaller tiles or a bigger patch');
    else if (nx * ny > MAX_GEOMS) errors.push(`more than ${MAX_GEOMS} tiles; use bigger tiles or a smaller patch`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// geometry: every course is a list of boxes { name, pos, size (half extents), euler? }

function stairsBoxes(s) {
  const end = s.start_m + 2 * s.steps * s.tread_m + s.top_m;
  const boxes = [];
  for (let i = 1; i <= s.steps; i++) {
    const lo = s.start_m + (i - 1) * s.tread_m;
    const hi = end - (i - 1) * s.tread_m;
    boxes.push({ name: `stair${i}`, pos: [(lo + hi) / 2, 0, (i - 0.5) * s.step_height_m], size: [(hi - lo) / 2, s.width_m / 2, s.step_height_m / 2] });
  }
  return boxes;
}

const RAMP_THICK_M = 0.2;

function slopeBoxes(s) {
  const th = (s.angle_deg * Math.PI) / 180;
  const run = s.height_m / Math.tan(th);
  const halfLen = Math.hypot(run, s.height_m) / 2;
  const boxes = [[s.start_m + run / 2, 1], [s.start_m + run + s.top_m + run / 2, -1]].map(([xMid, sign], k) => ({
    // the centre sits half a thickness below the sloped top surface
    name: `ramp${k}`,
    pos: [xMid + sign * (RAMP_THICK_M / 2) * Math.sin(th), 0, s.height_m / 2 - (RAMP_THICK_M / 2) * Math.cos(th)],
    size: [halfLen, s.width_m / 2, RAMP_THICK_M / 2],
    euler: [0, -sign * th, 0],
  }));
  if (s.top_m > 0) {
    boxes.push({ name: 'ramp_top', pos: [s.start_m + run + s.top_m / 2, 0, s.height_m / 2], size: [s.top_m / 2 + 0.02, s.width_m / 2, s.height_m / 2] });
  }
  return boxes;
}

function boxesBoxes(s) {
  const random = mulberry32(hashSeed('terrain', s.type, s.seed));
  const uniform = (lo, hi) => lo + (hi - lo) * random();
  const boxes = [];
  for (let i = 0; i < s.count; i++) {
    const hx = uniform(s.min_size_m, s.max_size_m) / 2;
    const hy = uniform(s.min_size_m, s.max_size_m) / 2;
    const h = uniform(s.min_height_m, s.max_height_m);
    const cx = uniform(s.start_m + s.max_size_m, s.start_m + s.length_m);
    const cy = uniform(-s.width_m / 2, s.width_m / 2);
    boxes.push({ name: `box${i}`, pos: [cx, cy, h / 2], size: [hx, hy, h / 2], euler: [0, 0, uniform(0, Math.PI)] });
  }
  return boxes;
}

function roughTileCounts(s) {
  return [Math.round(s.length_m / s.tile_m), Math.round(s.width_m / s.tile_m)];
}

function roughBoxes(s) {
  const random = mulberry32(hashSeed('terrain', s.type, s.seed));
  const [nx, ny] = roughTileCounts(s);
  const boxes = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const h = s.min_height_m + (s.max_height_m - s.min_height_m) * random();
      boxes.push({
        name: `tile${i}_${j}`,
        pos: [s.start_m + (i + 0.5) * s.tile_m, -s.width_m / 2 + (j + 0.5) * s.tile_m, h / 2],
        size: [s.tile_m / 2, s.tile_m / 2, h / 2],
      });
    }
  }
  return boxes;
}

const BUILDERS = { stairs: stairsBoxes, slope: slopeBoxes, boxes: boxesBoxes, rough: roughBoxes };

// Rotation of a box's local frame (MuJoCo euler, default sequence xyz).
function rotate([x, y, z], [a = 0, b = 0, c = 0] = []) {
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  return [x, y, z];
}

function corners(box) {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const [x, y, z] = rotate([sx * box.size[0], sy * box.size[1], sz * box.size[2]], box.euler);
    out.push([box.pos[0] + x, box.pos[1] + y, box.pos[2] + z]);
  }
  return out;
}

/** A box's top face seen from above: four [x, y] corners, for drawing a course. */
export function boxOutline(box) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const [x, y] = rotate([sx * box.size[0], sy * box.size[1], box.size[2]], box.euler);
    return [box.pos[0] + x, box.pos[1] + y];
  });
}

/** Height of a box's top surface at (x, y), or null when (x, y) is outside it. */
function topAt(box, x, y) {
  const [, pitch = 0, yaw = 0] = box.euler ?? [];
  // local coordinates of the point (yaw about z, then pitch about y)
  const dx = x - box.pos[0];
  const dy = y - box.pos[1];
  const lx = dx * Math.cos(-yaw) - dy * Math.sin(-yaw);
  const ly = dx * Math.sin(-yaw) + dy * Math.cos(-yaw);
  if (Math.abs(ly) > box.size[1]) return null;
  // the top face is the plane through the rotated (0, 0, +h) offset, tilted by pitch
  const along = (lx - box.size[2] * Math.sin(pitch)) / Math.cos(pitch);
  if (Math.abs(along) > box.size[0]) return null;
  return box.pos[2] + box.size[2] / Math.cos(pitch) - lx * Math.tan(pitch);
}

const f4 = (v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
const f5 = (v) => (Math.abs(v) < 5e-6 ? 0 : v).toFixed(5);
const MATERIAL = '<material name="terrain" rgba="0.55 0.5 0.42 1"/>';

function geomXml(box) {
  const euler = box.euler ? ` euler="${box.euler.map(f5).join(' ')}"` : '';
  return `    <geom name="${box.name}" type="box" pos="${box.pos.map(f4).join(' ')}" size="${box.size.map(f4).join(' ')}"${euler}`
    + ' material="terrain" contype="1" conaffinity="1" condim="3" friction="1.0 0.5 0.1"/>';
}

/** Short stable name for a spec (used for the generated scene file). */
export function terrainKey(spec) {
  const text = JSON.stringify(Object.keys(spec).sort().map((key) => [key, spec[key]]));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${spec.type}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Builds a validated spec: { boxes, xml, heightAt(x, y), bounds }. Throws on an
 * invalid spec, listing every problem.
 */
export function buildTerrain(spec) {
  const errors = validateTerrain(spec);
  if (errors.length) throw new Error(`invalid terrain: ${errors.join('; ')}`);
  const boxes = BUILDERS[spec.type](spec);
  const points = boxes.flatMap(corners);
  const bounds = {
    xmin: Math.min(...points.map((p) => p[0])),
    xmax: Math.max(...points.map((p) => p[0])),
    ymin: Math.min(...points.map((p) => p[1])),
    ymax: Math.max(...points.map((p) => p[1])),
    zmax: Math.max(...points.map((p) => p[2])),
  };
  const xml = `<mujoco model="terrain ${terrainKey(spec)}">\n`
    + `  <!-- ${TERRAIN_TYPES[spec.type].label}: ${JSON.stringify(spec)} (src/simulation/terrainGen.js) -->\n`
    + `  <asset>\n    ${MATERIAL}\n  </asset>\n`
    + `  <worldbody>\n${boxes.map(geomXml).join('\n')}\n  </worldbody>\n</mujoco>\n`;
  const heightAt = (x, y) => {
    if (x < bounds.xmin || x > bounds.xmax || y < bounds.ymin || y > bounds.ymax) return 0;
    let h = 0;
    for (const box of boxes) {
      const top = topAt(box, x, y);
      if (top !== null && top > h) h = top;
    }
    return h;
  };
  return { boxes, xml, heightAt, bounds };
}
