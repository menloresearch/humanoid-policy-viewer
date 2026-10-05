// Pure metric math ported and generalized from public/sim-metrics.js.
// No DOM, no side effects. ES module.

import { yawFromQuat } from './idealPath.js';

const MAX_POINTS_PER_SERIES = 700;

function round(value, digits = 5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function roundArray(value, digits = 5) {
  if (!value) return [];
  return Array.from(value, (entry) => round(entry, digits));
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function rmse(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length);
}

function distance2(a, b) {
  const dx = (a?.[0] ?? 0) - (b?.[0] ?? 0);
  const dy = (a?.[1] ?? 0) - (b?.[1] ?? 0);
  return Math.hypot(dx, dy);
}

function downsample(rows, maxPoints = MAX_POINTS_PER_SERIES) {
  if (rows.length <= maxPoints) return rows;
  const stride = Math.ceil(rows.length / maxPoints);
  return rows.filter((_, index) => index % stride === 0);
}

// RMSE of (actual - command) per axis over the given rows.
function rmseByAxis(rows) {
  return {
    vx: round(rmse(rows.map((sample) => (sample.actualBaseLinearVelocity?.[0] ?? NaN) - (sample.commandVelocity?.[0] ?? NaN)))),
    vy: round(rmse(rows.map((sample) => (sample.actualBaseLinearVelocity?.[1] ?? NaN) - (sample.commandVelocity?.[1] ?? NaN)))),
    wz: round(rmse(rows.map((sample) => (sample.actualBaseAngularVelocity?.[2] ?? NaN) - (sample.commandVelocity?.[2] ?? NaN)))),
  };
}

function meanErrorByAxis(rows) {
  return {
    vx: round(mean(rows.map((sample) => (sample.actualBaseLinearVelocity?.[0] ?? NaN) - (sample.commandVelocity?.[0] ?? NaN)))),
    vy: round(mean(rows.map((sample) => (sample.actualBaseLinearVelocity?.[1] ?? NaN) - (sample.commandVelocity?.[1] ?? NaN)))),
    wz: round(mean(rows.map((sample) => (sample.actualBaseAngularVelocity?.[2] ?? NaN) - (sample.commandVelocity?.[2] ?? NaN)))),
  };
}

function computeActionJerk(samples, dt) {
  const actionRows = samples.map((sample) => sample.policyActions).filter((actions) => actions?.length);
  if (actionRows.length < 4) return null;
  const denom = Math.max(1e-9, dt ** 3);
  let total = 0;
  let count = 0;
  for (let frame = 3; frame < actionRows.length; frame++) {
    const current = actionRows[frame];
    const a = actionRows[frame - 1];
    const b = actionRows[frame - 2];
    const c = actionRows[frame - 3];
    for (let joint = 0; joint < current.length; joint++) {
      total += Math.abs((current[joint] - 3 * a[joint] + 3 * b[joint] - c[joint]) / denom);
      count += 1;
    }
  }
  return count ? total / count : null;
}

function symmetrySign(name) {
  return /(roll|yaw)/i.test(name) ? -1 : 1;
}

function computeGaitSymmetry(rows, jointNames) {
  const pairs = [];
  const names = Array.from(jointNames || []);
  for (const leftName of names.filter((name) => /^left_/i.test(name))) {
    const rightName = leftName.replace(/^left_/i, "right_");
    const leftIndex = names.indexOf(leftName);
    const rightIndex = names.indexOf(rightName);
    if (leftIndex >= 0 && rightIndex >= 0) {
      pairs.push({ label: leftName.replace(/^left_/i, "").replace(/_joint$/i, ""), leftIndex, rightIndex, sign: symmetrySign(leftName) });
    }
  }
  const jointMetrics = pairs.map((pair) => {
    const errors = rows.map((sample) => {
      const left = sample.jointPositions?.[pair.leftIndex];
      const right = sample.jointPositions?.[pair.rightIndex];
      return Number.isFinite(left) && Number.isFinite(right) ? left - pair.sign * right : NaN;
    });
    return { joint: pair.label, mirrorRmse: round(rmse(errors)) };
  });
  const meanMirrorRmse = mean(jointMetrics.map((metric) => metric.mirrorRmse));
  const contactDutyAsymmetry = Math.abs(
    (mean(rows.map((sample) => (sample.footContacts?.left ? 1 : 0))) || 0) -
    (mean(rows.map((sample) => (sample.footContacts?.right ? 1 : 0))) || 0)
  );
  const limpIndex = Math.max(0, Math.min(1, (meanMirrorRmse || 0) + contactDutyAsymmetry));
  return {
    symmetryScorePercent: round(100 * (1 - limpIndex), 2),
    limpIndex: round(limpIndex),
    meanMirrorRmse: round(meanMirrorRmse),
    contactDutyAsymmetry: round(contactDutyAsymmetry),
    pairs: jointMetrics,
  };
}

// ---------------------------------------------------------------------------
// Push resistance
//
// A push disturbs *command tracking*, not raw velocity — the robot is often
// already walking/turning when it gets pushed. So instead of diffing world-
// frame velocity, we diff the tracking-error vector (actual velocity, in the
// robot's own heading frame, minus command) before vs. during/after the push.
// This scores a push identically whether the robot is standing, walking, or
// turning, and correctly penalizes "pushed the way I was already going" —
// the robot still has to shed the extra speed to get back on-command, even
// though nothing falls.
// ---------------------------------------------------------------------------
const PRE_WINDOW_S = 0.5;
const RESPONSE_WINDOW_S = 2.5;
const TAU_REF_S = 0.5; // ~one footstep: a disturbance absorbed within a step is nearly free
const YAW_LEVER_M = 0.25; // half stance width — converts yaw-rate error into linear-error units
const ALIGN_THRESHOLD = 0.5;
const LOW_SIGNAL_DELTA_V = 0.05;
// Exported for benchmarkRunner.js's hasFailed() to use directly, so peak
// instability reaches 1.0 iff the push would register as a fall — the two
// can't drift apart the way two independently hand-copied constants could.
export const TILT_FALL_RAD = Math.acos(0.2); // ~78.5°
export const HEIGHT_FALL_M = 0.35;

function normalizeDir3(dir) {
  const x = Number(dir?.[0]) || 0;
  const y = Number(dir?.[1]) || 0;
  const z = Number(dir?.[2]) || 0;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// Rotate a world-frame xy vector into the robot's heading frame (R(-yaw)).
function rotateToHeading(x, y, yaw) {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

function trackingError(sample) {
  const [qw, qx, qy, qz] = sample.rootOrientation || [1, 0, 0, 0];
  const yaw = yawFromQuat(qw, qx, qy, qz);
  const [vx, vy] = sample.actualBaseLinearVelocity || [0, 0, 0];
  const heading = rotateToHeading(vx || 0, vy || 0, yaw);
  const cmd = sample.commandVelocity || [0, 0, 0];
  const wz = sample.actualBaseAngularVelocity?.[2] ?? 0;
  return {
    yaw,
    ex: heading.x - (Number(cmd[0]) || 0),
    ey: heading.y - (Number(cmd[1]) || 0),
    ew: YAW_LEVER_M * (wz - (Number(cmd[2]) || 0)),
  };
}

function tiltRadians(sample) {
  const qx = sample.rootOrientation?.[1] ?? 0;
  const qy = sample.rootOrientation?.[2] ?? 0;
  const cosTilt = Math.max(-1, Math.min(1, 1 - 2 * (qx * qx + qy * qy)));
  return Math.acos(cosTilt);
}

function byClassSummary(events) {
  const classes = ['along', 'against', 'lateral', 'standstill'];
  const out = {};
  for (const cls of classes) {
    const group = events.filter((e) => e.alignClass === cls);
    out[cls] = { n: group.length, meanScore: group.length ? round(mean(group.map((e) => e.score))) : null };
  }
  return out;
}

// Perturbation recovery: for each scripted push, how much did the robot's
// command tracking actually get disturbed (transmissibility), how long did
// it take to settle back down (recoveryTau_s), and how close did it come to
// falling (peakInstability) — folded into one composite `score`.
function computePerturbations(samples, sequence, massByBody, fallbackMassKg) {
  const events = (sequence?.events || []).filter((event) => event?.type === "push");
  if (!events.length) return null;
  const dt = samples.length > 1 ? (samples[1].time - samples[0].time) || 0.02 : 0.02;

  const resolved = events.map((event, index) => {
    const t0 = Number(event.t) || 0;
    const dir3 = normalizeDir3(event.dir);
    const dxyLen = Math.hypot(dir3[0], dir3[1]);
    // force is authored in Newtons; the metric needs a velocity-change scale
    // to normalize against, so derive the expected dV from force*duration/mass
    // (mass resolved by target body — see benchmarkRunner.js). A resolved
    // mass of 0 is a legitimate value (a massless attachment/frame body) and
    // must NOT be treated as "missing" — only a genuinely absent map entry
    // falls through to fallbackMassKg, and if that's not set either, this is
    // a real authoring/wiring problem, not something to paper over silently.
    const resolvedMass = massByBody?.[event.targetBody || ''];
    const mass = resolvedMass ?? fallbackMassKg;
    if (mass == null) {
      throw new Error(
        `computePerturbations: push event at t=${t0}s targets body "${event.targetBody || '(default)'}" ` +
        `but its mass could not be resolved (no massByBody entry, and no fallbackMassKg option was given)`
      );
    }
    const force = Number(event.force) || 0;
    const duration = Number(event.duration) || 0;
    // Not scaled by dxyLen: this is the overall push magnitude the response
    // gets normalized against, independent of direction — a push scaled down
    // toward zero for a vertical (or steeply angled) push would make
    // deltaVExpected collapse toward 0, wrongly flagging a large vertical push
    // as low-signal (see dEz below for how verticality is actually scored).
    const deltaVExpected = Math.abs(force) * duration / mass;
    // mass === 0 makes deltaVExpected infinite (a legitimate resolved mass,
    // see above, but not a usable normalization scale) — treat it as
    // low-signal so it's excluded from transmissibility/recoveryTau instead
    // of silently collapsing those divisions toward 0.
    const lowSignal = !(mass > 0) || deltaVExpected < LOW_SIGNAL_DELTA_V;

    const base = {
      t: round(t0, 5),
      dir: event.dir ?? null,
      // Commanded input — see transmissibility below for the actual outcome.
      force: round(event.force, 5),
      duration: round(event.duration, 5),
      targetBody: event.targetBody ?? null,
    };

    const prevT = index > 0 ? Number(events[index - 1].t) || -Infinity : -Infinity;
    const nextT = index + 1 < events.length ? Number(events[index + 1].t) || Infinity : Infinity;
    const testEnd = samples.length ? samples[samples.length - 1].time : t0;
    const responseEnd = Math.min(t0 + RESPONSE_WINDOW_S, nextT, testEnd);

    const preWindow = samples.filter((s) => s.time >= Math.max(t0 - PRE_WINDOW_S, prevT) && s.time < t0);
    const responseWindow = samples.filter((s) => s.time >= t0 && s.time <= responseEnd);

    if (preWindow.some((s) => s.fallen === true)) {
      return { ...base, recovered: null, fallenBeforePush: true, score: null };
    }
    if (!responseWindow.length) {
      return { ...base, recovered: null, score: null };
    }

    const anchorWindow = preWindow.length ? preWindow : [responseWindow[0]];
    const preErrors = anchorWindow.map(trackingError);
    const baseline = {
      ex: mean(preErrors.map((e) => e.ex)) || 0,
      ey: mean(preErrors.map((e) => e.ey)) || 0,
      ew: mean(preErrors.map((e) => e.ew)) || 0,
    };
    const zPre = mean(anchorWindow.map((s) => s.rootPosition?.[2]));
    const noiseFloor = rmse(preErrors.map((e, i) => {
      const z = anchorWindow[i].rootPosition?.[2];
      const dEz = Number.isFinite(z) && Number.isFinite(zPre) ? z - zPre : 0;
      return Math.hypot(e.ex - baseline.ex, e.ey - baseline.ey, e.ew - baseline.ew, dEz);
    })) || 0;

    const recovered = !responseWindow.some((s) => s.fallen === true);
    let transmissibility = null;
    let recoveryTau = 0;
    let peakInstability = 0;

    for (const sample of responseWindow) {
      const e = trackingError(sample);
      const dEx = e.ex - baseline.ex;
      const dEy = e.ey - baseline.ey;
      const dEw = e.ew - baseline.ew;
      const z = sample.rootPosition?.[2];
      // Included so a purely (or mostly) vertical push — where dEx/dEy/dEw
      // stay near their pre-push baseline — still drives recoveryTau off the
      // disturbance it actually causes (a height dip) instead of reading as
      // "already recovered" for the whole response window.
      const dEz = Number.isFinite(z) && Number.isFinite(zPre) ? z - zPre : 0;
      const dMag = Math.hypot(dEx, dEy, dEw, dEz);

      if (!lowSignal) {
        const headingDir = rotateToHeading(dir3[0], dir3[1], e.yaw);
        const along = dEx * headingDir.x + dEy * headingDir.y;
        const candidate = along / deltaVExpected;
        transmissibility = transmissibility == null ? candidate : Math.max(transmissibility, candidate);
        recoveryTau += (Math.max(0, dMag - noiseFloor) * dt) / deltaVExpected;
      }

      const heightFrac = Number.isFinite(z) && Number.isFinite(zPre) && zPre > HEIGHT_FALL_M
        ? (zPre - z) / (zPre - HEIGHT_FALL_M)
        : 0;
      const tiltFrac = tiltRadians(sample) / TILT_FALL_RAD;
      const instability = sample.fallen === true ? 1 : Math.max(0, Math.min(1, Math.max(tiltFrac, heightFrac)));
      peakInstability = Math.max(peakInstability, instability);
    }

    const score = round(Math.max(0, 1 - peakInstability) * (TAU_REF_S / (TAU_REF_S + recoveryTau)), 4);

    // Alignment: how the push relates to what the robot was already
    // commanded to do at push-time — "pushed the way I was already going" is
    // a materially different test than "pushed against my own motion," even
    // when the resulting score is the same.
    const t0Error = trackingError(responseWindow[0]);
    const cmd = responseWindow[0].commandVelocity || [0, 0, 0];
    const cmdX = Number(cmd[0]) || 0, cmdY = Number(cmd[1]) || 0;
    const cmdLen = Math.hypot(cmdX, cmdY);
    let alignClass = 'standstill';
    if (cmdLen >= 0.05 && dxyLen > 1e-6) {
      const headingDir = rotateToHeading(dir3[0], dir3[1], t0Error.yaw);
      const alignment = (headingDir.x * cmdX + headingDir.y * cmdY) / (dxyLen * cmdLen);
      alignClass = alignment > ALIGN_THRESHOLD ? 'along' : alignment < -ALIGN_THRESHOLD ? 'against' : 'lateral';
    }

    // A command keypoint landing inside this push's own windows adds the
    // policy's own transient to the measured error — flag it rather than
    // silently mixing the two disturbances together.
    const commandChangedNearPush = (sequence?.commands || []).some((c) => {
      const ct = Number(c?.t);
      return Number.isFinite(ct) && ct > t0 - PRE_WINDOW_S && ct < responseEnd && ct !== t0;
    });

    return {
      ...base,
      recovered,
      score,
      transmissibility: transmissibility == null ? null : round(transmissibility, 4),
      recoveryTau_s: lowSignal ? null : round(recoveryTau, 4),
      peakInstability: round(peakInstability, 4),
      alignClass,
      lowSignal,
      commandChangedNearPush,
    };
  });

  const scoredEvents = resolved.filter((e) => e.score != null);
  return {
    total: resolved.length,
    survived: resolved.filter((event) => event.recovered).length,
    scored: scoredEvents.length,
    meanScore: round(mean(scoredEvents.map((e) => e.score))),
    meanTransmissibility: round(mean(scoredEvents.filter((e) => e.transmissibility != null).map((e) => e.transmissibility))),
    meanRecoveryTau_s: round(mean(scoredEvents.filter((e) => e.recoveryTau_s != null).map((e) => e.recoveryTau_s))),
    meanPeakInstability: round(mean(scoredEvents.map((e) => e.peakInstability))),
    byClass: byClassSummary(scoredEvents),
    events: resolved,
  };
}

export function computeMetrics(samples, { dt = 0.02, jointNames = [], sequence = null, massByBody = null, fallbackMassKg = null } = {}) {
  const rows = Array.isArray(samples) ? samples : [];

  // Command tracking: RMSE per axis over ALL samples.
  const commandTracking = { overall: rmseByAxis(rows) };

  // Downsampled time series (<=700 points).
  const seriesRows = downsample(rows);
  const series = {
    time: seriesRows.map((sample) => round(sample.time)),
    command: {
      vx: seriesRows.map((sample) => round(sample.commandVelocity?.[0])),
      vy: seriesRows.map((sample) => round(sample.commandVelocity?.[1])),
      wz: seriesRows.map((sample) => round(sample.commandVelocity?.[2])),
    },
    actual: {
      vx: seriesRows.map((sample) => round(sample.actualBaseLinearVelocity?.[0])),
      vy: seriesRows.map((sample) => round(sample.actualBaseLinearVelocity?.[1])),
      wz: seriesRows.map((sample) => round(sample.actualBaseAngularVelocity?.[2])),
    },
    error: {
      vx: seriesRows.map((sample) => round((sample.actualBaseLinearVelocity?.[0] ?? 0) - (sample.commandVelocity?.[0] ?? 0))),
      vy: seriesRows.map((sample) => round((sample.actualBaseLinearVelocity?.[1] ?? 0) - (sample.commandVelocity?.[1] ?? 0))),
      wz: seriesRows.map((sample) => round((sample.actualBaseAngularVelocity?.[2] ?? 0) - (sample.commandVelocity?.[2] ?? 0))),
    },
    drift: seriesRows.map((sample) => round(sample.drift)),
  };

  // Top-down path: downsampled expected vs actual root X/Y.
  const topDown = {
    expected: seriesRows.map((sample) => [round(sample.expectedTrajectory?.[0]), round(sample.expectedTrajectory?.[1])]),
    actual: seriesRows.map((sample) => [round(sample.rootPosition?.[0]), round(sample.rootPosition?.[1])]),
  };

  // Drift stats over all samples.
  const driftValues = rows.map((sample) => sample.drift).filter(Number.isFinite);
  const drift = {
    final_m: driftValues.length ? round(driftValues[driftValues.length - 1]) : null,
    max_m: driftValues.length ? round(Math.max(...driftValues)) : null,
    rmse_m: round(rmse(driftValues)),
  };

  // Balance.
  const supportMargins = rows.map((sample) => sample.supportMargin).filter(Number.isFinite);
  const balance = {
    meanSupportMargin_m: round(mean(supportMargins)),
    minSupportMargin_m: supportMargins.length ? round(Math.min(...supportMargins)) : null,
    leftContactDuty: round(mean(rows.map((sample) => (sample.footContacts?.left ? 1 : 0)))),
    rightContactDuty: round(mean(rows.map((sample) => (sample.footContacts?.right ? 1 : 0)))),
  };

  // Gait symmetry over ALL samples — opt-in per test: the left/right mirror
  // assumption only holds during sustained, constant-velocity straight-line
  // walking, so a test must explicitly opt in (dataset row
  // `metrics_opt_in: ["gait_symmetry"]`, i.e. `gaitSymmetry: true` here).
  const gaitSymmetry = sequence?.gaitSymmetry === true ? computeGaitSymmetry(rows, jointNames) : null;

  // Action smoothness.
  const deltas = rows.flatMap((sample) => sample.actionDeltas || []);
  const actionSmoothness = {
    meanAbsDelta: round(mean(deltas.map(Math.abs))),
    rmsDelta: round(rmse(deltas)),
    jerkLikeScore: round(computeActionJerk(rows, dt)),
  };

  // Perturbations.
  const perturbations = computePerturbations(rows, sequence, massByBody, fallbackMassKg);

  // Fell.
  const firstFallen = rows.find((sample) => sample.fallen === true);
  const fell = {
    fell: !!firstFallen,
    time: firstFallen ? round(firstFallen.time) : null,
  };

  return {
    duration_s: rows.length ? round(rows[rows.length - 1].time - rows[0].time, 4) : 0,
    frames: rows.length,
    commandTracking,
    series,
    topDown,
    drift,
    balance,
    gaitSymmetry,
    actionSmoothness,
    perturbations,
    fell,
  };
}
