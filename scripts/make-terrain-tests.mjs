#!/usr/bin/env node
// npm run terrain-tests [<benchmark dir>]      (default ./benchmark)
//
// Writes seven terrain tests to <benchmark dir>/data/terrain/test.jsonl (it
// replaces that file): stairs, ramps, scattered boxes and rough tiles, each
// walked straight over at 0.4 m/s for 20 s, plus the 10 degree ramp with
// shoulder pushes. A starting point; edit or add terrain tests in the
// trajectory editor (npm run dev suite=<dir>, Environment panel).
//
// Every course starts 1.5 m in front of the robot, so a policy that keeps pace
// ends near x = 8 m, past the end of every course.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTerrain } from '../src/simulation/terrainGen.js';
import { validateTestRow } from '../src/benchmark/testRow.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? join(appDir, 'benchmark'));
const SPEED = 0.4;

const push = (t, dy, force, body, label) => ({
  t, type: 'push', dir: [0, dy, 0], force, duration: 0.15, targetBody: body, torqueAxis: null, torqueMag: null, label,
});

const walk = (name, title, terrain, events = []) => ({
  id: `terrain/${name}`, config: 'terrain', schema_version: 1, kind: 'velocity-sequence',
  name: `terrain: ${title}`, description: '', tags: ['terrain', terrain.type], duration: 22,
  commands: [{ t: 0, vx: 0, vy: 0, wz: 0 }, { t: 0.3, vx: SPEED, vy: 0, wz: 0 }, { t: 20.5, vx: 0, vy: 0, wz: 0 }],
  events, limits: null, foot_friction: null, terrain, metrics_opt_in: [],
});

const rows = [
  walk('stairs_5cm', '5 cm stairs up and down (5 steps each way, 35 cm treads)', { ...defaultTerrain('stairs'), step_height_m: 0.05 }),
  walk('stairs_10cm', '10 cm stairs up and down (5 steps each way, 35 cm treads)', { ...defaultTerrain('stairs'), step_height_m: 0.1 }),
  walk('slope_10deg', '10 degree ramp up to 0.3 m and down', { ...defaultTerrain('slope'), angle_deg: 10, height_m: 0.3 }),
  walk('slope_15deg', '15 degree ramp up to 0.4 m and down', { ...defaultTerrain('slope'), angle_deg: 15, height_m: 0.4 }),
  walk('obstacles', 'scattered 3-7 cm boxes across the lane', defaultTerrain('boxes')),
  walk('rough', 'tiles 0.5-4 cm high, 30 cm square', defaultTerrain('rough')),
  walk('slope_push', '10 degree ramp with lateral shoulder pushes while climbing', { ...defaultTerrain('slope'), angle_deg: 10, height_m: 0.3 }, [
    push(5.5, 1, 150, 'left_shoulder_pitch_link', 'shoulder lateral 150 N on the ramp'),
    push(12.5, -1, 225, 'right_shoulder_pitch_link', 'shoulder lateral 225 N going down the ramp'),
  ]),
];

const problems = rows.flatMap(validateTestRow);
if (problems.length) throw new Error(problems.join('\n'));
const file = join(dir, 'data/terrain/test.jsonl');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
console.log(`Wrote ${rows.length} terrain tests to ${file}`);
