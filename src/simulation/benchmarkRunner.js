// Headless multi-policy benchmark runner.
//
// Loads each policy in turn, plays a set of command-sequence tests against it,
// captures a per-frame sample stream (ported from public/sim-metrics.js's
// captureFrame) and folds each stream into computeMetrics(). Pure JS, no DOM.

import { computeMetrics, TILT_FALL_RAD, HEIGHT_FALL_M } from './metrics.js';
import { commandSequencer } from './commandSequencer.js';
import { yawFromQuat } from './idealPath.js';

const CONTACT_FORCE_THRESHOLD_N = 1.0;

// ---------------------------------------------------------------------------
// small numeric helpers (ported from sim-metrics.js)
// ---------------------------------------------------------------------------

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

function arraySlice(value, start = 0, end = undefined, digits = 5) {
  if (!value) return [];
  return roundArray(Array.prototype.slice.call(value, start, end), digits);
}

function distance2(a, b) {
  const dx = (a?.[0] ?? 0) - (b?.[0] ?? 0);
  const dy = (a?.[1] ?? 0) - (b?.[1] ?? 0);
  return Math.hypot(dx, dy);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

// ---------------------------------------------------------------------------
// geometry / failure helpers (ported from sim-metrics.js)
// ---------------------------------------------------------------------------

function averageBodyPosition(simulation, ids) {
  const valid = Array.from(ids || []).filter(
    (id) => Number.isFinite(id) && simulation?.xpos?.length >= (id + 1) * 3
  );
  if (!valid.length) return null;
  const total = [0, 0, 0];
  for (const id of valid) {
    total[0] += simulation.xpos[id * 3 + 0] || 0;
    total[1] += simulation.xpos[id * 3 + 1] || 0;
    total[2] += simulation.xpos[id * 3 + 2] || 0;
  }
  return total.map((value) => value / valid.length);
}

function estimateSupport(rootPosition, leftPosition, rightPosition, contacts, forces) {
  const active = [];
  if (contacts.left && leftPosition) active.push({ position: leftPosition, weight: Math.max(1, Math.abs(forces.leftFz || forces.leftMag || 0)) });
  if (contacts.right && rightPosition) active.push({ position: rightPosition, weight: Math.max(1, Math.abs(forces.rightFz || forces.rightMag || 0)) });
  if (!active.length || !rootPosition) return { zmp: null, supportMargin: null };

  const totalWeight = active.reduce((sum, item) => sum + item.weight, 0);
  const zmp = [
    active.reduce((sum, item) => sum + item.position[0] * item.weight, 0) / totalWeight,
    active.reduce((sum, item) => sum + item.position[1] * item.weight, 0) / totalWeight,
  ];

  let supportMargin = null;
  if (active.length === 2) {
    const center = [(leftPosition[0] + rightPosition[0]) / 2, (leftPosition[1] + rightPosition[1]) / 2];
    supportMargin = distance2(leftPosition, rightPosition) / 2 - distance2(rootPosition, center);
  } else {
    supportMargin = 0.08 - distance2(rootPosition, active[0].position);
  }
  return { zmp: roundArray(zmp), supportMargin: round(supportMargin) };
}

function projectedGravityZ(qpos) {
  const qy = qpos?.[4] || 0;
  const qz = qpos?.[5] || 0;
  return -(1 - 2 * (qy * qy + qz * qz));
}

function hasFailed(demo) {
  const qpos = demo?.simulation?.qpos;
  if (!qpos) return true;
  return !!demo._tumbling || (qpos[2] || 0) < HEIGHT_FALL_M || projectedGravityZ(qpos) > -Math.cos(TILT_FALL_RAD);
}

// ---------------------------------------------------------------------------
// per-frame sample (ported captureFrame -> metrics.js sample shape)
// ---------------------------------------------------------------------------

/**
 * Build a single metrics sample from the live sim.
 *
 * `state` carries per-test tracking that captureFrame kept on the runner:
 *   { dt, index, prevActions, expectedPosition }
 * `state.index` is used for the sample time (index * dt) and then advanced.
 */
function buildSample(demo, component, state) {
  const dt = state.dt;
  const simulation = demo.simulation;
  const policyState = typeof demo.readPolicyState === 'function' ? demo.readPolicyState() : null;
  const qpos = simulation?.qpos || [];
  const qvel = simulation?.qvel || [];

  const rootPosition = arraySlice(qpos, 0, 3);
  const rootOrientation = arraySlice(qpos, 3, 7);
  const actualLinear = arraySlice(qvel, 0, 3);
  const actualAngular = arraySlice(qvel, 3, 6);

  const command = [
    component?.cmdVx || 0,
    component?.cmdVy || 0,
    component?.cmdWz || 0,
  ];

  const actions = arraySlice(
    demo.rawActions || demo.policyRunner?.lastActions || demo.actionTarget,
    0,
    demo.numActions || undefined
  );
  const actionDeltas = actions.length && state.prevActions?.length === actions.length
    ? actions.map((value, index) => round(value - state.prevActions[index]))
    : [];
  state.prevActions = actions.slice();

  // Canonical path: dead-reckon the commanded velocity through the *heading*
  // frame, the same unicycle model IdealPathTracker uses for the minimap.
  // Integrating in the world frame instead would collapse a pure-yaw test to a
  // single point and understate drift on any turn.
  if (!state.expectedPosition) {
    state.expectedPosition = [rootPosition[0] || 0, rootPosition[1] || 0];
    state.expectedHeading = yawFromQuat(
      rootOrientation[0] ?? 1, rootOrientation[1] ?? 0,
      rootOrientation[2] ?? 0, rootOrientation[3] ?? 0
    );
  }
  state.expectedHeading += (command[2] || 0) * dt;
  const cosH = Math.cos(state.expectedHeading);
  const sinH = Math.sin(state.expectedHeading);
  state.expectedPosition[0] += ((command[0] || 0) * cosH - (command[1] || 0) * sinH) * dt;
  state.expectedPosition[1] += ((command[0] || 0) * sinH + (command[1] || 0) * cosH) * dt;
  const drift = distance2(rootPosition, state.expectedPosition);

  const forces = typeof demo.readFootGroundForces === 'function' ? demo.readFootGroundForces() : {};
  const contacts = {
    left: Math.abs(forces.leftFz || 0) > CONTACT_FORCE_THRESHOLD_N || (forces.leftMag || 0) > CONTACT_FORCE_THRESHOLD_N,
    right: Math.abs(forces.rightFz || 0) > CONTACT_FORCE_THRESHOLD_N || (forces.rightMag || 0) > CONTACT_FORCE_THRESHOLD_N,
  };
  const leftFootPosition = averageBodyPosition(simulation, demo.leftFootBodyIds);
  const rightFootPosition = averageBodyPosition(simulation, demo.rightFootBodyIds);
  const balance = estimateSupport(rootPosition, leftFootPosition, rightFootPosition, contacts, forces);

  const time = round(state.index * dt, 5);
  state.index += 1;

  return {
    time,
    commandVelocity: roundArray(command),
    actualBaseLinearVelocity: actualLinear,
    actualBaseAngularVelocity: actualAngular,
    rootPosition,
    rootOrientation,
    jointPositions: roundArray(policyState?.jointPos),
    jointVelocities: roundArray(policyState?.jointVel),
    policyActions: actions,
    actionDeltas,
    footContacts: contacts,
    contactForces: {
      leftFz: round(forces.leftFz),
      leftMag: round(forces.leftMag),
      rightFz: round(forces.rightFz),
      rightMag: round(forces.rightMag),
    },
    footPositions: {
      left: leftFootPosition ? roundArray(leftFootPosition) : null,
      right: rightFootPosition ? roundArray(rightFootPosition) : null,
    },
    supportMargin: balance.supportMargin,
    expectedTrajectory: roundArray(state.expectedPosition),
    drift: round(drift),
    fallen: hasFailed(demo),
  };
}

// ---------------------------------------------------------------------------
// duration estimate
// ---------------------------------------------------------------------------

export function estimateBenchmarkSeconds(policyCount, tests) {
  const perPolicyReload = 4;
  const perTestReset = 1.5;
  const list = Array.isArray(tests) ? tests : [];
  const testSeconds = list.reduce((sum, test) => sum + (Number(test?.duration) || 0), 0);
  const resetSeconds = list.length * perTestReset;
  return (Number(policyCount) || 0) * (perPolicyReload + testSeconds + resetSeconds);
}

// ---------------------------------------------------------------------------
// benchmark runner
// ---------------------------------------------------------------------------

async function waitForPolicyReady(demo, deadlineMs = 10000) {
  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    if (demo.simulation && demo.model && demo.policyRunner) return true;
    await sleep(100);
  }
  return !!(demo.simulation && demo.model && demo.policyRunner);
}

