import assert from 'node:assert/strict';
import test from 'node:test';

import { spliceTerrain, withTerrain } from './terrainScene.js';

const ROBOT = `<mujoco model="robot">
  <asset>
    <material name="groundplane" rgba="1 1 1 1"/>
  </asset>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05"/>
    <body name="pelvis_link"><freejoint/></body>
  </worldbody>
</mujoco>
`;

const FRAGMENT = `<mujoco>
  <!-- a comment with <worldbody> inside must be ignored -->
  <asset><material name="terrain" rgba="0.5 0.5 0.4 1"/></asset>
  <worldbody>
    <geom name="step1" type="box" pos="2 0 0.05" size="1 1 0.05" material="terrain"/>
  </worldbody>
</mujoco>`;

test('spliceTerrain adds the fragment geoms to the worldbody and its assets to <asset>', () => {
  const xml = spliceTerrain(ROBOT, FRAGMENT);
  assert.match(xml, /<asset>\s*<material name="terrain"[^>]*\/>\s*<material name="groundplane"/);
  const step = xml.indexOf('name="step1"');
  assert.ok(step > xml.indexOf('name="pelvis_link"') && step < xml.indexOf('</worldbody>'));
  assert.equal((xml.match(/<worldbody>/g) || []).length, 1);
  assert.ok(xml.includes('name="floor"'), 'the robot scene is otherwise unchanged');
});

test('spliceTerrain creates an <asset> block when the robot scene has none', () => {
  const xml = spliceTerrain(ROBOT.replace(/  <asset>[\s\S]*?<\/asset>\n/, ''), FRAGMENT);
  assert.ok(xml.indexOf('<asset>') < xml.indexOf('<worldbody>'));
  assert.match(xml, /<material name="terrain"/);
});

test('spliceTerrain rejects a fragment without geoms', () => {
  assert.throws(() => spliceTerrain(ROBOT, '<mujoco><asset/></mujoco>'), /no <worldbody> geoms/);
});

test('withTerrain writes the combined scene next to the robot XML', () => {
  const files = { '/working/robot/xmls/robot.xml': ROBOT, '/working/terrain/stairs_5cm.xml': FRAGMENT };
  const mujoco = {
    FS: {
      readFile: (path) => files[path],
      writeFile: (path, text) => { files[path] = text; },
    },
  };
  const path = withTerrain(mujoco, 'robot/xmls/robot.xml', 'terrain/stairs_5cm.xml');
  assert.equal(path, 'robot/xmls/robot.terrain-stairs_5cm.xml');
  assert.match(files['/working/' + path], /name="step1"/);
});
