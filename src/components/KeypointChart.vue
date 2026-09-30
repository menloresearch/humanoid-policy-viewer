<template>
  <div class="kp-chart">
    <div class="kp-label" :style="{ color }">{{ label }}</div>
    <svg
      ref="svg"
      class="kp-svg"
      :viewBox="`0 0 ${VW} ${VH}`"
      preserveAspectRatio="none"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
    >
      <!-- plot background -->
      <rect
        :x="padL" :y="padT"
        :width="plotW" :height="plotH"
        fill="#fafafa" stroke="#e0e0e0"
        @pointerdown.stop="onBackgroundAdd"
      />

      <!-- limit + zero lines -->
      <line :x1="padL" :x2="VW - padR" :y1="vToY(limits[1])" :y2="vToY(limits[1])"
            stroke="#bdbdbd" stroke-dasharray="4 3" stroke-width="0.75" />
      <line :x1="padL" :x2="VW - padR" :y1="vToY(limits[0])" :y2="vToY(limits[0])"
            stroke="#bdbdbd" stroke-dasharray="4 3" stroke-width="0.75" />
      <line v-if="limits[0] < 0 && limits[1] > 0"
            :x1="padL" :x2="VW - padR" :y1="vToY(0)" :y2="vToY(0)"
            stroke="#e0e0e0" stroke-width="0.75" />

      <!-- per-value horizontal guide lines (update live while dragging) -->
      <g v-for="g in valueGuides" :key="'g' + g.v">
        <line :x1="padL" :x2="VW - padR" :y1="g.y" :y2="g.y"
              stroke="#9e9e9e" stroke-dasharray="2 3" stroke-width="0.5" opacity="0.7" />
        <text :x="VW - padR + 3" :y="g.y + 3" class="kp-vtick" :fill="color">{{ g.v.toFixed(2) }}</text>
      </g>

      <!-- step curve -->
      <path :d="pathD" :stroke="color" stroke-width="1.5" fill="none" />

      <!-- keypoints -->
      <g v-for="(pt, i) in points" :key="i">
        <circle
          :cx="pt.x" :cy="pt.y" r="5"
          :fill="color" stroke="#fff" stroke-width="1.5"
          class="kp-handle"
          @pointerdown.stop="onPointerDown($event, i)"
          @contextmenu.prevent.stop="$emit('delete-point', i)"
        />
      </g>

      <!-- axis labels -->
      <text :x="padL - 6" :y="vToY(limits[1]) + 3" text-anchor="end" class="kp-tick">{{ limits[1] }}</text>
      <text :x="padL - 6" :y="vToY(limits[0]) + 3" text-anchor="end" class="kp-tick">{{ limits[0] }}</text>
      <template v-if="showTimeLabels">
        <text v-for="tick in timeTicks" :key="'t' + tick"
              :x="tToX(tick)" :y="VH - 5" text-anchor="middle" class="kp-tick">{{ tick }}</text>
      </template>
    </svg>
  </div>
</template>

<script>
import { clamp as clampShared } from './clamp.js';

const VW = 800;
const VH = 150;
const T_SNAP = 0.1;
const V_SNAP = 0.05;

