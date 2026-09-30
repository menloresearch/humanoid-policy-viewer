// Dead-reckons the "ideal" trajectory the robot would follow if it tracked the
// velocity commands perfectly (unicycle model, MuJoCo world frame), and records
// top-view traces of both the ideal path and the actual robot CoM for the
// tracking minimap. All stored values are plain numbers (never wasm heap views)
// so the UI can read them safely across sim resets/reloads.

export function yawFromQuat(w, x, y, z) {
  // Yaw about MuJoCo world +Z from a wxyz quaternion.
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export class IdealPathTracker {
  constructor({ sampleEvery = 5, maxPoints = 3000 } = {}) {
    this.x = 0;
    this.y = 0;
    this.heading = 0;
    this.comZ = 0.6; // captured at reanchor; ideal marker stays at nominal height
    this.idealTrace = []; // [{x, y}] in MuJoCo world frame
    this.actualTrace = [];
    this.sampleEvery = sampleEvery;
    this.maxPoints = maxPoints;
    this._n = 0;
  }

  reanchor(x, y, heading, comZ) {
    this.x = x;
    this.y = y;
    this.heading = heading;
    if (Number.isFinite(comZ) && comZ > 0) this.comZ = comZ;
    this.idealTrace = [];
    this.actualTrace = [];
    this._n = 0;
  }

  // Called once per stepped policy tick, after the command for this tick is set.
  // cmd = { vx, vy, wz } (body-frame velocity command); actual = { x, y } | null.
  update(cmd, dt, actual) {
    const vx = cmd?.vx ?? 0;
    const vy = cmd?.vy ?? 0;
    const wz = cmd?.wz ?? 0;
    this.heading += wz * dt;
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    this.x += (vx * c - vy * s) * dt;
    this.y += (vx * s + vy * c) * dt;

    if (this._n % this.sampleEvery === 0) {
      this._push(this.idealTrace, this.x, this.y);
      if (actual && Number.isFinite(actual.x) && Number.isFinite(actual.y)) {
        this._push(this.actualTrace, actual.x, actual.y);
      }
    }
    this._n++;
  }

  _push(trace, x, y) {
    trace.push({ x, y });
    if (trace.length > this.maxPoints) {
      trace.splice(0, trace.length - this.maxPoints);
    }
  }
}
