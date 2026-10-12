import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTestScene, spliceTerrain, withTerrain } from './terrainScene.js';
import { defaultTerrain, terrainKey } from './terrainGen.js';

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

const STAIRS = { ...defaultTerrain('stairs'), step_height_m: 0.05 };

test('withTerrain builds the course and writes the combined scene next to the robot XML', () => {
  const files = { '/working/robot/xmls/robot.xml': ROBOT };
  const mujoco = {
    FS: {
      readFile: (path) => files[path],
      writeFile: (path, text) => { files[path] = text; },
    },
  };
  const { path, terrain } = withTerrain(mujoco, 'robot/xmls/robot.xml', STAIRS);
  assert.equal(path, `robot/xmls/robot.terrain-${terrainKey(STAIRS)}.xml`);
  assert.match(files['/working/' + path], /name="stair5"/);
  assert.equal(terrain.heightAt(4, 0), 0.25);
});

function fakeDemo() {
  const files = { '/working/robot/xmls/robot.xml': ROBOT };
  const demo = {
    mujoco: { FS: { readFile: (path) => files[path], writeFile: (path, text) => { files[path] = text; } } },
    defaultScenePath: 'robot/xmls/robot.xml',
    currentScenePath: 'robot/xmls/robot.xml',
    alive: true,
    _loopPromise: null,
    reloads: [],
    loopStarts: 0,
    async stopMainLoop() {
      this.alive = false;
      await this._loopPromise;
      this._loopPromise = null;
    },
    main_loop() {
      this.loopStarts += 1;
      this._loopPromise = Promise.resolve();
    },
    async reload(path) {
      assert.equal(this.alive, false, 'the sim loop is stopped while the model is replaced');
      this.reloads.push(path);
      this.currentScenePath = path;
      this.terrain = null; // as reloadScene does
    },
  };
  return demo;
}

test('loadTestScene switches to a terrain scene and back, reloading only on a change', async () => {
  const demo = fakeDemo();
  assert.equal(await loadTestScene(demo, undefined), false);
  assert.equal(demo.terrain, null);
  assert.equal(await loadTestScene(demo, STAIRS), true);
  assert.equal(demo.terrain.heightAt(4, 0), 0.25, 'the course is kept for fall detection');
  assert.equal(await loadTestScene(demo, { ...STAIRS }), false, 'the same parameters reuse the loaded scene');
  assert.equal(demo.terrain.heightAt(4, 0), 0.25);
  assert.equal(await loadTestScene(demo, null), true);
  assert.equal(demo.terrain, null);
  assert.equal(demo.reloads.length, 2);
  assert.equal(demo.reloads[1], 'robot/xmls/robot.xml');
});

test('loadTestScene restarts a running loop only when asked', async () => {
  const demo = fakeDemo();
  demo.main_loop();
  await loadTestScene(demo, STAIRS);
  assert.equal(demo.loopStarts, 2, 'live playback: the loop runs again');
  await loadTestScene(demo, null, { restartLoop: false });
  assert.equal(demo.loopStarts, 2, 'benchmark: the loop stays stopped');
});