export default {
  name: 'KeypointChart',
  props: {
    commands: { type: Array, required: true },
    axis: { type: String, required: true }, // 'vx' | 'vy' | 'wz'
    duration: { type: Number, required: true },
    limits: { type: Array, required: true }, // [min, max]
    color: { type: String, default: '#1976D2' },
    label: { type: String, default: '' },
    showTimeLabels: { type: Boolean, default: false }
  },
  emits: ['move-point', 'add-point', 'delete-point'],
  data() {
    return { VW, VH, padL: 44, padR: 40, padT: 12, padB: 22, dragIndex: -1 };
  },
  computed: {
    plotW() { return VW - this.padL - this.padR; },
    plotH() { return VH - this.padT - this.padB; },
    domain() {
      const [min, max] = this.limits;
      const pad = (max - min) * 0.12 || 0.1;
      return [min - pad, max + pad];
    },
    points() {
      return this.commands.map((c) => ({
        x: this.tToX(c.t),
        y: this.vToY(c[this.axis] ?? 0)
      }));
    },
    valueGuides() {
      // One horizontal guide per distinct keypoint value on this axis
      const seen = new Set();
      const out = [];
      for (const c of this.commands) {
        const v = Math.round((c[this.axis] ?? 0) * 1000) / 1000;
        const key = v.toFixed(3);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ v, y: this.vToY(v) });
      }
      return out;
    },
    pathD() {
      // Sequencer semantics: value is 0 until the first keypoint, then holds
      // each keypoint's value to the next, and holds the last value to duration.
      const cmds = this.commands;
      if (cmds.length === 0) return '';
      const segs = [];
      const first = cmds[0];
      let y = this.vToY(0);
      if (first.t > 0) {
        segs.push(`M ${this.tToX(0)} ${y}`);
        segs.push(`H ${this.tToX(first.t)}`);
        y = this.vToY(first[this.axis] ?? 0);
        segs.push(`V ${y}`);
      } else {
        y = this.vToY(first[this.axis] ?? 0);
        segs.push(`M ${this.tToX(first.t)} ${y}`);
      }
      for (let i = 1; i < cmds.length; i++) {
        segs.push(`H ${this.tToX(cmds[i].t)}`);
        y = this.vToY(cmds[i][this.axis] ?? 0);
        segs.push(`V ${y}`);
      }
      segs.push(`H ${this.tToX(this.duration)}`);
      return segs.join(' ');
    },
    timeTicks() {
      const dur = this.duration;
      const step = dur <= 20 ? 2 : dur <= 60 ? 10 : dur <= 200 ? 30 : 100;
      const ticks = [];
      for (let t = 0; t <= dur + 1e-6; t += step) ticks.push(Math.round(t));
      return ticks;
    }
  },
  methods: {
    tToX(t) { return this.padL + (this.duration ? t / this.duration : 0) * this.plotW; },
    vToY(v) {
      const [lo, hi] = this.domain;
      const frac = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      return this.padT + (1 - frac) * this.plotH;
    },
    xToT(px) { return this.duration ? ((px - this.padL) / this.plotW) * this.duration : 0; },
    yToV(py) {
      const [lo, hi] = this.domain;
      const frac = 1 - (py - this.padT) / this.plotH;
      return lo + frac * (hi - lo);
    },
    eventToData(event) {
      const rect = this.$refs.svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * VW;
      const py = ((event.clientY - rect.top) / rect.height) * VH;
      return { t: this.xToT(px), v: this.yToV(py) };
    },
    snapT(t) { return Math.round(t / T_SNAP) * T_SNAP; },
    snapV(v) { return Math.round(v / V_SNAP) * V_SNAP; },
    clamp(v, lo, hi) { return clampShared(v, lo, hi); },
    onPointerDown(event, index) {
      this.dragIndex = index;
      event.target.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      if (this.dragIndex < 0) return;
      const i = this.dragIndex;
      const { t, v } = this.eventToData(event);
      const prevT = i > 0 ? this.commands[i - 1].t : 0;
      const nextT = i < this.commands.length - 1 ? this.commands[i + 1].t : this.duration;
      const lowT = i > 0 ? prevT + T_SNAP : 0;
      const highT = i < this.commands.length - 1 ? nextT - T_SNAP : this.duration;
      const newT = this.clamp(this.snapT(t), lowT, Math.max(lowT, highT));
      const newV = this.clamp(this.snapV(v), this.limits[0], this.limits[1]);
      this.$emit('move-point', i, Math.round(newT * 1000) / 1000, Math.round(newV * 1000) / 1000);
    },
    onPointerUp() {
      // Pointer capture is released implicitly on pointerup; just end the drag.
      this.dragIndex = -1;
    },
    onBackgroundAdd(event) {
      const { t, v } = this.eventToData(event);
      const newT = this.clamp(this.snapT(t), 0, this.duration);
      const newV = this.clamp(this.snapV(v), this.limits[0], this.limits[1]);
      this.$emit('add-point', Math.round(newT * 1000) / 1000, Math.round(newV * 1000) / 1000);
    }
  }
};
</script>

<style scoped>
.kp-chart {
  position: relative;
  width: 100%;
}
.kp-label {
  position: absolute;
  top: 2px;
  left: 48px;
  font: 600 12px sans-serif;
  pointer-events: none;
}
.kp-svg {
  width: 100%;
  height: 150px;
  display: block;
  touch-action: none;
}
.kp-handle {
  cursor: grab;
}
.kp-handle:active {
  cursor: grabbing;
}
.kp-tick {
  font: 10px monospace;
  fill: #757575;
}
.kp-vtick {
  font: 9px monospace;
}
</style>
