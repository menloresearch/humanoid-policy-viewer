import * as THREE from 'three';
import {
  normalizeQuat,
  quatMultiply,
  quatInverse,
  quatApplyInv,
  quatToRot6d,
  clampFutureIndices
} from './utils/math.js';

class BootIndicator {
  get size() {
    return 1;
  }

  compute() {
    return new Float32Array([0.0]);
  }
}

class ComplianceFlagObs {
  get size() {
    return 3;
  }

  compute(state) {
    const enabled = state?.complianceEnabled ? 1.0 : 0.0;
    const rawThreshold = Number(state?.complianceThreshold);
    const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 0.0;
    const kp = threshold / 0.05;
    return new Float32Array([enabled, enabled * threshold, enabled * kp]);
  }
}

class RootAngVelB {
  get size() {
    return 3;
  }

  compute(state) {
    return new Float32Array(state.rootAngVel);
  }
}

class ProjectedGravityB {
  constructor() {
    this.gravity = new THREE.Vector3(0, 0, -1);
  }

  get size() {
    return 3;
  }

  compute(state) {
    const quat = state.rootQuat;
    const quatObj = new THREE.Quaternion(quat[1], quat[2], quat[3], quat[0]);
    const gravityLocal = this.gravity.clone().applyQuaternion(quatObj.clone().invert());
    return new Float32Array([gravityLocal.x, gravityLocal.y, gravityLocal.z]);
  }
}

class JointPos {
  constructor(policy, kwargs = {}) {
    const { pos_steps = [0, 1, 2, 3, 4, 8] } = kwargs;
    this.posSteps = pos_steps.slice();
    this.numJoints = policy.numActions;

    this.maxStep = Math.max(...this.posSteps);
    this.history = Array.from({ length: this.maxStep + 1 }, () => new Float32Array(this.numJoints));
  }

  get size() {
    return this.posSteps.length * this.numJoints;
  }

  reset(state) {
    const source = state?.jointPos ?? new Float32Array(this.numJoints);
    this.history[0].set(source);
    for (let i = 1; i < this.history.length; i++) {
      this.history[i].set(this.history[0]);
    }
  }

  update(state) {
    for (let i = this.history.length - 1; i > 0; i--) {
      this.history[i].set(this.history[i - 1]);
    }
    this.history[0].set(state.jointPos);
  }

  compute() {
    const out = new Float32Array(this.posSteps.length * this.numJoints);
    let offset = 0;
    for (const step of this.posSteps) {
      const idx = Math.min(step, this.history.length - 1);
      out.set(this.history[idx], offset);
      offset += this.numJoints;
    }
    return out;
  }
}

class TrackingCommandObsRaw {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
    const nFut = this.futureSteps.length;
    this.outputLength = (nFut - 1) * 3 + nFut * 6;
  }

  get size() {
    return this.outputLength;
  }

  compute(state) {
    const tracking = this.policy.tracking;
    if (!tracking || !tracking.isReady()) {
      return new Float32Array(this.outputLength);
    }

    const baseIdx = tracking.refIdx;
    const refLen = tracking.refLen;
    const indices = clampFutureIndices(baseIdx, this.futureSteps, refLen);

    const basePos = tracking.refRootPos[indices[0]];
    const baseQuat = normalizeQuat(tracking.refRootQuat[indices[0]]);

    const posDiff = [];
    for (let i = 1; i < indices.length; i++) {
      const pos = tracking.refRootPos[indices[i]];
      const diff = [pos[0] - basePos[0], pos[1] - basePos[1], pos[2] - basePos[2]];
      const diffB = quatApplyInv(baseQuat, diff);
      posDiff.push(diffB[0], diffB[1], diffB[2]);
    }

    const qCur = normalizeQuat(state.rootQuat);
    const qCurInv = quatInverse(qCur);

    const rot6d = [];
    for (let i = 0; i < indices.length; i++) {
      const refQuat = normalizeQuat(tracking.refRootQuat[indices[i]]);
      const rel = quatMultiply(qCurInv, refQuat);
      const r6 = quatToRot6d(rel);
      rot6d.push(r6[0], r6[1], r6[2], r6[3], r6[4], r6[5]);
    }

    return Float32Array.from([...posDiff, ...rot6d]);
  }
}

class TargetRootZObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    return this.futureSteps.length;
  }

  compute() {
    const tracking = this.policy.tracking;
    if (!tracking || !tracking.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const out = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      out[i] = tracking.refRootPos[indices[i]][2] + 0.035;
    }
    return out;
  }
}

class TargetJointPosObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    const nJoints = this.policy.tracking?.nJoints ?? 0;
    return this.futureSteps.length * nJoints * 2;
  }

  compute(state) {
    const tracking = this.policy.tracking;
    if (!tracking || !tracking.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const out = new Float32Array(indices.length * tracking.nJoints);
    const outDiff = new Float32Array(indices.length * tracking.nJoints);
    const current = state?.jointPos ?? new Float32Array(tracking.nJoints);
    let offset = 0;
    for (const idx of indices) {
      const target = tracking.refJointPos[idx];
      out.set(target, offset);
      for (let j = 0; j < tracking.nJoints; j++) {
        outDiff[offset + j] = target[j] - (current[j] ?? 0.0);
      }
      offset += tracking.nJoints;
    }
    const merged = new Float32Array(out.length + outDiff.length);
    merged.set(out, 0);
    merged.set(outDiff, out.length);
    return merged;
  }
}

class TargetProjectedGravityBObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    return this.futureSteps.length * 3;
  }

  compute() {
    const tracking = this.policy.tracking;
    if (!tracking || !tracking.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const out = new Float32Array(indices.length * 3);
    const g = [0.0, 0.0, -1.0];
    let offset = 0;
    for (const idx of indices) {
      const quat = normalizeQuat(tracking.refRootQuat[idx]);
      const gLocal = quatApplyInv(quat, g);
      out[offset++] = gLocal[0];
      out[offset++] = gLocal[1];
      out[offset++] = gLocal[2];
    }
    return out;
  }
}


class PrevActions {
  /**
   * 
   * @param {mujoco.Model} model 
   * @param {mujoco.Simulation} simulation 
   * @param {MuJoCoDemo} demo
   * @param {number} steps 
   */
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    const { history_steps = 4 } = kwargs;
    this.steps = Math.max(1, Math.floor(history_steps));
    this.numActions = policy.numActions;
    this.actionBuffer = Array.from({ length: this.steps }, () => new Float32Array(this.numActions));
  }

  /**
   * 
   * @param {dict} extra_info
   * @returns {Float32Array}
   */
  compute() {
    const flattened = new Float32Array(this.steps * this.numActions);
    for (let i = 0; i < this.steps; i++) {
      for (let j = 0; j < this.numActions; j++) {
        flattened[i * this.numActions + j] = this.actionBuffer[i][j];
      }
    }
    return flattened;
  }

  reset() {
    for (const buffer of this.actionBuffer) {
      buffer.fill(0.0);
    }
  }

  update() {
    for (let i = this.actionBuffer.length - 1; i > 0; i--) {
      this.actionBuffer[i].set(this.actionBuffer[i - 1]);
    }
    const source = this.policy?.lastActions ?? new Float32Array(this.numActions);
    this.actionBuffer[0].set(source);
  }

  get size() {
    return this.steps * this.numActions;
  }
}


// ==================== Asimov Observation Helpers ====================

/**
 * Global velocity command state for Asimov.
 * Updated by the UI sliders.
 */
export const asimovCommandState = {
  vx: 0.0,
  vy: 0.0,
  wz: 0.0
};

/**
 * Global interrupt-mask state. 0 = policy controls upper body (arm outputs
 * used). 1 = arms driven externally (teleop / CAN-garbage fallback); arm
 * outputs from the policy should be ignored by firmware.
 */
export const asimovInterruptState = {
  active: 0
};

/**
 * Global IMU bias state for simulating miscalibrated IMU.
 * Adds constant offset to projected gravity observation ONLY (not physics).
 */
export const imuBiasState = {
  x: 0.0,
  y: 0.0
};

class AsimovAngVel {
  get size() {
    return 3;
  }

  compute(state) {
    const v = state.rootAngVel;
    const s = 0.25; // match training obs scale
    return new Float32Array([v[0] * s, v[1] * s, v[2] * s]);
  }
}

class AsimovProjectedGravity {
  constructor() {
    this.gravity = new THREE.Vector3(0, 0, -1);
  }

  get size() {
    return 3;
  }

  compute(state) {
    const quat = state.rootQuat;
    const quatObj = new THREE.Quaternion(quat[1], quat[2], quat[3], quat[0]);
    const gravityLocal = this.gravity.clone().applyQuaternion(quatObj.clone().invert());
    return new Float32Array([
      gravityLocal.x + imuBiasState.x,
      gravityLocal.y + imuBiasState.y,
      gravityLocal.z
    ]);
  }
}

class AsimovCommand {
  get size() {
    return 3;
  }

  compute() {
    return new Float32Array([
      asimovCommandState.vx,
      asimovCommandState.vy,
      asimovCommandState.wz
    ]);
  }
}

