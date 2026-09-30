<template>
  <div class="pl-chart">
    <div class="pl-label">push events — click a marker to edit, drag to move</div>
    <svg
      ref="svg"
      class="pl-svg"
      :viewBox="`0 0 ${VW} ${VH}`"
      preserveAspectRatio="none"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
    >
      <!-- lane background: click empty area to add -->
      <rect
        :x="padL" :y="padT"
        :width="plotW" :height="plotH"
        fill="#fafafa" stroke="#e0e0e0"
        @pointerdown.stop="onBackgroundAdd"
      />

      <!-- baseline -->
      <line :x1="padL" :x2="VW - padR" :y1="axisY" :y2="axisY"
            stroke="#e0e0e0" stroke-width="0.75" />

      <!-- time ticks -->
      <template v-for="tick in timeTicks" :key="'t' + tick">
        <line :x1="tToX(tick)" :x2="tToX(tick)" :y1="axisY - 3" :y2="axisY + 3"
              stroke="#bdbdbd" stroke-width="0.75" />
        <text :x="tToX(tick)" :y="VH - 4" text-anchor="middle" class="pl-tick">{{ tick }}</text>
      </template>

      <!-- push markers -->
      <g v-for="(ev, i) in markers" :key="i">
        <!-- direction arrow (foreshortened by elevation, same convention as DirectionDial) -->
        <line :x1="ev.x" :y1="axisY" :x2="ev.x + ev.ax" :y2="axisY - ev.ay"
              stroke="#D32F2F" stroke-width="1.75" />
        <!-- torque indicator: small ring around the handle -->
        <circle v-if="ev.hasTorque" :cx="ev.x" :cy="axisY" r="8" fill="none" stroke="#7b5cff" stroke-width="1.25" />
        <circle
          :cx="ev.x" :cy="axisY" r="5"
          fill="#D32F2F" stroke="#fff" stroke-width="1.5"
          class="pl-handle"
          @pointerdown.stop="onMarkerDown($event, i)"
          @contextmenu.prevent.stop="$emit('delete-event', i)"
        />
        <text :x="ev.x" :y="padT + 10" text-anchor="middle" class="pl-mtick">{{ ev.tLabel }}s</text>
        <text :x="ev.x" :y="axisY + 16" text-anchor="middle" class="pl-mtick">
          {{ ev.dirLabel }} · {{ ev.forceLabel }}N{{ ev.hasTorque ? ' · τ' : '' }}
        </text>
      </g>
    </svg>

    <!-- compact summary list -->
    <div class="pl-controls">
      <template v-for="(ev, i) in events" :key="'c' + i">
        <div class="pl-row">
          <span class="pl-idx">#{{ i + 1 }} @{{ (ev.t ?? 0).toFixed(1) }}s</span>
          <span class="pl-summary">{{ summarize(ev) }}</span>
          <v-btn icon size="x-small" variant="text" title="Edit" @click="openDialog(i)">
            <v-icon size="14">mdi-pencil</v-icon>
          </v-btn>
          <button class="pl-del" @click="$emit('delete-event', i)">×</button>
        </div>
      </template>
      <div v-if="events.length === 0" class="pl-empty">
        click the lane to add a push
      </div>
    </div>

    <PushEventDialog
      v-model="dialogOpen"
      :event="dialogEvent"
      :duration="duration"
      :body-names="bodyNames"
      @update-event="onDialogUpdate"
      @delete="onDialogDelete"
    />
  </div>
</template>

<script>
import PushEventDialog from './PushEventDialog.vue';
import { toSpherical } from './direction-math.js';
import { clamp as clampShared } from './clamp.js';

const VW = 800;
const VH = 90;
const T_SNAP = 0.1;
const ARROW = 20; // px arrow length for a unit-elevation direction
const CLICK_SLOP = 4; // px of pointer movement still counted as a click, not a drag
const DEFAULT_DURATION = 0.15; // seconds — matches the click-to-push precedent (~0.1s)
const DEFAULT_FORCE_N = 200; // Newtons — a firm shove for a ~30kg-class robot

/** Ensure a dir array is always [x, y, z] — legacy 2-element data defaults z=0. */
function dir3(d) {
  if (!Array.isArray(d)) return [1, 0, 0];
  return [Number(d[0]) || 0, Number(d[1]) || 0, Number(d[2]) || 0];
}

