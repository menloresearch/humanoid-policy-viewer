<template>
  <div class="tp">
    <svg ref="top" class="tp-top" :viewBox="`0 0 ${W} ${TOP_H}`" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Course from above">
      <rect x="0" y="0" :width="W" :height="TOP_H" class="tp-floor" />
      <polygon v-for="(box, i) in outlines" :key="i" :points="box.points" :fill="box.fill" class="tp-box" />
      <rect
        :x="sx(-SPAWN)" :y="sy(SPAWN)" :width="sx(SPAWN) - sx(-SPAWN)" :height="sy(-SPAWN) - sy(SPAWN)"
        class="tp-spawn" :class="{ 'tp-bad': errors.length }"
      />
      <polyline :points="pathPoints" class="tp-path" />
      <g class="tp-path-end">
        <line :x1="sx(pathEnd.x) - 5" :y1="sy(pathEnd.y) - 5" :x2="sx(pathEnd.x) + 5" :y2="sy(pathEnd.y) + 5" />
        <line :x1="sx(pathEnd.x) - 5" :y1="sy(pathEnd.y) + 5" :x2="sx(pathEnd.x) + 5" :y2="sy(pathEnd.y) - 5" />
      </g>
      <g
        v-if="goal" class="tp-goal" :class="{ 'tp-dragging': drag }"
        @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag"
      >
        <circle :cx="sx(goal.x)" :cy="sy(goal.y)" :r="goalRadiusPx" />
        <text :x="sx(goal.x)" :y="sy(goal.y) + goalRadiusPx + 12" class="tp-label" text-anchor="middle">end ({{ goal.x.toFixed(2) }}, {{ goal.y.toFixed(2) }})</text>
      </g>
      <circle :cx="sx(0)" :cy="sy(0)" r="4" class="tp-robot" />
      <line :x1="sx(0)" :y1="sy(0)" :x2="sx(0.6)" :y2="sy(0)" class="tp-heading" />
      <text :x="sx(0)" :y="sy(-SPAWN) + 12" class="tp-label" text-anchor="middle">start</text>
      <text :x="W - 6" :y="TOP_H - 6" class="tp-label" text-anchor="end">{{ scaleLabel }}</text>
    </svg>
    <svg v-if="terrain" class="tp-side" :viewBox="`0 0 ${W} ${SIDE_H}`" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Course profile">
      <polygon :points="profilePoints" class="tp-profile" />
      <line :x1="sx(0)" :y1="SIDE_H - 2" :x2="sx(0)" :y2="SIDE_H - 2 - 0.63 * zScale" class="tp-robot-side" />
      <text x="6" y="12" class="tp-label">profile along the centre line · height {{ zmax.toFixed(2) }} m (×{{ exaggeration }} vertical)</text>
    </svg>
    <div v-if="goal" class="text-caption text-disabled">
      drag the end zone to move it (snaps to the end of the commanded path ✕) · hold Shift to move along one axis
    </div>
    <div v-for="e in errors" :key="'e' + e" class="text-error text-caption">{{ e }}</div>
    <div v-for="w in warnings" :key="'w' + w" class="text-warning text-caption">{{ w }}</div>
  </div>
</template>

<script>
// Top view and side profile of a test's terrain course, with the spawn area and
// the commanded path, plus the same checks `npm run benchmark` runs
// (src/benchmark/terrainCheck.js). x runs right (the robot's heading), y up.
// The end zone can be dragged; it emits update:goal with the new centre.
import { boxOutline } from '@/simulation/terrainGen.js';
import { SPAWN_CLEAR_M, goalProblems, roundGoal, terrainProblems } from '@/benchmark/terrainCheck.js';

const W = 640;
const TOP_H = 200;
const SIDE_H = 90;
const PAD = 0.4;
const SNAP_PX = 12; // a dragged end zone this close to the path's end snaps onto it

