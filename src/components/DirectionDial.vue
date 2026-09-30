<template>
  <div class="dd-wrap">
    <div class="dd-row">
      <!-- Azimuth (top-down view): free-drag anywhere in the ring, or click a
           preset dot for an exact compass value. Screen convention matches
           PushLane's timeline arrow: x-right = +x, y-up = +y. -->
      <svg
        ref="compassSvg"
        class="dd-dial"
        viewBox="0 0 64 78"
        @pointerdown="onCompassDown"
        @pointermove="onCompassMove"
        @pointerup="onCompassUp"
      >
        <circle cx="32" cy="32" r="28" fill="#fafafa" stroke="#e0e0e0" />
        <circle cx="32" cy="32" r="1" fill="#bdbdbd" />
        <line :x1="32" :y1="32" :x2="32 + compassHandle.x" :y2="32 - compassHandle.y"
              stroke="#D32F2F" stroke-width="1.5" />
        <circle
          v-for="d in AZ_PRESETS" :key="d.key"
          :cx="32 + d.dir[0] * 24" :cy="32 - d.dir[1] * 24"
          r="2.5"
          :fill="isAzPreset(d) ? '#D32F2F' : '#bdbdbd'"
          class="dd-dot"
          :title="d.label"
          @pointerdown.stop="setAzimuthDeg(d.azDeg)"
        />
        <text x="32" y="74" text-anchor="middle" class="dd-dial-caption">top view</text>
      </svg>

      <!-- Elevation (side view): a quarter-turn arc from straight down to
           straight up, passing through level on the right — dragging along a
           curved track that visibly bottoms out at +/-90 reads more like
           "how far up/down" than a linear slider with a degree number. -->
      <svg
        ref="elevSvg"
        class="dd-dial"
        viewBox="0 0 64 78"
        @pointerdown="onElevDown"
        @pointermove="onElevMove"
        @pointerup="onElevUp"
      >
        <polyline :points="elevTrackPoints" fill="none" stroke="#e0e0e0" stroke-width="2" stroke-linecap="round" />
        <circle cx="32" cy="32" r="1" fill="#bdbdbd" />
        <line :x1="32" :y1="32" :x2="elevHandle.x" :y2="elevHandle.y" stroke="#D32F2F" stroke-width="1.5" />
        <circle
          v-for="p in ELEV_PRESETS" :key="p.label"
          :cx="elevPoint(p.deg).x" :cy="elevPoint(p.deg).y"
          r="2.5"
          :fill="isElevPreset(p) ? '#D32F2F' : '#bdbdbd'"
          class="dd-dot"
          :title="p.label"
          @pointerdown.stop="setElevationDeg(p.deg)"
        />
        <circle :cx="elevHandle.x" :cy="elevHandle.y" r="3" fill="#D32F2F" stroke="#fff" stroke-width="1" />
        <text x="32" y="74" text-anchor="middle" class="dd-dial-caption">side view</text>
      </svg>
    </div>
    <div class="dd-readout">
      az {{ Math.round(azimuthDeg) }}° · elev {{ Math.round(elevationDeg) }}°
      · [{{ modelValue[0].toFixed(2) }}, {{ modelValue[1].toFixed(2) }}, {{ modelValue[2].toFixed(2) }}]
    </div>
  </div>
</template>

<script>
import { toSpherical, fromSpherical } from './direction-math.js';

// 8 quick-pick azimuth presets (elevation held), matching PushLane's original
// compass. Free-drag covers everything in between and any elevation.
const AZ_PRESETS = [
  { key: 'front', label: 'front', azDeg: 0 },
  { key: 'front-right', label: 'front-right', azDeg: -45 },
  { key: 'right', label: 'right', azDeg: -90 },
  { key: 'back-right', label: 'back-right', azDeg: -135 },
  { key: 'back', label: 'back', azDeg: 180 },
  { key: 'back-left', label: 'back-left', azDeg: 135 },
  { key: 'left', label: 'left', azDeg: 90 },
  { key: 'front-left', label: 'front-left', azDeg: 45 },
].map((p) => ({ ...p, dir: [Math.cos(p.azDeg * Math.PI / 180), Math.sin(p.azDeg * Math.PI / 180)] }));

