import { asimovCommandState } from './observationHelpers.js';

// Mirror the velocity command slider ranges in Demo.vue.
// wz was narrowed from the original ±1.5 rad/s to ±0.8 to match the policy's
// actual trained/actuator-derived yaw-rate range (see commit 741415e).
export const COMMAND_LIMITS = {
  vx: [-1.5, 1.5],
  vy: [-1.5, 1.5],
  wz: [-0.8, 0.8]
};

// Absolute safety bound so an editable/typed limit can't produce absurd commands
export const MAX_ABS_LIMIT = 20;

let activeCommandLimits = null;

// Set by mujocoUtils.js reloadPolicy() when the current checkpoint's env.yaml
// declares its own trained command range (commands.twist.ranges) — overrides
// COMMAND_LIMITS for that checkpoint's resolveLimits() fallback, rather than
// clamping every checkpoint against whichever one checkpoint COMMAND_LIMITS
// was last hand-tuned for. Pass null to fall back to COMMAND_LIMITS (a
// checkpoint whose env.yaml doesn't declare a command range, or no checkpoint
// loaded yet).
export function setActiveCommandLimits(limits) {
  activeCommandLimits = limits && typeof limits === 'object' ? limits : null;
}

// Resolve per-sequence command limits. A sequence may carry its own
// `limits: { vx:[min,max], vy:[...], wz:[...] }`, which always wins. Falling
// back to the currently active checkpoint's trained command range only makes
// sense while actually playing/recording a sequence against that live
// checkpoint (the default, useActive: true) — a report/comparison view isn't
// tied to whatever happens to be loaded live in the 3D viewer at the moment
// someone's looking at it, so it should pass useActive: false to fall back to
// the fixed COMMAND_LIMITS instead (see BenchmarkResults.vue).
export function resolveLimits(parsed, { useActive = true } = {}) {
  const src = parsed && typeof parsed.limits === 'object' && parsed.limits ? parsed.limits : {};
  const out = {};
  for (const axis of ['vx', 'vy', 'wz']) {
    let [lo, hi] = (useActive && activeCommandLimits?.[axis]) || COMMAND_LIMITS[axis];
    const pair = src[axis];
    if (Array.isArray(pair) && pair.length === 2) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
        lo = Math.max(-MAX_ABS_LIMIT, a);
        hi = Math.min(MAX_ABS_LIMIT, b);
      }
    }
    out[axis] = [lo, hi];
  }
  return out;
}

export const DEMO_SEQUENCE = {
  name: 'demo',
  duration: 10.0,
  commands: [
    { t: 0.0, vx: 0.0, vy: 0.0, wz: 0.0 },
    { t: 1.0, vx: 0.8, vy: 0.0, wz: 0.0 },
    { t: 4.0, vx: 0.8, vy: 0.0, wz: 0.4 },
    { t: 6.0, vx: 0.0, vy: 0.4, wz: 0.0 },
    { t: 8.0, vx: 0.0, vy: 0.0, wz: 0.0 }
  ]
};

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max);
}

function zeroCommands() {
  asimovCommandState.vx = 0.0;
  asimovCommandState.vy = 0.0;
  asimovCommandState.wz = 0.0;
}

/**
 * Plays back / records keypoint-hold velocity command sequences by writing
 * asimovCommandState once per policy tick. Module-level singleton (like
 * asimovCommandState) so it survives policy switches that restart main_loop.
 *
 * Sequence format: { name, duration, commands: [{t, vx, vy, wz}, ...] };
 * each command applies at sim-time t and holds until the next keypoint.
 */
