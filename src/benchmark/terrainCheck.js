// Checks a test's terrain against where the robot starts and where its
// commands send it. Used before a benchmark runs (scripts/benchmarkCheck.mjs) and
// live in the trajectory editor.
//
//   error:   the course overlaps the spawn area, so the robot would start
//            inside or on top of it (it always spawns at the origin, facing +x)
//   warning: the commanded path never reaches the course, or leaves it
//            sideways, so the test may mostly run on flat ground. The path is
//            the commands integrated exactly (held between keypoints), not
//            what a policy will actually walk.

import { buildTerrain } from '../simulation/terrainGen.js';

// Half-size of the square around the origin no course may touch: the robot's
// feet and a fall's first step stay inside it.
export const SPAWN_CLEAR_M = 0.5;
const DT = 0.02;

/** The commanded path from the origin, heading +x: [{ t, x, y }] every DT. */
export function commandedPath(sequence) {
  const commands = [...(sequence?.commands ?? [])].sort((a, b) => a.t - b.t);
  const duration = Number(sequence?.duration) || 0;
  const path = [{ t: 0, x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  let heading = 0;
  let index = -1;
  for (let t = 0; t < duration - 1e-9; t += DT) {
    while (index + 1 < commands.length && commands[index + 1].t <= t + 1e-9) index++;
    const cmd = index >= 0 ? commands[index] : { vx: 0, vy: 0, wz: 0 };
    heading += (cmd.wz || 0) * DT;
    x += ((cmd.vx || 0) * Math.cos(heading) - (cmd.vy || 0) * Math.sin(heading)) * DT;
    y += ((cmd.vx || 0) * Math.sin(heading) + (cmd.vy || 0) * Math.cos(heading)) * DT;
    path.push({ t: Math.round((t + DT) * 1000) / 1000, x, y });
  }
  return path;
}

/**
 * Where the commands leave the robot: the last point of commandedPath, in metres
 * to 2 decimals (the precision of an end zone). The natural centre for a goal;
 * it is the commanded path, not what a policy will actually walk.
 */
export function commandedEnd(sequence) {
  const path = commandedPath(sequence);
  const { x, y } = path[path.length - 1];
  return { x: roundGoal(x), y: roundGoal(y) };
}

/**
 * Warnings about a test's end zone: one if even perfectly tracked commands never
 * enter it, so no policy could reach it.
 */
export function goalProblems(sequence) {
  const goal = sequence?.goal;
  if (!goal) return [];
  const path = commandedPath(sequence);
  if (path.some((p) => (p.x - goal.x) ** 2 + (p.y - goal.y) ** 2 <= goal.radius_m ** 2)) return [];
  const end = commandedEnd(sequence);
  return [`the commanded path never enters the end zone (${goal.x}, ${goal.y}, radius ${goal.radius_m} m); the commands end at (${end.x}, ${end.y})`];
}

/** Goal positions are kept to 2 decimals (1 cm). */
export function roundGoal(value) {
  return Math.round(value * 100) / 100 + 0; // + 0 turns -0 into 0
}

/**
 * { errors, warnings, terrain, path } for a sequence ({ duration, commands,
 * terrain }); terrain is the built course (null when there is none or the spec
 * is invalid; validateTerrain reports that).
 */
export function terrainProblems(sequence) {
  const errors = [];
  const warnings = [];
  if (!sequence?.terrain) return { errors, warnings, terrain: null, path: commandedPath(sequence) };
  let terrain;
  try {
    terrain = buildTerrain(sequence.terrain);
  } catch (error) {
    return { errors: [error.message], warnings, terrain: null, path: commandedPath(sequence) };
  }
  const { xmin, xmax, ymin, ymax } = terrain.bounds;
  const r = (v) => v.toFixed(2);
  if (xmin < SPAWN_CLEAR_M && xmax > -SPAWN_CLEAR_M && ymin < SPAWN_CLEAR_M && ymax > -SPAWN_CLEAR_M) {
    errors.push(`the course reaches x = ${r(xmin)} m, inside the spawn area (|x|, |y| < ${SPAWN_CLEAR_M} m around the robot); `
      + `move start_m further out`);
  }
  const path = commandedPath(sequence);
  const onCourseX = path.filter((p) => p.x >= xmin && p.x <= xmax);
  if (!onCourseX.length) {
    const end = path[path.length - 1];
    warnings.push(`the commanded path never reaches the course (x ${r(xmin)}-${r(xmax)} m); it ends at x = ${r(end.x)}, y = ${r(end.y)}`);
  } else {
    const off = onCourseX.find((p) => p.y < ymin || p.y > ymax);
    if (off) warnings.push(`the commanded path leaves the course sideways at t = ${off.t} s (y = ${r(off.y)} m, course y ${r(ymin)} to ${r(ymax)})`);
  }
  return { errors, warnings, terrain, path };
}
