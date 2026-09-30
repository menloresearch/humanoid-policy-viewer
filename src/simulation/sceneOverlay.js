// asimov-1's MJCF deliberately ships without <actuator>s (its training sim adds
// them in Python), but the viewer drives joints through actuators. A scene with
// none gets one torque motor per `class="motor"` joint spliced in just before
// compile, so the canonical XML is never edited. The motors start unclamped:
// torque limits come from the loaded checkpoint's training config
// (applyTorqueLimits), not from the robot model, whose limits are hardware
// maxima that usually differ from what the policy was trained with.

export function motorJointNames(xml) {
  const names = [];
  for (const [tag] of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<joint\b[^>]*>/g)) {
    if (!/\bclass="motor"/.test(tag)) continue;
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    if (name) names.push(name);
  }
  return names;
}

export function buildActuatorBlock(jointNames) {
  const lines = jointNames.map((joint) => `    <motor name="${joint.replace(/_joint$/, '')}" joint="${joint}"/>`);
  return `  <actuator>\n${lines.join('\n')}\n  </actuator>\n`;
}

/** Returns the path (relative to /working/) of the scene XML to compile. */
export function withActuatorOverlay(mujoco, filename) {
  const xml = mujoco.FS.readFile('/working/' + filename, { encoding: 'utf8' });
  if (/<actuator[\s>]/.test(xml)) return filename;

  const joints = motorJointNames(xml);
  if (!joints.length) throw new Error(`${filename} defines no <actuator>s and no class="motor" joints to add them for`);

  const closing = xml.lastIndexOf('</mujoco>');
  if (closing < 0) throw new Error(`${filename} has no closing </mujoco> tag`);

  const patched = filename.replace(/\.xml$/i, '.with-actuators.xml');
  mujoco.FS.writeFile('/working/' + patched, xml.slice(0, closing) + buildActuatorBlock(joints) + xml.slice(closing));
  return patched;
}

/**
 * Sets each policy actuator's torque cap (N*m) from `limits` (aligned with
 * ctrlAdr). A null `limits` removes the cap: the viewer only clamps when
 * ctrlrange has min < max, so 0/0 means unlimited. Always called on policy
 * load so one checkpoint's limits never leak into the next.
 */
export function applyTorqueLimits(model, ctrlAdr, limits) {
  ctrlAdr.forEach((actuator, i) => {
    const limit = limits ? limits[i] : 0;
    model.actuator_ctrlrange[2 * actuator] = -limit;
    model.actuator_ctrlrange[2 * actuator + 1] = limit;
  });
}
