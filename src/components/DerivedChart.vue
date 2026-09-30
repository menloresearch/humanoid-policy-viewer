<template>
  <div class="dc-chart">
    <div class="dc-label">{{ label }}</div>
    <svg :viewBox="`0 0 ${VW} ${VH}`" preserveAspectRatio="none" class="dc-svg">
      <rect :x="padL" :y="padT" :width="plotW" :height="plotH" fill="#fafafa" stroke="#e0e0e0" />

      <!-- zero line -->
      <line :x1="padL" :x2="VW - padR" :y1="vToY(0)" :y2="vToY(0)" stroke="#e0e0e0" stroke-width="0.75" />

      <!-- momentum: two step paths -->
      <template v-if="kind === 'momentum'">
        <path :d="stepPath('x')" stroke="#1976D2" stroke-width="1.5" fill="none" />
        <path :d="stepPath('y')" stroke="#E69F00" stroke-width="1.5" fill="none" />
      </template>

      <!-- impulse: stacked per-axis bars at each transition -->
      <template v-else>
        <g v-for="(bar, i) in impulseBars" :key="i">
          <rect :x="tToX(bar.t) - 3" :width="6" :y="vToY(bar.ax)" :height="Math.max(0, vToY(0) - vToY(bar.ax))" fill="#1976D2" />
          <rect :x="tToX(bar.t) - 3" :width="6" :y="vToY(bar.ax + bar.ay)" :height="Math.max(0, vToY(bar.ax) - vToY(bar.ax + bar.ay))" fill="#E69F00" />
        </g>
      </template>

      <!-- y ticks -->
      <text :x="padL - 6" :y="vToY(yMax) + 3" text-anchor="end" class="dc-tick">{{ yMax.toFixed(0) }}</text>
      <text :x="padL - 6" :y="vToY(kind === 'impulse' ? 0 : yMin) + 3" text-anchor="end" class="dc-tick">{{ (kind === 'impulse' ? 0 : yMin).toFixed(0) }}</text>
      <text :x="padL - 6" :y="padT + 8" text-anchor="end" class="dc-unit">{{ unit }}</text>

      <!-- legend -->
      <g class="dc-legend">
        <rect :x="padL + 4" y="4" width="8" height="3" fill="#1976D2" />
        <text :x="padL + 15" y="8" class="dc-tick">{{ kind === 'momentum' ? 'M·vx' : '|Δpx|' }}</text>
        <rect :x="padL + 60" y="4" width="8" height="3" fill="#E69F00" />
        <text :x="padL + 71" y="8" class="dc-tick">{{ kind === 'momentum' ? 'M·vy' : '|Δpy|' }}</text>
      </g>
    </svg>
  </div>
</template>

<script>
const VW = 800;
const VH = 120;

export default {
  name: 'DerivedChart',
  props: {
    kind: { type: String, required: true }, // 'momentum' | 'impulse'
    commands: { type: Array, required: true },
    duration: { type: Number, required: true },
    mass: { type: Number, default: 30 },
    vMax: { type: Number, default: 1.5 }, // largest |velocity| limit, for scaling
    label: { type: String, default: '' }
  },
  data() {
    return { VW, VH, padL: 44, padR: 40, padT: 12, padB: 18 };
  },
  computed: {
    plotW() { return VW - this.padL - this.padR; },
    plotH() { return VH - this.padT - this.padB; },
    unit() { return this.kind === 'momentum' ? 'kg·m/s' : 'kg·m/s'; },
    // Momentum extent driven by command limits (symmetric about zero).
    yMax() {
      if (this.kind === 'momentum') return this.mass * this.vMax || 1;
      // impulse: scale to the largest stacked bar
      let max = 0;
      for (const b of this.impulseBars) max = Math.max(max, b.ax + b.ay);
      return Math.max(max, this.mass * 0.5);
    },
    yMin() {
      return this.kind === 'momentum' ? -(this.mass * this.vMax || 1) : 0;
    },
    impulseBars() {
      // Per-transition momentum change magnitude, per axis, including a virtual
      // rest -> first-command transition.
      const bars = [];
      let prevVx = 0;
      let prevVy = 0;
      for (const c of this.commands) {
        const ax = this.mass * Math.abs((c.vx ?? 0) - prevVx);
        const ay = this.mass * Math.abs((c.vy ?? 0) - prevVy);
        if (ax > 1e-9 || ay > 1e-9) bars.push({ t: c.t, ax, ay });
        prevVx = c.vx ?? 0;
        prevVy = c.vy ?? 0;
      }
      return bars;
    }
  },
  methods: {
    tToX(t) { return this.padL + (this.duration ? t / this.duration : 0) * this.plotW; },
    vToY(v) {
      const lo = this.yMin;
      const hi = this.yMax;
      const frac = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      return this.padT + (1 - frac) * this.plotH;
    },
    stepPath(comp) {
      // comp = 'x' or 'y'; momentum = mass * v with sequencer step semantics.
      const key = comp === 'x' ? 'vx' : 'vy';
      const cmds = this.commands;
      if (cmds.length === 0) return '';
      const m = this.mass;
      const segs = [];
      const first = cmds[0];
      let y = this.vToY(0);
      if (first.t > 0) {
        segs.push(`M ${this.tToX(0)} ${y}`);
        segs.push(`H ${this.tToX(first.t)}`);
        y = this.vToY(m * (first[key] ?? 0));
        segs.push(`V ${y}`);
      } else {
        y = this.vToY(m * (first[key] ?? 0));
        segs.push(`M ${this.tToX(first.t)} ${y}`);
      }
      for (let i = 1; i < cmds.length; i++) {
        segs.push(`H ${this.tToX(cmds[i].t)}`);
        y = this.vToY(m * (cmds[i][key] ?? 0));
        segs.push(`V ${y}`);
      }
      segs.push(`H ${this.tToX(this.duration)}`);
      return segs.join(' ');
    }
  }
};
</script>

<style scoped>
.dc-chart {
  position: relative;
  width: 100%;
}
.dc-label {
  position: absolute;
  top: 2px;
  left: 48px;
  font: 600 12px sans-serif;
  color: #555;
  pointer-events: none;
}
.dc-svg {
  width: 100%;
  height: 120px;
  display: block;
}
.dc-tick {
  font: 10px monospace;
  fill: #757575;
}
.dc-unit {
  font: 9px monospace;
  fill: #9e9e9e;
}
</style>
