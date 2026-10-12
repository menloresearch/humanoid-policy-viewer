import assert from 'node:assert/strict';
import test from 'node:test';

import { TERRAIN_TYPES, buildTerrain, defaultTerrain, terrainKey, validateTerrain } from './terrainGen.js';
import { SPAWN_CLEAR_M, commandedEnd, commandedPath, goalProblems, roundGoal, terrainProblems } from '../benchmark/terrainCheck.js';
import { validateGoal } from '../benchmark/testRow.js';

test('every type builds from its defaults, without contact priority', () => {
  for (const type of Object.keys(TERRAIN_TYPES)) {
    const spec = defaultTerrain(type);
    assert.deepEqual(validateTerrain(spec), [], type);
    const { xml, bounds, boxes } = buildTerrain(spec);
    assert.ok(boxes.length > 0, type);
    assert.ok(!xml.includes('priority'), `${type}: the feet (priority 1) must win, so foot_friction applies on terrain`);
    assert.ok(bounds.xmin >= SPAWN_CLEAR_M, `${type}: defaults stay clear of the spawn area`);
  }
});

test('the same spec always builds the same course; the seed changes a random layout', () => {
  const boxes = defaultTerrain('boxes');
  assert.equal(buildTerrain(boxes).xml, buildTerrain({ ...boxes }).xml);
  assert.notEqual(buildTerrain({ ...boxes, seed: 8 }).xml, buildTerrain(boxes).xml);
  assert.equal(terrainKey(boxes), terrainKey({ ...boxes }));
  assert.notEqual(terrainKey({ ...boxes, seed: 8 }), terrainKey(boxes));
});

test('heightAt follows the stairs and the ramp', () => {
  const stairs = buildTerrain({ ...defaultTerrain('stairs'), step_height_m: 0.1 });
  assert.equal(stairs.heightAt(1.4, 0), 0);
  assert.equal(stairs.heightAt(1.6, 0), 0.1);
  assert.equal(stairs.heightAt(4, 0), 0.5);
  assert.equal(stairs.heightAt(4, 3.5), 0, 'beside the course');
  const ramp = buildTerrain({ ...defaultTerrain('slope'), angle_deg: 10, height_m: 0.3 });
  assert.ok(Math.abs(ramp.heightAt(2, 0) - 0.5 * Math.tan(Math.PI / 18)) < 1e-9);
  assert.ok(Math.abs(ramp.heightAt(4, 0) - 0.3) < 1e-9);
  assert.equal(ramp.heightAt(7, 0), 0);
});

test('validateTerrain lists every problem', () => {
  assert.deepEqual(validateTerrain({ type: 'lava' }), ['type must be one of stairs, slope, boxes, rough']);
  const errors = validateTerrain({ ...defaultTerrain('stairs'), steps: 2.5, tread_m: 9, colour: 'red' });
  assert.equal(errors.length, 3);
  assert.ok(validateTerrain({ ...defaultTerrain('rough'), min_height_m: 0.05, max_height_m: 0.01 }).some((e) => e.includes('min_height_m')));
  assert.ok(validateTerrain({ ...defaultTerrain('rough'), length_m: 0.3, tile_m: 2 }).some((e) => e.includes('no tiles')));
  const { step_height_m, ...missing } = defaultTerrain('stairs');
  assert.deepEqual(validateTerrain(missing), ['step_height_m is required (a number)']);
});

test('a fall is judged by height above the ground under the robot', async () => {
  const { hasFailed } = await import('./benchmarkRunner.js');
  const platform = buildTerrain({ ...defaultTerrain('stairs'), step_height_m: 0.1 }); // 0.5 m top at x = 4
  // upright (identity quaternion), base at world z = 0.6, standing at x
  const robot = (x, z, terrain) => ({ simulation: { qpos: [x, 0, z, 1, 0, 0, 0] }, terrain });
  assert.equal(hasFailed(robot(0, 0.6, null)), false, 'standing on the floor');
  assert.equal(hasFailed(robot(4, 1.1, platform)), false, 'standing on the 0.5 m platform');
  assert.equal(hasFailed(robot(4, 0.6, platform)), true, 'slumped upright on the platform: 0.1 m above it');
  assert.equal(hasFailed(robot(4, 0.6, null)), false, 'the same pose on the floor is standing');
});

const walk = (commands, terrain, duration = 22) => ({ duration, commands, terrain });

test('the commanded path is the commands integrated, held between keypoints', () => {
  const path = commandedPath(walk([{ t: 0, vx: 0, vy: 0, wz: 0 }, { t: 1, vx: 0.5, vy: 0, wz: 0 }], null, 3));
  const end = path[path.length - 1];
  assert.ok(Math.abs(end.x - 1) < 1e-6 && Math.abs(end.y) < 1e-9, JSON.stringify(end));
});

test('terrainProblems: a course on the spawn is an error, a path that misses or leaves it a warning', () => {
  const forward = [{ t: 0, vx: 0, vy: 0, wz: 0 }, { t: 0.3, vx: 0.4, vy: 0, wz: 0 }];
  assert.deepEqual(terrainProblems(walk(forward, defaultTerrain('stairs'))).errors, []);
  assert.deepEqual(terrainProblems(walk(forward, defaultTerrain('stairs'))).warnings, []);

  const onSpawn = terrainProblems(walk(forward, { ...defaultTerrain('stairs'), start_m: 0.2 }));
  assert.match(onSpawn.errors[0], /inside the spawn area/);

  const backwards = terrainProblems(walk([{ t: 0, vx: -0.4, vy: 0, wz: 0 }], defaultTerrain('stairs')));
  assert.match(backwards.warnings[0], /never reaches the course/);

  const narrowLane = defaultTerrain('boxes');
  // a gentle 0.05 rad/s turn reaches the 1.2 m lane, then drifts off its side
  const veer = terrainProblems(walk([{ t: 0, vx: 0.5, vy: 0, wz: 0.05 }], narrowLane));
  assert.match(veer.warnings[0], /leaves the course sideways/);

  assert.match(terrainProblems(walk(forward, { type: 'stairs' })).errors[0], /invalid terrain/);
});

test('the end of the commanded path, to 2 decimals, and whether an end zone is reachable', () => {
  // 0.5 m/s for 4 s, then a quarter turn left in place, then 0.5 m/s for 2 s: ends near (2, 1).
  const sequence = {
    duration: 8,
    commands: [{ t: 0, vx: 0.5, vy: 0, wz: 0 }, { t: 4, vx: 0, vy: 0, wz: Math.PI / 4 }, { t: 6, vx: 0.5, vy: 0, wz: 0 }],
  };
  const end = commandedEnd(sequence);
  assert.ok(Math.abs(end.x - 2) < 0.03 && Math.abs(end.y - 1) < 0.03, JSON.stringify(end));
  assert.equal(end.x, roundGoal(end.x));
  assert.equal(roundGoal(-0.001), 0);
  assert.deepEqual(goalProblems({ ...sequence, goal: { ...end, radius_m: 0.5 } }), []);
  assert.match(goalProblems({ ...sequence, goal: { x: -3, y: 0, radius_m: 0.5 } })[0], /never enters the end zone/);
  assert.deepEqual(validateGoal({ x: 1.25, y: -0.5, radius_m: 1 }), []);
  assert.ok(validateGoal({ x: 1.255, y: 0, radius_m: 1 }).some((e) => e.includes('2 decimals')));
});