/**
 * `main_loop` sets `alive = false` and returns on an inference error, and
 * nothing restarts it — so one bad step would otherwise leave every remaining
 * (policy, test) cell recording nothing while this runner waits out its
 * timeouts. Bring the loop back before each test and report it.
 */
async function reviveSimLoop(demo) {
  if (demo.alive) return false;
  demo.alive = true;
  demo.main_loop();
  await sleep(100);
  return true;
}

/**
 * Wait for the sequence to finish, judged by *progress* rather than wall-clock.
 * The sim steps well below real time (WASM + ONNX inference), so a fixed
 * multiple of the test duration silently truncated long tests midway; only a
 * stalled clock — the sim loop stopped stepping — ends the wait early.
 */
async function waitForTestCompletion(duration, { stallMs = 8000, hardCapMs = 20 * 60 * 1000 } = {}) {
  const start = now();
  let lastT = -1;
  let lastProgressAt = now();
  while (now() - start < hardCapMs) {
    const status = commandSequencer.getStatus();
    if (status.mode !== 'playing') return { reason: 'finished' };
    if (Number.isFinite(status.t)) {
      if (duration > 0 && status.t >= duration) return { reason: 'finished' };
      if (status.t > lastT + 1e-9) {
        lastT = status.t;
        lastProgressAt = now();
      } else if (now() - lastProgressAt > stallMs) {
        return { reason: 'stalled', at: lastT };
      }
    }
    await sleep(50);
  }
  return { reason: 'timeout', at: lastT };
}