class AsimovGaitClock {
  constructor(_policy, kwargs = {}) {
    this.phase = 0.0;
    // Cadence scales with commanded planar speed (matches training
    // velocity_command.py: eff_freq = gait_freq_base + gait_freq_speed_scale * |v_xy|).
    this.gaitFreqBase = 0.5;
    this.gaitFreqSpeedScale = 1.5;
    this.threshold = 0.1;
    // zero_at_rest: if true, the clock is DISABLED at v≈0 (returns [0,0] and
    // resets phase) — matches policies trained with the v=0 gait-clock disable.
    // Default false = legacy frozen-phase behavior (e.g. model_4100/sphere).
    this.zeroAtRest = kwargs.zero_at_rest ?? false;
  }

  get size() {
    return 2;
  }

  compute() {
    // Match training velocity_command.py UniformVelocityCommand:
    // - cmd_magnitude = norm(vx, vy) + |wz|  (L2 of xy + L1 of z)
    // - phase advances by step_dt * eff_freq when above threshold
    // - eff_freq = base + speed_scale * norm(vx, vy)
    const planar = Math.sqrt(
      asimovCommandState.vx ** 2 + asimovCommandState.vy ** 2
    );
    const cmdMag = planar + Math.abs(asimovCommandState.wz);
    if (cmdMag > this.threshold) {
      const effFreq = this.gaitFreqBase + this.gaitFreqSpeedScale * planar;
      this.phase = (this.phase + (1.0 / 50.0) * effFreq) % 1.0;
    } else if (this.zeroAtRest) {
      // v=0 disable: reset phase and emit [0,0] (clean "no gait → stand").
      this.phase = 0.0;
      return new Float32Array([0.0, 0.0]);
    }
    // else (legacy): phase frozen at current value.
    const p = 2.0 * Math.PI * this.phase;
    return new Float32Array([Math.cos(p), Math.sin(p)]);
  }
}

class AsimovJointPosSlot {
  constructor(policy, kwargs = {}) {
    this.indices = kwargs.indices ?? [];
    this.policy = policy;
  }

  get size() {
    return this.indices.length;
  }

  compute(state) {
    const defaultPos = this.policy.defaultJointPos;
    const out = new Float32Array(this.indices.length);
    for (let i = 0; i < this.indices.length; i++) {
      const idx = this.indices[i];
      out[i] = (state.jointPos[idx] ?? 0) - (defaultPos[idx] ?? 0);
    }
    return out;
  }
}

class AsimovJointVelSlot {
  constructor(policy, kwargs = {}) {
    this.indices = kwargs.indices ?? [];
    this.scale = kwargs.scale ?? 0.1; // default 0.1 (legs-only); v147+ uses 1.0
  }

  get size() {
    return this.indices.length;
  }

  compute(state) {
    const out = new Float32Array(this.indices.length);
    for (let i = 0; i < this.indices.length; i++) {
      const idx = this.indices[i];
      out[i] = (state.jointVel[idx] ?? 0) * this.scale;
    }
    return out;
  }
}

class AsimovPrevActions {
  constructor(policy) {
    this.policy = policy;
    this.numActions = policy.numActions;
  }

  get size() {
    return this.numActions;
  }

  reset() {}

  compute() {
    const src = this.policy.lastActions ?? new Float32Array(this.numActions);
    return new Float32Array(src);
  }
}

/**
 * Interrupt mask flag. Reads from `policy.interruptMask` (0 or 1).
 * 0 = policy controls upper body (arm outputs used).
 * 1 = upper body externally driven (teleop/held at default); policy outputs
 *     for arms are ignored by downstream firmware.
 * UI provides a toggle that writes policy.interruptMask.
 */
class AsimovInterruptMask {
  get size() {
    return 1;
  }

  reset() {}

  compute() {
    const out = new Float32Array(1);
    out[0] = asimovInterruptState.active ? 1.0 : 0.0;
    return out;
  }
}

// Export a dictionary of all observation classes
export const Observations = {
  PrevActions,
  BootIndicator,
  ComplianceFlagObs,
  RootAngVelB,
  ProjectedGravityB,
  JointPos,
  TrackingCommandObsRaw,
  TargetRootZObs,
  TargetJointPosObs,
  TargetProjectedGravityBObs,
  AsimovAngVel,
  AsimovProjectedGravity,
  AsimovGaitClock,
  AsimovCommand,
  AsimovJointPosSlot,
  AsimovJointVelSlot,
  AsimovPrevActions,
  AsimovInterruptMask
};
