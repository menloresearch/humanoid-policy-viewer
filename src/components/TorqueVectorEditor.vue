<template>
  <div class="tve-wrap">
    <div class="tve-header">
      <span class="text-caption text-medium-emphasis">Torque — roll / pitch / yaw (N·m)</span>
      <v-tooltip location="top" max-width="270">
        <template #activator="{ props }">
          <v-icon v-bind="props" size="14" class="tve-info" color="grey">mdi-information-outline</v-icon>
        </template>
        <span>
          Each slider is how hard the robot is twisted about that axis; set more than one and they
          combine into a single net twist. The ring on the right always shows that combined result
          directly as one curved arrow — its direction is the net spin (right-hand rule: curl your
          right hand's fingers the way the arrow curves and your thumb points along the axis), and
          it fades in as the combined torque increases.
        </span>
      </v-tooltip>
    </div>

    <div class="tve-body">
      <div class="tve-sliders">
        <div v-for="s in AXES" :key="s.key" class="tve-row">
          <span class="tve-label" :style="{ color: s.color }">{{ s.label }}</span>
          <v-slider
            :model-value="displayComponents[s.key]"
            :min="-RANGE" :max="RANGE" :step="1"
            density="compact" hide-details :color="s.color"
            @update:modelValue="(v) => setComponent(s.key, v)"
          ></v-slider>
          <v-text-field
            :model-value="displayComponents[s.key]"
            type="number" :min="-RANGE" :max="RANGE" step="1"
            density="compact" variant="outlined" hide-details style="max-width: 68px"
            @update:modelValue="(v) => setComponent(s.key, v)"
          ></v-text-field>
        </div>
      </div>

      <div class="tve-visual">
        <svg viewBox="0 0 120 120" class="tve-svg">
          <defs>
            <radialGradient id="tveGlobe" cx="35%" cy="32%" r="70%">
              <stop offset="0%" stop-color="#ffffff" />
              <stop offset="55%" stop-color="#e6e6e6" />
              <stop offset="100%" stop-color="#c2c2c2" />
            </radialGradient>
            <!-- gives the ring a rounded, tube-like cross-section: a dark
                 base stroke plus a thinner light "highlight" centered on top -->
            <linearGradient id="tveTubeShade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#FFB74D" />
              <stop offset="100%" stop-color="#E65100" />
            </linearGradient>
            <linearGradient id="tveConeShade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#BF360C" />
              <stop offset="100%" stop-color="#FFCC80" />
            </linearGradient>
            <!-- Brightens along the direction of spin, tail to head — the
                 ellipse's shape alone can look nearly the same for opposite
                 directions from some angles (e.g. pitch, viewed nearly
                 edge-on), so this "comet trail" is what actually reads as
                 motion toward the arrowhead regardless of that foreshortening. -->
            <linearGradient
              id="tveFlow" gradientUnits="userSpaceOnUse"
              :x1="netVisual.tail.x" :y1="netVisual.tail.y"
              :x2="netVisual.head.x" :y2="netVisual.head.y"
            >
              <stop offset="0%" stop-color="#FFE0B2" />
              <stop offset="100%" stop-color="#BF360C" />
            </linearGradient>
          </defs>
          <!-- Draw order does the occlusion for us: back-of-ring segments
               first (full color), then the globe semi-transparent on top of
               them (which is what actually mutes/tints whatever is behind
               it), then the front-of-ring segments on top of the globe,
               fully bright. No manual "dim the back half" opacity needed. -->
          <g v-for="(d, i) in netVisual.backPaths" :key="'b' + i" :opacity="netVisual.opacity">
            <path :d="d" fill="none" stroke="url(#tveFlow)" :stroke-width="netVisual.strokeWidth" stroke-linecap="round" />
            <path :d="d" fill="none" stroke="url(#tveTubeShade)" :stroke-width="netVisual.strokeWidth * 0.45" stroke-linecap="round" />
          </g>

          <!-- shaded, semi-transparent ball (not a flat circle) plus a faint
               lat/long wireframe — its own translucency is what dims the
               ring segments drawn behind it above -->
          <circle cx="60" cy="60" r="38" fill="url(#tveGlobe)" fill-opacity="0.8" stroke="#bbb" stroke-width="0.75" />
          <path v-for="(d, i) in GLOBE_WIREFRAME" :key="'gw' + i" :d="d" fill="none" stroke="#aaa" stroke-width="0.5" opacity="0.5" />

          <!-- the near side, drawn solid on top — two overlaid strokes (dark
               base + a lighter centered highlight) read as a rounded tube
               rather than a flat line -->
          <g v-for="(d, i) in netVisual.frontPaths" :key="'f' + i" :opacity="netVisual.opacity">
            <path :d="d" fill="none" stroke="url(#tveFlow)" :stroke-width="netVisual.strokeWidth" stroke-linecap="round" />
            <path :d="d" fill="none" stroke="url(#tveTubeShade)" :stroke-width="netVisual.strokeWidth * 0.45" stroke-linecap="round" />
          </g>
          <polygon
            v-if="netVisual.arrow"
            :points="ARROW_POINTS" fill="url(#tveConeShade)" stroke="#E65100" stroke-width="0.5"
            :opacity="netVisual.opacity"
            :transform="`translate(${netVisual.arrow.x.toFixed(2)},${netVisual.arrow.y.toFixed(2)}) rotate(${netVisual.arrow.deg.toFixed(1)})`"
          />
        </svg>
        <div class="text-caption text-medium-emphasis tve-net">
          {{ netMagnitude > 0.5 ? `net ${Math.round(netMagnitude)} N·m` : 'no torque' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import * as THREE from 'three';

const RANGE = 50;
// Each axis viewed from its own natural vantage in one shared 3D-looking
// gizmo (a fixed "camera" angle, not the live scene's) — color identifies
// the ring regardless of orientation, matching the slider's own color.
const AXES = [
  { key: 'roll', ring: 'x', color: '#e53935', label: 'Roll' },
  { key: 'pitch', ring: 'y', color: '#43a047', label: 'Pitch' },
  { key: 'yaw', ring: 'z', color: '#1e88e5', label: 'Yaw' },
];

const RING_SAMPLES = 48;
const YAW_VIEW = (35 * Math.PI) / 180;
const PITCH_VIEW = (22 * Math.PI) / 180;
const CX = 60, CY = 60, R = 38;

function project(x, y, z) {
  const x1 = x * Math.cos(YAW_VIEW) + z * Math.sin(YAW_VIEW);
  const z1 = -x * Math.sin(YAW_VIEW) + z * Math.cos(YAW_VIEW);
  const y2 = y * Math.cos(PITCH_VIEW) - z1 * Math.sin(PITCH_VIEW);
  const z2 = y * Math.sin(PITCH_VIEW) + z1 * Math.cos(PITCH_VIEW);
  return { x: CX + x1 * R, y: CY - y2 * R, depth: z2 };
}

// Thin array-in/array-out wrappers around THREE.Vector3 — the callers below
// work with plain [x, y, z] tuples throughout, so we keep that shape rather
// than threading Vector3 instances through ringForAxis/project.
function normalize3(v) {
  return new THREE.Vector3(v[0], v[1], v[2]).normalize().toArray();
}
function cross3(a, b) {
  return new THREE.Vector3(a[0], a[1], a[2]).cross(new THREE.Vector3(b[0], b[1], b[2])).toArray();
}
function dot3(a, b) {
  return new THREE.Vector3(a[0], a[1], a[2]).dot(new THREE.Vector3(b[0], b[1], b[2]));
}

const RING_FRACTION = 0.75; // 75% of a full turn — a closed loop reads as a static circle, not a spin

// Build a right-handed (axis, u, v) frame for an *arbitrary* axis direction —
// not just a cardinal one, since combining sliders can point anywhere. Any
// vector on the unit circle spanned by u/v, p(t) = cos(t)*u + sin(t)*v, then
// traces the ring perpendicular to axis with increasing t already matching
// the right-hand-rule "positive" spin direction — so the arrow never needs a
// separate CW/CCW branch, unlike the fixed cardinal-ring version before this.
// Only drawing RING_FRACTION of the loop (leaving a gap) makes the direction
// of travel legible at a glance, like a spinner icon rather than a closed ring.
function ringForAxis(axis) {
  const helper = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = dot3(helper, axis);
  const u = normalize3([helper[0] - d * axis[0], helper[1] - d * axis[1], helper[2] - d * axis[2]]);
  const v = cross3(axis, u);
  const pts = [];
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const t = (i / RING_SAMPLES) * RING_FRACTION * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const p3 = [c * u[0] + s * v[0], c * u[1] + s * v[1], c * u[2] + s * v[2]];
    pts.push({ ...project(p3[0], p3[1], p3[2]), t });
  }
  return pts;
}

function toPath(pts) {
  return 'M ' + pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ');
}

// Split a sampled ring into contiguous near-side (depth >= 0) and far-side
// (depth < 0) runs, so they can be drawn either side of the (semi-transparent)
// globe in the template — the draw order plus the globe's own translucency
// is what dims the far side, not any per-segment opacity math here.
function splitByDepth(pts) {
  const front = [];
  const back = [];
  let run = [pts[0]];
  let sign = pts[0].depth >= 0;
  for (let i = 1; i < pts.length; i++) {
    const s = pts[i].depth >= 0;
    if (s !== sign) {
      run.push(pts[i]); // shared boundary point keeps the two runs visually joined
      (sign ? front : back).push(toPath(run));
      run = [pts[i]];
      sign = s;
    } else {
      run.push(pts[i]);
    }
  }
  (sign ? front : back).push(toPath(run));
  return { front, back };
}

// Two static great circles (not tied to any torque value) purely to read as
// a wireframe globe rather than a flat shaded disc.
const GLOBE_WIREFRAME = [
  toPath(ringForAxisFull([0, 1, 0])),
  toPath(ringForAxisFull([0, 0, 1])),
];

// Full (non-gapped) version of ringForAxis, for the static wireframe only.
function ringForAxisFull(axis) {
  const helper = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = dot3(helper, axis);
  const u = normalize3([helper[0] - d * axis[0], helper[1] - d * axis[1], helper[2] - d * axis[2]]);
  const v = cross3(axis, u);
  const pts = [];
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const t = (i / RING_SAMPLES) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const p3 = [c * u[0] + s * v[0], c * u[1] + s * v[1], c * u[2] + s * v[2]];
    pts.push(project(p3[0], p3[1], p3[2]));
  }
  return pts;
}

export default {
  name: 'TorqueVectorEditor',
  props: {
    axis: { type: Array, required: true }, // [x, y, z] — unit-ish, sign = spin sense
    magnitude: { type: Number, default: 0 }, // N·m
  },
  emits: ['update'],
  data() {
    return { AXES, RANGE, ARROW_POINTS: '-3,-7 16,0 -3,7', GLOBE_WIREFRAME };
  },
  computed: {
    // Decompose the stored axis+magnitude back into per-axis components so
    // each slider shows its own contribution to the current torque.
    components() {
      const [x, y, z] = Array.isArray(this.axis) ? this.axis : [0, 0, 1];
      const m = Number(this.magnitude) || 0;
      return { roll: x * m, pitch: y * m, yaw: z * m };
    },
    // Reconstructing per-axis components from a normalized axis+magnitude
    // (see components() above) picks up float dust — e.g. 9.999999999999998
    // instead of 10 — even when every slider was set to a clean integer.
    // Round for display only; setComponent below still does the real math
    // in full precision.
    displayComponents() {
      const c = this.components;
      return { roll: Math.round(c.roll), pitch: Math.round(c.pitch), yaw: Math.round(c.yaw) };
    },
    netMagnitude() {
      const c = this.components;
      return Math.hypot(c.roll, c.pitch, c.yaw);
    },
    netAxis() {
      const m = this.netMagnitude;
      if (m < 1e-6) return [0, 0, 1];
      const c = this.components;
      return [c.roll / m, c.pitch / m, c.yaw / m];
    },
    // One ring, perpendicular to whatever direction roll/pitch/yaw currently
    // combine into (may not be a cardinal axis at all) — fades in and thickens
    // as the combined torque grows, with a single arrow (no CW/CCW branch
    // needed; see ringForAxis) showing the net spin direction.
    netVisual() {
      const pts = ringForAxis(this.netAxis);
      const { front, back } = splitByDepth(pts);
      const intensity = Math.min(1, this.netMagnitude / RANGE);
      let arrow = null;
      if (this.netMagnitude > 0.5) {
        // Arrowhead at the arc's trailing end, tangent to where the spin
        // would continue into the gap — the open arc itself is what makes
        // the direction of travel readable, so the arrow just confirms it.
        const tip = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const deg = (Math.atan2(tip.y - prev.y, tip.x - prev.x) * 180) / Math.PI;
        arrow = { x: tip.x, y: tip.y, deg };
      }
      return {
        frontPaths: front,
        backPaths: back,
        tail: pts[0],
        head: pts[pts.length - 1],
        opacity: 0.15 + 0.85 * intensity,
        strokeWidth: 2 + 4 * intensity,
        arrow,
      };
    },
  },
  methods: {
    setComponent(key, value) {
      // Base on the rounded display values, not the raw (float-dust-prone)
      // components — otherwise an untouched axis could drift off its clean
      // integer by the same rounding error components() picks up.
      const next = { ...this.displayComponents, [key]: Math.round(Number(value) || 0) };
      const m = Math.hypot(next.roll, next.pitch, next.yaw);
      const axis = m < 1e-6 ? [0, 0, 1] : [next.roll / m, next.pitch / m, next.yaw / m];
      this.$emit('update', { axis, magnitude: Math.round(m) });
    },
  },
};
</script>

<style scoped>
.tve-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tve-header {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tve-info {
  cursor: help;
}
.tve-body {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tve-sliders {
  flex: 1 1 auto;
  min-width: 0;
}
.tve-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tve-label {
  font: 700 11px sans-serif;
  width: 34px;
  flex: 0 0 auto;
}
.tve-visual {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 130px;
}
.tve-svg {
  width: 130px;
  height: 130px;
}
.tve-net {
  white-space: nowrap;
}
</style>