export async function runBenchmark({ demo, component, policies, tests, onProgress }) {
  const policyList = Array.isArray(policies) ? policies : [];
  const testList = Array.isArray(tests) ? tests : [];
  const results = [];

  const total = policyList.length * testList.length;
  let done = 0;

  const prevPaused = demo?.params?.paused;
  let activeRecorder = null;

  try {
    for (let policyIndex = 0; policyIndex < policyList.length; policyIndex++) {
      const policy = policyList[policyIndex];

      // A checkpoint whose observation layout doesn't match the base config
      // fails here; record it and keep sweeping the remaining policies.
      try {
        await demo.reloadPolicy(policy.configPath, { onnxPath: policy.onnxPath });
        const ready = await waitForPolicyReady(demo, 10000);
        if (!ready) throw new Error('policy did not become ready within 10s');
      } catch (error) {
        const message = error?.message || String(error);
        for (const test of testList) {
          results.push({
            policyId: policy.id,
            testFile: test.file,
            error: `Could not load policy: ${message}`,
            metrics: null,
          });
          done += 1;
          onProgress?.({
            policyIndex,
            testIndex: testList.indexOf(test),
            done,
            total,
            label: policy.label + ' — load failed',
          });
        }
        continue;
      }
      commandSequencer.bindSim(demo);

      for (let testIndex = 0; testIndex < testList.length; testIndex++) {
        const test = testList[testIndex];
        let recorder = null;
        let prevFootFriction = null;

        // A misconfigured test (unresolvable target body, no matching foot
        // geoms, etc.) now throws loudly from setFootFriction/getBodyMass
        // instead of silently corrupting the result — caught here so one bad
        // test file fails just that row of the report, the same way a
        // policy-load failure above fails just that policy's rows, rather
        // than aborting the whole sweep.
        try {
          const revived = await reviveSimLoop(demo);
          demo.resetSimulation();
          demo.drainBodyResolutionWarnings?.(); // discard anything left over from a prior test
          const { warning: loadWarning } = commandSequencer.loadSequence(test.sequence, test.name);

          // Optional per-test ground-grip override (see MuJoCoDemo.setFootFriction) —
          // a test authors a `footFriction` number (the sliding-friction
          // coefficient) at the sequence's top level to stress locomotion on a
          // slicker or grippier floor than the scene's default.
          const footFrictionOverride = Number(test.sequence?.footFriction);
          prevFootFriction = Number.isFinite(footFrictionOverride)
            ? demo.setFootFriction?.(footFrictionOverride)
            : null;

          const dt = (demo.timestep || 0.002) * (demo.decimation || 10) || 0.02;
          const samples = [];
          const captureState = {
            dt, index: 0, prevActions: null, expectedPosition: null, expectedHeading: 0,
          };
          recorder = {
            captureFrame() {
              samples.push(buildSample(demo, component, captureState));
            },
          };
          activeRecorder = recorder;
          demo.__simMetricsRecorders.add(recorder);

          if (demo.params) demo.params.paused = false;
          commandSequencer.play();

          const completion = await waitForTestCompletion(test.sequence?.duration || 0);

          demo.__simMetricsRecorders.delete(recorder);
          activeRecorder = null;
          recorder = null;
          commandSequencer.stop({ zero: true });
          if (prevFootFriction) demo.restoreFootFriction?.(prevFootFriction);
          prevFootFriction = null;

          // Push events carry Newtons, not a velocity change — the resistance
          // metric (metrics.js) needs each event's target-body mass to derive
          // an expected dV to normalize against. Keyed by targetBody name,
          // with '' standing in for the default (pelvis).
          const massByBody = {};
          for (const ev of test.sequence?.events || []) {
            if (ev?.type !== 'push') continue;
            const key = ev.targetBody || '';
            if (!(key in massByBody)) massByBody[key] = demo.getBodyMass(ev.targetBody);
          }

          const metrics = computeMetrics(samples, {
            dt,
            jointNames: demo.policyRunner?.policyJointNames || demo.policyJointNames || [],
            sequence: test.sequence,
            massByBody,
          });

          // A capture far short of duration/dt means the sim stopped stepping
          // mid-test; the metrics are real but cover only part of the test, so
          // say so rather than letting a near-empty chart look like a plot bug.
          const duration = test.sequence?.duration || 0;
          const expectedFrames = duration > 0 ? Math.round(duration / dt) : 0;
          const warnings = [];
          if (loadWarning) warnings.push(loadWarning);
          if (revived) warnings.push('sim loop was restarted before this test');
          if (completion.reason === 'stalled') warnings.push('sim stopped stepping mid-test');
          if (completion.reason === 'timeout') warnings.push('test hit the 20-minute cap');
          if (expectedFrames && samples.length < expectedFrames * 0.9) {
            warnings.push(`${(samples.length * dt).toFixed(1)}s of ${duration}s captured`);
          }
          if (!demo.alive) warnings.push('sim loop died (see console for an inference error)');
          // A push event's targetBody that didn't resolve (see main.js's
          // resolveBodyId) is silent to the naked eye — the test still runs
          // and "completes" — so it has to surface here instead, or it's
          // only findable by reading the raw browser console.
          warnings.push(...(demo.drainBodyResolutionWarnings?.() || []));

          results.push({
            policyId: policy.id,
            testFile: test.file,
            frames: samples.length,
            expectedFrames,
            warning: warnings.length ? warnings.join('; ') : null,
            metrics,
          });
        } catch (error) {
          results.push({
            policyId: policy.id,
            testFile: test.file,
            error: error?.message || String(error),
            metrics: null,
          });
        } finally {
          if (recorder && demo?.__simMetricsRecorders) {
            demo.__simMetricsRecorders.delete(recorder);
            if (activeRecorder === recorder) activeRecorder = null;
          }
          if (prevFootFriction) demo.restoreFootFriction?.(prevFootFriction);
          commandSequencer.stop({ zero: true });
        }

        done += 1;
        onProgress?.({
          policyIndex,
          testIndex,
          done,
          total,
          label: policy.label + ' / ' + test.name,
        });
      }
    }
  } finally {
    if (activeRecorder && demo?.__simMetricsRecorders) {
      demo.__simMetricsRecorders.delete(activeRecorder);
    }
    if (demo?.params) demo.params.paused = prevPaused;
  }

  // The run carries its own inputs — the policy identities and the full command
  // sequence of every test — so a saved run (and the HTML report built from it)
  // is readable without the repo it came from.
  return {
    generatedAt: new Date().toISOString(),
    policies: policyList.map((p) => ({
      id: p.id,
      label: p.label,
      configPath: p.configPath,
      onnxPath: p.onnxPath ?? null,
    })),
    tests: testList.map((t) => ({
      file: t.file,
      name: t.name,
      duration: t.sequence?.duration || 0,
      sequence: t.sequence ?? null,
    })),
    results,
  };
}