export default {
  name: 'PushLane',
  components: { PushEventDialog },
  props: {
    events: { type: Array, default: () => [] },
    duration: { type: Number, required: true },
    bodyNames: { type: Array, default: () => [] }
  },
  emits: ['move-event', 'add-event', 'delete-event', 'update-event'],
  data() {
    return {
      VW, VH, padL: 44, padR: 40, padT: 18, padB: 20,
      dragIndex: -1, dragStart: null, dragMoved: false,
      dialogOpen: false, dialogIndex: -1,
    };
  },
  computed: {
    plotW() { return VW - this.padL - this.padR; },
    plotH() { return VH - this.padT - this.padB; },
    axisY() { return this.padT + this.plotH * 0.55; },
    dialogEvent() {
      const ev = this.events[this.dialogIndex];
      if (!ev) return null;
      // Present a fully-shaped event to the dialog regardless of how sparse
      // the stored data is (older/simple events have no torque fields at all).
      return {
        t: ev.t ?? 0,
        dir: dir3(ev.dir),
        force: ev.force ?? 200,
        duration: ev.duration ?? DEFAULT_DURATION,
        torqueAxis: Array.isArray(ev.torqueAxis) ? dir3(ev.torqueAxis) : null,
        torqueMag: ev.torqueMag ?? null,
        targetBody: typeof ev.targetBody === 'string' ? ev.targetBody : null,
      };
    },
    markers() {
      return this.events.map((ev) => {
        const [x, y, z] = dir3(ev.dir);
        const force = ev.force ?? 200;
        const foreshorten = Math.hypot(x, y) || 1; // shrink arrow as z dominates
        return {
          x: this.tToX(ev.t ?? 0),
          ax: x * ARROW,
          ay: y * ARROW,
          tLabel: (ev.t ?? 0).toFixed(1),
          dirLabel: this.fmtDir([x, y, z]),
          forceLabel: force.toFixed(0),
          hasTorque: Array.isArray(ev.torqueAxis) && Number(ev.torqueMag) !== 0,
        };
      });
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
    xToT(px) { return this.duration ? ((px - this.padL) / this.plotW) * this.duration : 0; },
    snapT(t) { return Math.round(t / T_SNAP) * T_SNAP; },
    clamp(v, lo, hi) { return clampShared(v, lo, hi); },
    round1(t) { return Math.round(t * 10) / 10; },
    fmtDir(d) {
      const { azDeg, elevDeg } = toSpherical(d);
      const az = Math.round(azDeg);
      const elev = Math.round(elevDeg);
      return elev === 0 ? `az${az}°` : `az${az}°/el${elev}°`;
    },
    summarize(ev) {
      const [x, y, z] = dir3(ev.dir);
      const parts = [this.fmtDir([x, y, z]), `F=${(ev.force ?? 200).toFixed(0)}N`, `${(ev.duration ?? DEFAULT_DURATION).toFixed(2)}s`];
      if (Array.isArray(ev.torqueAxis) && Number(ev.torqueMag)) {
        parts.push(`τ=${Number(ev.torqueMag).toFixed(1)}N·m`);
      }
      if (typeof ev.targetBody === 'string' && ev.targetBody) {
        parts.push(`@${ev.targetBody}`);
      }
      return parts.join(' · ');
    },
    eventToT(event) {
      const rect = this.$refs.svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * VW;
      return this.xToT(px);
    },
    onBackgroundAdd(event) {
      const t = this.round1(this.clamp(this.snapT(this.eventToT(event)), 0, this.duration));
      this.$emit('add-event', t, [1, 0, 0], DEFAULT_FORCE_N, DEFAULT_DURATION);
    },
    onMarkerDown(event, index) {
      this.dragIndex = index;
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragMoved = false;
      event.target.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      if (this.dragIndex < 0) return;
      if (!this.dragMoved && this.dragStart) {
        const d = Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y);
        if (d > CLICK_SLOP) this.dragMoved = true;
      }
      if (!this.dragMoved) return; // still within click slop — don't move time yet
      const t = this.round1(this.clamp(this.snapT(this.eventToT(event)), 0, this.duration));
      this.$emit('move-event', this.dragIndex, t);
    },
    onPointerUp() {
      if (this.dragIndex >= 0 && !this.dragMoved) {
        // Pointer never left the click-slop radius — treat as a click, not a drag.
        this.openDialog(this.dragIndex);
      }
      this.dragIndex = -1;
      this.dragStart = null;
      this.dragMoved = false;
    },
    openDialog(index) {
      this.dialogIndex = index;
      this.dialogOpen = true;
    },
    onDialogUpdate(patch) {
      if (this.dialogIndex < 0) return;
      this.$emit('update-event', this.dialogIndex, patch);
    },
    onDialogDelete() {
      if (this.dialogIndex < 0) return;
      this.$emit('delete-event', this.dialogIndex);
      this.dialogOpen = false;
      this.dialogIndex = -1;
    },
  }
};
</script>

<style scoped>
.pl-chart {
  position: relative;
  width: 100%;
}
.pl-label {
  position: absolute;
  top: 2px;
  left: 48px;
  font: 600 12px sans-serif;
  color: #D32F2F;
  pointer-events: none;
}
.pl-svg {
  width: 100%;
  height: 90px;
  display: block;
  touch-action: none;
}
.pl-handle {
  cursor: pointer;
}
.pl-tick {
  font: 10px monospace;
  fill: #757575;
}
.pl-mtick {
  font: 9px monospace;
  fill: #616161;
}
.pl-controls {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 4px 0 0 44px;
}
.pl-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 11px sans-serif;
}
.pl-idx {
  font: 600 11px monospace;
  color: #D32F2F;
  min-width: 74px;
  flex: 0 0 auto;
}
.pl-summary {
  font: 11px monospace;
  color: #616161;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-del {
  border: none;
  background: #f0f0f0;
  color: #D32F2F;
  cursor: pointer;
  font: 700 13px sans-serif;
  line-height: 1;
  padding: 1px 6px;
  border-radius: 3px;
  flex: 0 0 auto;
}
.pl-empty {
  font: 11px sans-serif;
  color: #9e9e9e;
}
</style>