export const commandSequencer = {
  mode: 'idle', // 'idle' | 'playing' | 'recording'
  t: 0,
  loop: false,
  sequence: null,
  lastRecording: null,
  _recording: null,
  _playIdx: 0,
  events: [],
  _eventIdx: 0,
  sim: null, // the full MuJoCoDemo instance (not just its .simulation) — push
             // events need model.body_subtreemass and demo.applyScriptedPush()

  bindSim(sim) {
    this.sim = sim ?? null;
  },

  loadSequence(parsed, fallbackName = 'sequence') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Sequence must be a JSON object with a "commands" array');
    }
    if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      throw new Error('Sequence "commands" must be a non-empty array');
    }

    const limits = resolveLimits(parsed);
    let clampedCount = 0;
    const commands = parsed.commands.map((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Command ${i} is not an object`);
      }
      const t = Number(entry.t);
      if (!Number.isFinite(t) || t < 0) {
        throw new Error(`Command ${i} has invalid "t" (must be a finite number >= 0)`);
      }
      const cmd = { t: Math.round(t * 1000) / 1000 };
      for (const axis of ['vx', 'vy', 'wz']) {
        const raw = entry[axis] === undefined ? 0 : Number(entry[axis]);
        if (!Number.isFinite(raw)) {
          throw new Error(`Command ${i} has invalid "${axis}" (must be a finite number)`);
        }
        const clamped = clamp(raw, limits[axis]);
        if (clamped !== raw) clampedCount++;
        // Round to 3 decimals to strip floating-point snap noise (e.g. 0.8500000000000001)
        cmd[axis] = Math.round(clamped * 1000) / 1000;
      }
      return cmd;
    });

    commands.sort((a, b) => a.t - b.t);
    const deduped = [];
    for (const cmd of commands) {
      if (deduped.length > 0 && deduped[deduped.length - 1].t === cmd.t) {
        deduped[deduped.length - 1] = cmd;
      } else {
        deduped.push(cmd);
      }
    }

    const lastT = deduped[deduped.length - 1].t;
    const rawDuration = Number(parsed.duration);
    const duration = Number.isFinite(rawDuration) && rawDuration >= lastT
      ? rawDuration
      : lastT + 2.0;
    if (duration <= 0) {
      throw new Error('Sequence duration must be > 0');
    }

    // Optional timed push events — real forces (Newtons) through the
    // robot's own CoM, held for a duration.
    const events = [];
    if (parsed.events !== undefined) {
      if (!Array.isArray(parsed.events)) {
        throw new Error('Sequence "events" must be an array');
      }
      parsed.events.forEach((ev, i) => {
        if (!ev || typeof ev !== 'object') {
          throw new Error(`Event ${i} is not an object`);
        }
        const t = Number(ev.t);
        if (!Number.isFinite(t) || t < 0) {
          throw new Error(`Event ${i} has invalid "t" (must be a finite number >= 0)`);
        }
        if (ev.type !== 'push') {
          throw new Error(`Event ${i} has unsupported "type" (only 'push' is supported)`);
        }
        // dir accepts 2 (legacy, z=0) or 3 elements — full 3D force direction.
        if (!Array.isArray(ev.dir) || (ev.dir.length !== 2 && ev.dir.length !== 3)) {
          throw new Error(`Event ${i} has invalid "dir" (must be a 2- or 3-number array)`);
        }
        const dxyz = [Number(ev.dir[0]), Number(ev.dir[1]), Number(ev.dir[2] ?? 0)];
        if (dxyz.some((v) => !Number.isFinite(v))) {
          throw new Error(`Event ${i} has invalid "dir" (must be finite numbers)`);
        }
        if (Math.hypot(...dxyz) === 0) {
          throw new Error(`Event ${i} has invalid "dir" (must not be the zero vector)`);
        }
        const force = Number(ev.force);
        // Force is authored as a magnitude in Newtons — direction lives entirely
        // in "dir" — so a negative value here isn't "push the other way", it's
        // an authoring mistake that would otherwise silently reverse the push.
        if (!Number.isFinite(force) || force <= 0) {
          throw new Error(`Event ${i} has invalid "force" (must be a finite number > 0)`);
        }
        const duration = Number(ev.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error(`Event ${i} has invalid "duration" (must be a finite number > 0)`);
        }
        if (ev.targetBody !== undefined && (typeof ev.targetBody !== 'string' || !ev.targetBody)) {
          throw new Error(`Event ${i} has invalid "targetBody" (must be a non-empty string)`);
        }
        // Optional rotational torque, held for the same duration as the
        // force. Must be both-present or both-absent — a lone axis or a lone
        // magnitude is an authoring mistake, not something to silently patch.
        const hasTorqueAxis = ev.torqueAxis !== undefined;
        const hasTorqueMag = ev.torqueMag !== undefined;
        if (hasTorqueAxis !== hasTorqueMag) {
          throw new Error(`Event ${i} has "torqueAxis"/"torqueMag" — both must be present together`);
        }
        let torqueAxis = null;
        let torqueMag = null;
        if (hasTorqueAxis) {
          if (!Array.isArray(ev.torqueAxis) || ev.torqueAxis.length !== 3) {
            throw new Error(`Event ${i} has invalid "torqueAxis" (must be a 3-number array)`);
          }
          torqueAxis = [Number(ev.torqueAxis[0]), Number(ev.torqueAxis[1]), Number(ev.torqueAxis[2])];
          if (torqueAxis.some((v) => !Number.isFinite(v))) {
            throw new Error(`Event ${i} has invalid "torqueAxis" (must be finite numbers)`);
          }
          torqueMag = Number(ev.torqueMag);
          if (!Number.isFinite(torqueMag)) {
            throw new Error(`Event ${i} has invalid "torqueMag" (must be a finite number)`);
          }
        }
        const r3 = (v) => Math.round(v * 1000) / 1000;
        const clean = {
          t: r3(t),
          type: 'push',
          dir: dxyz.map(r3),
          force: r3(force),
          duration: r3(duration)
        };
        if (torqueAxis) {
          clean.torqueAxis = torqueAxis.map(r3);
          clean.torqueMag = r3(torqueMag);
        }
        // Which body the force/torque applies to (default: pelvis) — see
        // MuJoCoDemo.resolveBodyId()/applyScriptedPush().
        if (ev.targetBody !== undefined) clean.targetBody = ev.targetBody;
        events.push(clean);
      });
      events.sort((a, b) => a.t - b.t);
    }

    if (this.mode === 'playing') {
      this.stop({ zero: true });
    }
    this.events = events;
    this._eventIdx = 0;
    this.sequence = {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : fallbackName,
      duration,
      limits,
      commands: deduped
    };
    this.t = 0;
    this._playIdx = 0;
    return {
      warning: clampedCount > 0
        ? `${clampedCount} command value(s) clamped to slider range`
        : ''
    };
  },

  play() {
    if (this.mode !== 'idle' || !this.sequence) {
      return false;
    }
    this.t = 0;
    this._playIdx = 0;
    this._eventIdx = 0;
    this.mode = 'playing';
    return true;
  },

  stop({ zero = true } = {}) {
    this.mode = 'idle';
    this._recording = null;
    this._eventIdx = 0;
    if (zero) {
      zeroCommands();
    }
  },

  startRecording() {
    if (this.mode !== 'idle') {
      return false;
    }
    this.t = 0;
    this._recording = [{
      t: 0,
      vx: asimovCommandState.vx,
      vy: asimovCommandState.vy,
      wz: asimovCommandState.wz
    }];
    this.mode = 'recording';
    return true;
  },

  stopRecording() {
    if (this.mode !== 'recording') {
      return null;
    }
    this.lastRecording = {
      name: 'recorded',
      duration: Math.round(this.t * 1000) / 1000,
      commands: this._recording
    };
    this._recording = null;
    this.mode = 'idle';
    return this.lastRecording;
  },

  recordKeypoint(cmd) {
    if (this.mode !== 'recording' || !this._recording) {
      return;
    }
    const keypoint = {
      t: Math.round(this.t * 1000) / 1000,
      vx: cmd.vx,
      vy: cmd.vy,
      wz: cmd.wz
    };
    const last = this._recording[this._recording.length - 1];
    if (last && last.t === keypoint.t) {
      this._recording[this._recording.length - 1] = keypoint;
    } else {
      this._recording.push(keypoint);
    }
  },

  // Called once per stepped policy tick (dt = timestep * decimation)
  tick(dt) {
    if (this.mode === 'recording') {
      this.t += dt;
      return;
    }
    if (this.mode !== 'playing') {
      return;
    }
    if (this.t >= this.sequence.duration) {
      if (this.loop) {
        this.t = 0;
        this._playIdx = 0;
        this._eventIdx = 0;
      } else {
        this.mode = 'idle';
        zeroCommands();
        return;
      }
    }
    const commands = this.sequence.commands;
    while (this._playIdx + 1 < commands.length && commands[this._playIdx + 1].t <= this.t) {
      this._playIdx++;
    }
    const active = commands[this._playIdx];
    if (active.t <= this.t) {
      asimovCommandState.vx = active.vx;
      asimovCommandState.vy = active.vy;
      asimovCommandState.wz = active.wz;
    } else {
      zeroCommands();
    }

    // Fire any due timed push events as a real force through the robot's own
    // CoM (see MuJoCoDemo.applyScriptedPush) — same mechanism as click-to-push.
    while (
      this.mode === 'playing' &&
      this.sim &&
      this.events[this._eventIdx] &&
      this.events[this._eventIdx].t <= this.t
    ) {
      const ev = this.events[this._eventIdx];
      if (typeof this.sim.applyScriptedPush !== 'function') {
        throw new Error('commandSequencer: bound sim has no applyScriptedPush() — cannot fire scripted push event');
      }
      this.sim.applyScriptedPush(ev);
      this._eventIdx++;
    }

    this.t += dt;
  },

  // Reset / policy switch: stop playback (zeroed) or finalize an in-flight recording
  deactivate() {
    if (this.mode === 'playing') {
      this.stop({ zero: true });
    } else if (this.mode === 'recording') {
      this.stopRecording();
    }
  },

  getStatus() {
    const keypointCount = this.mode === 'recording'
      ? (this._recording?.length ?? 0)
      : (this.sequence?.commands.length ?? 0);
    return {
      mode: this.mode,
      t: this.t,
      duration: this.sequence?.duration ?? 0,
      name: this.sequence?.name ?? '',
      loop: this.loop,
      keypointCount,
      eventCount: this.events?.length ?? 0,
      hasSequence: this.sequence !== null,
      hasRecording: this.lastRecording !== null
    };
  },

  exportJson() {
    const source = this.lastRecording ?? this.sequence;
    if (!source) {
      return null;
    }
    const out = { ...source };
    if (this.events && this.events.length > 0) {
      out.events = this.events;
    }
    return JSON.stringify(out, null, 2);
  }
};
