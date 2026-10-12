// Terrain benchmark scenes. A test describes its course with parameters
// (terrainGen.js); the generated MJCF fragment (an <asset> block and a
// <worldbody> of static geoms) is spliced into the robot scene just before
// compile, the same way sceneOverlay.js adds actuators: the canonical robot XML
// is never edited. The combined scene is written next to the robot XML so its
// relative meshdir still resolves.

import { buildTerrain, terrainKey } from './terrainGen.js';

function innerOf(xml, tag) {
  const open = xml.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!open || open[0].endsWith('/>')) return '';
  const start = open.index + open[0].length;
  const end = xml.indexOf(`</${tag}>`, start);
  if (end < 0) throw new Error(`terrain fragment has an unclosed <${tag}>`);
  return xml.slice(start, end);
}

/** Returns robotXml with the fragment's asset children and worldbody geoms added. */
export function spliceTerrain(robotXml, fragmentXml) {
  const fragment = fragmentXml.replace(/<!--[\s\S]*?-->/g, '');
  const assets = innerOf(fragment, 'asset').trim();
  const geoms = innerOf(fragment, 'worldbody').trim();
  if (!geoms) throw new Error('terrain fragment has no <worldbody> geoms');

  let xml = robotXml;
  const worldEnd = xml.lastIndexOf('</worldbody>');
  if (worldEnd < 0) throw new Error('robot scene has no </worldbody>');
  xml = `${xml.slice(0, worldEnd)}    ${geoms}\n  ${xml.slice(worldEnd)}`;
  if (assets) {
    const assetOpen = xml.match(/<asset\b[^>]*>/);
    if (assetOpen) {
      const at = assetOpen.index + assetOpen[0].length;
      xml = `${xml.slice(0, at)}\n    ${assets}${xml.slice(at)}`;
    } else {
      const worldOpen = xml.indexOf('<worldbody');
      xml = `${xml.slice(0, worldOpen)}<asset>\n    ${assets}\n  </asset>\n\n  ${xml.slice(worldOpen)}`;
    }
  }
  return xml;
}

/**
 * Builds the course `spec` describes, writes robotFile (relative to /working/)
 * with it spliced in as one scene next to robotFile, and returns
 * { path, terrain }: the scene path for MuJoCoDemo.reload() and the built course.
 */
export function withTerrain(mujoco, robotFile, spec) {
  const terrain = buildTerrain(spec);
  const robot = mujoco.FS.readFile('/working/' + robotFile, { encoding: 'utf8' });
  const path = robotFile.replace(/\.xml$/i, `.terrain-${terrainKey(spec)}.xml`);
  mujoco.FS.writeFile('/working/' + path, spliceTerrain(robot, terrain.xml));
  return { path, terrain };
}

/**
 * Loads the scene a test runs in: the default robot scene with the test's
 * course spliced in, or the plain default scene when it has none. Reloads
 * (keeping the current policy) only when that differs from the scene already
 * loaded, so flat tests after flat tests cost nothing. The real-time loop is
 * stopped (and its in-flight tick finished) before the model is replaced; it
 * is restarted afterwards if it was running and `restartLoop` is set.
 * Afterwards `demo.terrain` is the built course (heightAt, bounds) or null.
 * Returns whether it reloaded.
 */
export async function loadTestScene(demo, spec, { restartLoop = true } = {}) {
  if (!demo?.defaultScenePath || !demo.currentScenePath) return false;
  const built = spec ? withTerrain(demo.mujoco, demo.defaultScenePath, spec) : null;
  const want = built ? built.path : demo.defaultScenePath;
  const reload = want !== demo.currentScenePath;
  if (reload) {
    const wasRunning = !!demo._loopPromise;
    await demo.stopMainLoop();
    await demo.reload(want);
    if (restartLoop && wasRunning) {
      demo.alive = true;
      demo.main_loop();
    }
  }
  demo.terrain = built ? built.terrain : null;
  return reload;
}