// Quick-pick elevations along the side-view arc.
const ELEV_PRESETS = [
  { label: 'up', deg: 90 },
  { label: 'level', deg: 0 },
  { label: 'down', deg: -90 },
];

const ELEV_R = 24;

export default {
  name: 'DirectionDial',
  props: {
    // Direction as [x, y, z]. Not required to be unit length — callers
    // normalize at use time (see applyScriptedPush) — but rendered as if it
    // were, since only the angle matters here.
    modelValue: { type: Array, required: true },
  },
  emits: ['update:modelValue'],
  data() {
    return { AZ_PRESETS, ELEV_PRESETS, azDragging: false, elevDragging: false };
  },
  computed: {
    spherical() { return toSpherical(this.modelValue); },
    azimuthDeg() { return this.spherical.azDeg; },
    elevationDeg() { return this.spherical.elevDeg; },
    compassHandle() {
      // Foreshorten the compass handle by cos(elevation) so a near-vertical
      // direction visibly shrinks toward the center — a cheap way to hint at
      // the third axis on the top-down view.
      const r = 24 * Math.cos(this.elevationDeg * Math.PI / 180);
      const az = this.azimuthDeg * Math.PI / 180;
      return { x: Math.cos(az) * r, y: Math.sin(az) * r };
    },
    elevHandle() { return this.elevPoint(this.elevationDeg); },
    elevTrackPoints() {
      const pts = [];
      for (let deg = -90; deg <= 90; deg += 6) {
        const p = this.elevPoint(deg);
        pts.push(`${p.x.toFixed(2)},${p.y.toFixed(2)}`);
      }
      return pts.join(' ');
    },
  },
  methods: {
    isAzPreset(d) {
      return Math.abs(this.azimuthDeg - d.azDeg) < 1 && Math.abs(this.elevationDeg) < 1;
    },
    isElevPreset(p) {
      return Math.abs(this.elevationDeg - p.deg) < 1;
    },
    // Point on the side-view arc for a given elevation: 0° is level (right),
    // +90° is straight up, -90° is straight down.
    elevPoint(deg) {
      const rad = deg * Math.PI / 180;
      return { x: 32 + Math.cos(rad) * ELEV_R, y: 32 - Math.sin(rad) * ELEV_R };
    },
    setAzimuthDeg(azDeg) {
      this.$emit('update:modelValue', fromSpherical(azDeg, this.elevationDeg));
    },
    setElevationDeg(elevDeg) {
      const clamped = Math.min(90, Math.max(-90, Number(elevDeg)));
      this.$emit('update:modelValue', fromSpherical(this.azimuthDeg, clamped));
    },
    angleFromEvent(svgRef, event) {
      const rect = this.$refs[svgRef].getBoundingClientRect();
      const scale = 64 / rect.width;
      const px = (event.clientX - rect.left) * scale - 32;
      const py = (event.clientY - rect.top) * scale - 32;
      return Math.atan2(-py, px) * 180 / Math.PI;
    },
    onCompassDown(event) {
      this.azDragging = true;
      event.target.setPointerCapture?.(event.pointerId);
      this.setAzimuthDeg(this.angleFromEvent('compassSvg', event));
    },
    onCompassMove(event) {
      if (!this.azDragging) return;
      this.setAzimuthDeg(this.angleFromEvent('compassSvg', event));
    },
    onCompassUp() {
      this.azDragging = false;
    },
    onElevDown(event) {
      this.elevDragging = true;
      event.target.setPointerCapture?.(event.pointerId);
      this.setElevationDeg(this.angleFromEvent('elevSvg', event));
    },
    onElevMove(event) {
      if (!this.elevDragging) return;
      this.setElevationDeg(this.angleFromEvent('elevSvg', event));
    },
    onElevUp() {
      this.elevDragging = false;
    },
  },
};
</script>

<style scoped>
.dd-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 148px;
}
.dd-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dd-dial {
  width: 68px;
  height: 83px;
  flex: 0 0 auto;
  touch-action: none;
  cursor: crosshair;
}
.dd-dial-caption {
  font: 6px sans-serif;
  fill: #9e9e9e;
}
.dd-dot {
  cursor: pointer;
}
.dd-readout {
  font: 10px monospace;
  color: #757575;
  white-space: nowrap;
  margin-top: 2px;
}
</style>