export default {
  name: 'TerrainPreview',
  props: {
    terrain: { type: Object, default: null },
    // End zone { x, y, radius_m } | null, drawn as a circle.
    goal: { type: Object, default: null },
    commands: { type: Array, default: () => [] },
    duration: { type: Number, default: 0 },
  },
  emits: ['problems', 'update:goal'],
  data() {
    // drag: { view (frozen, so the window doesn't rescale under the pointer), start pointer, start goal }
    return { W, TOP_H, SIDE_H, SPAWN: SPAWN_CLEAR_M, drag: null };
  },
  computed: {
    check() {
      return terrainProblems({ terrain: this.terrain, commands: this.commands, duration: this.duration });
    },
    errors() { return this.check.errors; },
    warnings() {
      return [...this.check.warnings, ...goalProblems({ goal: this.goal, commands: this.commands, duration: this.duration })];
    },
    built() { return this.check.terrain; },
    goalRadiusPx() {
      return this.goal ? Math.abs(this.sx(this.goal.x + this.goal.radius_m) - this.sx(this.goal.x)) : 0;
    },
    pathEnd() {
      const path = this.check.path;
      return path[path.length - 1];
    },
    zmax() { return this.built?.bounds.zmax ?? 0; },
    // World window: the course, the path and the spawn area, keeping 1:1 aspect in the top view.
    view() {
      if (this.drag) return this.drag.view;
      const xs = [-SPAWN_CLEAR_M, SPAWN_CLEAR_M, ...this.check.path.map((p) => p.x)];
      const ys = [-SPAWN_CLEAR_M, SPAWN_CLEAR_M, ...this.check.path.map((p) => p.y)];
      if (this.built) {
        xs.push(this.built.bounds.xmin, this.built.bounds.xmax);
        ys.push(this.built.bounds.ymin, this.built.bounds.ymax);
      }
      if (this.goal) {
        xs.push(this.goal.x - this.goal.radius_m, this.goal.x + this.goal.radius_m);
        ys.push(this.goal.y - this.goal.radius_m, this.goal.y + this.goal.radius_m);
      }
      let x0 = Math.min(...xs) - PAD;
      let x1 = Math.max(...xs) + PAD;
      let y0 = Math.min(...ys) - PAD;
      let y1 = Math.max(...ys) + PAD;
      const scale = Math.min(W / (x1 - x0), TOP_H / (y1 - y0));
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      x0 = cx - W / scale / 2; x1 = cx + W / scale / 2;
      y0 = cy - TOP_H / scale / 2; y1 = cy + TOP_H / scale / 2;
      return { x0, x1, y0, y1, scale };
    },
    outlines() {
      if (!this.built) return [];
      const top = this.zmax || 1;
      return this.built.boxes.map((box) => {
        const shade = Math.round(205 - 120 * Math.min(1, (box.pos[2] + box.size[2]) / top));
        return {
          points: boxOutline(box).map(([x, y]) => `${this.sx(x)},${this.sy(y)}`).join(' '),
          fill: `rgb(${shade + 30}, ${shade + 20}, ${shade})`,
        };
      });
    },
    pathPoints() {
      return this.check.path.map((p) => `${this.sx(p.x)},${this.sy(p.y)}`).join(' ');
    },
    // Side profile: exaggerated so a 5 cm step is visible next to a 6 m course.
    zScale() {
      const fit = (SIDE_H - 24) / Math.max(this.zmax, 0.63);
      return fit;
    },
    exaggeration() {
      return Math.max(1, Math.round(this.zScale / this.view.scale));
    },
    profilePoints() {
      if (!this.built) return '';
      const pts = [];
      for (let px = 0; px <= W; px += 2) {
        const x = this.view.x0 + px / this.view.scale;
        pts.push(`${px},${SIDE_H - 2 - this.built.heightAt(x, 0) * this.zScale}`);
      }
      return `0,${SIDE_H} ${pts.join(' ')} ${W},${SIDE_H}`;
    },
    scaleLabel() {
      return `${((this.view.x1 - this.view.x0)).toFixed(1)} m across`;
    },
  },
  watch: {
    check: {
      immediate: true,
      handler(check) {
        this.$emit('problems', { errors: check.errors, warnings: check.warnings });
      },
    },
  },
  methods: {
    sx(x) { return (x - this.view.x0) * this.view.scale; },
    sy(y) { return TOP_H - (y - this.view.y0) * this.view.scale; },
    // Pointer position in world metres.
    toWorld(event) {
      const svg = this.$refs.top;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const p = point.matrixTransform(svg.getScreenCTM().inverse());
      return { x: this.view.x0 + p.x / this.view.scale, y: this.view.y0 + (TOP_H - p.y) / this.view.scale };
    },
    startDrag(event) {
      event.preventDefault(); // no text selection or native drag while moving the zone
      event.currentTarget.setPointerCapture?.(event.pointerId);
      this.drag = { view: this.view, pointer: this.toWorld(event), goal: { x: this.goal.x, y: this.goal.y } };
    },
    moveDrag(event) {
      if (!this.drag) return;
      const at = this.toWorld(event);
      let dx = at.x - this.drag.pointer.x;
      let dy = at.y - this.drag.pointer.y;
      // Shift: move along whichever axis the pointer has moved further on.
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let x = this.drag.goal.x + dx;
      let y = this.drag.goal.y + dy;
      const end = this.pathEnd;
      const near = Math.hypot(this.sx(x) - this.sx(end.x), this.sy(y) - this.sy(end.y)) <= SNAP_PX;
      if (near && !event.shiftKey) {
        x = end.x;
        y = end.y;
      }
      this.$emit('update:goal', { ...this.goal, x: roundGoal(x), y: roundGoal(y) });
    },
    endDrag() {
      this.drag = null;
    },
  },
};
</script>

<style scoped>
.tp { display: flex; flex-direction: column; gap: 4px; max-width: 760px; }
.tp-top, .tp-side { width: 100%; height: auto; border: 1px solid #e0e0e0; border-radius: 4px; background: #fafafa; }
.tp-floor { fill: #f4f4f2; }
.tp-box { stroke: rgba(0, 0, 0, 0.25); stroke-width: 0.5; }
.tp-top { user-select: none; touch-action: none; }
.tp-goal { cursor: grab; }
.tp-goal circle { fill: rgba(46, 125, 50, 0.15); stroke: #2e7d32; stroke-dasharray: 4 3; }
.tp-goal.tp-dragging { cursor: grabbing; }
.tp-goal.tp-dragging circle { fill: rgba(46, 125, 50, 0.3); }
.tp-path-end line { stroke: #2e7d32; stroke-width: 2; }
.tp-spawn { fill: rgba(25, 118, 210, 0.08); stroke: #1976d2; stroke-dasharray: 4 3; }
.tp-spawn.tp-bad { fill: rgba(211, 47, 47, 0.15); stroke: #d32f2f; }
.tp-path { fill: none; stroke: #1976d2; stroke-width: 2; }
.tp-robot { fill: #1976d2; }
.tp-heading { stroke: #1976d2; stroke-width: 2; }
.tp-robot-side { stroke: #1976d2; stroke-width: 3; }
.tp-profile { fill: #c9b99a; stroke: #8d7b5a; stroke-width: 1; }
.tp-label { font: 11px sans-serif; fill: #666; }
</style>
