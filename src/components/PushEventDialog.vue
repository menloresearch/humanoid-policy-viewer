<template>
  <v-dialog :model-value="modelValue" max-width="480" @update:modelValue="onDialogModelValue">
    <v-card v-if="event">
      <v-card-title class="text-subtitle-1 d-flex align-center">
        Push event
        <v-spacer />
        <v-btn icon size="x-small" variant="text" color="error" title="Delete" @click="$emit('delete')">
          <v-icon size="18">mdi-delete-outline</v-icon>
        </v-btn>
      </v-card-title>

      <v-card-text>
        <v-select
          :model-value="event.targetBody"
          :items="bodySelectItems"
          item-title="label" item-value="value"
          label="Target body" density="compact" variant="outlined" hide-details
          class="mb-1"
          @update:modelValue="(v) => emitPatch({ targetBody: v })"
        ></v-select>
        <div class="dd-picker-panel">
          <div ref="pickerContainer" class="dd-picker-canvas"></div>
          <div class="text-caption text-medium-emphasis pa-1">
            {{ hoveredBodyLabel || 'Click a body part to select it as the push target — drag to orbit the view.' }}
          </div>
        </div>
        <div class="mb-4"></div>

        <v-text-field
          :model-value="event.t"
          label="Time (s)" type="number" min="0" :max="duration" step="0.1"
          density="compact" variant="outlined" hide-details class="mb-4"
          @update:modelValue="(v) => emitPatch({ t: clamp(Number(v), 0, duration) })"
        ></v-text-field>

        <div class="text-caption text-medium-emphasis mb-1">
          Force — direction and how hard (N), held for the duration below
        </div>
        <div class="d-flex align-center ga-4 mb-4">
          <DirectionDial :model-value="event.dir" @update:modelValue="(v) => emitPatch({ dir: v })" />
          <v-text-field
            :model-value="event.force"
            label="Force (N)" type="number" min="1" max="5000" step="10"
            density="compact" variant="outlined" hide-details style="max-width: 120px"
            @update:modelValue="(v) => emitPatch({ force: clamp(Number(v) || 0, 1, 5000) })"
          ></v-text-field>
        </div>

        <TorqueVectorEditor
          :axis="torqueAxisModel" :magnitude="torqueMagModel"
          class="mb-4"
          @update="onTorqueUpdate"
        />

        <v-text-field
          :model-value="event.duration"
          label="Duration (s) — how long the force/torque is held" type="number" min="0.01" step="0.05"
          density="compact" variant="outlined" hide-details
          @update:modelValue="(v) => emitPatch({ duration: Math.max(0.01, Number(v) || 0.15) })"
        ></v-text-field>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="flat" color="primary" @click="close">Done</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script>
import DirectionDial from './DirectionDial.vue';
import TorqueVectorEditor from './TorqueVectorEditor.vue';
import { demoRef } from '@/state/demoRef.js';
import { clamp as clampShared } from './clamp.js';

/**
 * MJCF body names are raw kinematic-chain identifiers (e.g. "left_hip_pitch_link",
 * "LEFT_SHOULDER_ROLL") — "link" is MJCF/URDF jargon for one rigid segment of
 * the robot, not meaningful to someone picking a push target. Strip it and
 * title-case what's left for the dropdown label; the raw name is still what's
 * stored/matched against the model.
 */
function humanizeBodyName(name) {
  const stripped = name
    .replace(/_rev_\d+_\d+$/i, '')
    .replace(/_?link$/i, '')
    .replace(/_/g, ' ')
    .trim();
  const words = stripped || name;
  return words.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export default {
  name: 'PushEventDialog',
  components: { DirectionDial, TorqueVectorEditor },
  props: {
    modelValue: { type: Boolean, default: false },
    event: { type: Object, default: null },
    duration: { type: Number, required: true },
    bodyNames: { type: Array, default: () => [] },
  },
  emits: ['update:modelValue', 'update-event', 'delete'],
  data() {
    return { hoveredBodyLabel: '' };
  },
  computed: {
    bodySelectItems() {
      return [
        { label: 'default (pelvis)', value: null },
        ...this.bodyNames.map((name) => ({ label: humanizeBodyName(name), value: name })),
      ];
    },
    // Torque controls are always shown (no on/off toggle) — a zero magnitude
    // means no torque, so there's always something valid to bind and drag.
    torqueAxisModel() {
      return Array.isArray(this.event?.torqueAxis) ? this.event.torqueAxis : [0, 0, 1];
    },
    torqueMagModel() {
      return Number(this.event?.torqueMag) || 0;
    },
  },
  methods: {
    clamp(v, lo, hi) { return clampShared(v, lo, hi); },
    emitPatch(patch) {
      this.$emit('update-event', patch);
    },
    onTorqueUpdate({ axis, magnitude }) {
      // TorqueVectorEditor already rounds magnitude to a whole N·m.
      this.emitPatch({ torqueAxis: axis, torqueMag: Math.round(magnitude) });
    },
    startPicking() {
      const demo = demoRef.current;
      if (!demo?.enterBodyPicker || !this.$refs.pickerContainer) return;
      this.hoveredBodyLabel = '';
      demo.enterBodyPicker(this.$refs.pickerContainer, {
        onHover: (name) => {
          this.hoveredBodyLabel = name ? `Hovering: ${humanizeBodyName(name)}` : '';
        },
        onPick: (name) => {
          this.emitPatch({ targetBody: name });
        },
      });
      demo.selectBody?.(this.event?.targetBody ?? null);
    },
    stopPicking() {
      demoRef.current?.exitBodyPicker?.();
      this.hoveredBodyLabel = '';
    },
    close() {
      this.$emit('update:modelValue', false);
    },
    onDialogModelValue(v) {
      this.$emit('update:modelValue', v);
    },
  },
  watch: {
    modelValue(v) {
      if (v) this.$nextTick(() => this.startPicking());
      else this.stopPicking();
    },
    'event.targetBody'(name) {
      demoRef.current?.selectBody?.(name ?? null);
    },
  },
  beforeUnmount() {
    this.stopPicking();
  },
};
</script>

<style scoped>
.dd-picker-panel {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}
.dd-picker-canvas {
  width: 100%;
  height: 280px;
  background: #202020;
}
</style>
