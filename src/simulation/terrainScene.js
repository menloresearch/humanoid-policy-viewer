// Terrain benchmark scenes. A test names a terrain fragment (an MJCF file with
// an optional <asset> block and a <worldbody> of static geoms, under
// public/examples/scenes/terrain/), and the fragment is spliced into the robot
// scene just before compile, the same way sceneOverlay.js adds actuators: the
// canonical robot XML is never edited. The combined scene is written next to
// the robot XML so its relative meshdir still resolves.

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
 * Writes robotFile + terrainFile (both relative to /working/) as one scene next
 * to robotFile and returns its path (relative to /working/), ready for
 * MuJoCoDemo.reload().
 */
export function withTerrain(mujoco, robotFile, terrainFile) {
  const robot = mujoco.FS.readFile('/working/' + robotFile, { encoding: 'utf8' });
  const fragment = mujoco.FS.readFile('/working/' + terrainFile, { encoding: 'utf8' });
  const name = terrainFile.split('/').pop().replace(/\.xml$/i, '');
  const combined = robotFile.replace(/\.xml$/i, `.terrain-${name}.xml`);
  mujoco.FS.writeFile('/working/' + combined, spliceTerrain(robot, fragment));
  return combined;
}

/**
 * Loads the scene a test runs in: the default robot scene with the test's
 * terrain fragment spliced in, or the plain default scene when it names none.
 * Reloads (keeping the current policy) only when that differs from the scene
 * already loaded, so flat tests after flat tests cost nothing. Used by both
 * the benchmark and live playback of a test. Returns whether it reloaded.
 */
export async function loadTestScene(demo, terrain) {
  if (!demo?.defaultScenePath || !demo.currentScenePath) return false;
  const want = terrain ? withTerrain(demo.mujoco, demo.defaultScenePath, terrain) : demo.defaultScenePath;
  if (want === demo.currentScenePath) return false;
  const wasPaused = demo.params?.paused;
  if (demo.params) demo.params.paused = true;
  // Let an in-flight loop iteration finish before the model is replaced.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await demo.reload(want);
  if (demo.params) demo.params.paused = wasPaused;
  return true;
}
