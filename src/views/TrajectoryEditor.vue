<template>
  <div class="editor-page">
    <v-app-bar density="compact" color="primary" flat>
      <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="back">Back to viewer</v-btn>
      <v-app-bar-title>Trajectory Editor</v-app-bar-title>
    </v-app-bar>

    <div class="editor-body">
      <!-- Saved sequences sidebar -->
      <div class="editor-sidebar">
        <div class="d-flex align-center justify-space-between mb-2">
          <span class="text-subtitle-2">Saved sequences</span>
          <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="createNew">New</v-btn>
        </div>
        <v-alert v-if="listError" type="warning" density="compact" class="mb-2">{{ listError }}</v-alert>
        <v-list density="compact" nav>
          <template v-for="group in savedGroups" :key="group.category">
            <v-list-subheader>{{ group.category }}</v-list-subheader>
            <v-list-item
              v-for="item in group.items"
              :key="item.file"
              :active="item.file === file"
              :title="item.name"
              :subtitle="`${item.file.replace(/\.json$/, '')} · ${item.duration}s · ${item.keypointCount} pts`"
              @click="openSaved(item.file)"
            >
              <template v-if="!STATIC" #append>
                <v-btn icon="mdi-delete" size="x-small" variant="text" @click.stop="removeSaved(item.file)"></v-btn>
              </template>
            </v-list-item>
          </template>
          <v-list-item v-if="savedList.length === 0" title="No saved sequences" class="text-disabled"></v-list-item>
        </v-list>
      </div>

      <!-- Editor main -->
      <div class="editor-main">
        <v-tabs v-model="tab" density="compact" class="mb-3">
          <v-tab value="settings">Settings<span v-if="settingsHasError" class="tab-error" title="has a problem"></span></v-tab>
          <v-tab value="environment">Environment<span v-if="environmentHasError" class="tab-error" title="has a problem"></span></v-tab>
          <v-tab value="commands">Commands &amp; pushes<span v-if="durationError" class="tab-error" title="has a problem"></span></v-tab>
        </v-tabs>
        <!-- eager: every tab stays mounted, so the course check runs while another tab is open -->
        <v-window v-model="tab">
          <v-window-item value="settings" eager>
        <div class="editor-fields">
          <v-text-field
            v-model="working.name" label="Name" density="compact" hide-details
            style="max-width: 240px" @update:modelValue="onNameChange"
          ></v-text-field>
          <v-combobox
            v-model="category" :items="categories" label="Category (optional)" density="compact" hide-details
            placeholder="pick or type a new one" style="max-width: 200px"
          ></v-combobox>
          <v-text-field
            v-model.number="durationInput" label="Duration (s)" type="number"
            density="compact" hide-details :min="minDuration" :max="MAX_DURATION" step="1"
            style="max-width: 140px"
            :error="durationError !== ''" @update:modelValue="onDurationChange"
          ></v-text-field>
        </div>
        <div v-if="file" class="text-caption text-medium-emphasis mb-2">Saves as {{ file }}</div>
        <div v-if="durationError" class="text-error text-caption mb-2">{{ durationError }}</div>
        <div v-if="idError" class="text-error text-caption mb-2">{{ idError }}</div>

        <!-- Editable per-axis command limits -->
        <div class="limits-section mb-3">
          <div class="text-subtitle-2 mb-1">Command limits (min / max per axis)</div>
          <div v-for="ax in axes" :key="ax.key" class="d-flex align-center ga-2 mb-1">
            <span class="limit-axis" :style="{ color: ax.color }">{{ ax.label }}</span>
            <v-text-field
              v-model.number="limitDrafts[ax.key][0]" label="min" type="number"
              density="compact" hide-details step="0.05" style="max-width: 110px"
              @change="commitLimit(ax.key)" @blur="commitLimit(ax.key)"
            ></v-text-field>
            <v-text-field
              v-model.number="limitDrafts[ax.key][1]" label="max" type="number"
              density="compact" hide-details step="0.05" style="max-width: 110px"
              @change="commitLimit(ax.key)" @blur="commitLimit(ax.key)"
            ></v-text-field>
            <v-btn size="x-small" variant="tonal" @click="copyLimitsToAll(ax.key)">Copy to all</v-btn>
          </div>
        </div>

        <!-- Which metrics this test reports; survival is always on and is all leaderboards score -->
        <div class="metrics-section mb-3">
          <div class="text-subtitle-2 mb-1">Metrics</div>
          <div class="d-flex flex-wrap ga-3">
            <v-checkbox label="Survival" :model-value="true" disabled density="compact" hide-details></v-checkbox>
            <v-checkbox label="Time survived" :model-value="true" disabled density="compact" hide-details></v-checkbox>
            <v-checkbox
              v-for="m in OPT_IN_METRIC_ITEMS" :key="m.value"
              :model-value="metricsOptIn.includes(m.value)" :label="m.title" :title="m.hint"
              density="compact" hide-details
              @update:modelValue="(on) => setMetricOptIn(m.value, on)"
            ></v-checkbox>
          </div>
          <div class="text-caption text-medium-emphasis">
            Survival and time survived are always measured and are what leaderboards score; tick the others that mean
            something for this test.
          </div>
        </div>
          </v-window-item>
          <v-window-item value="environment" eager>
        <!-- Environment: the course, the floor grip and the end zone -->
        <div class="env-section mb-3">
          <div class="d-flex flex-wrap align-center ga-3 mb-2">
            <v-select
              v-model="terrainType" :items="terrainTypeItems" item-title="title" item-value="value"
              label="Terrain" density="compact" hide-details style="max-width: 200px"
            ></v-select>
            <v-select
              v-model="frictionPreset" :items="FRICTION_PRESETS" item-title="title" item-value="value"
              label="Foot friction" density="compact" hide-details style="max-width: 220px"
            ></v-select>
            <v-text-field
              v-if="frictionPreset === 'custom'"
              v-model.number="customFriction" label="friction" type="number" min="0.01" step="0.05"
              density="compact" hide-details style="max-width: 110px"
            ></v-text-field>
          </div>
          <div class="d-flex flex-wrap align-center ga-3 mb-2">
            <v-checkbox
              v-model="hasGoal" label="End zone" density="compact" hide-details
              title="A circle the robot's base must enter for a run to count as surviving, so stopping in front of a course does not"
            ></v-checkbox>
            <template v-if="working.goal">
              <v-text-field
                v-for="g in GOAL_FIELDS" :key="g.key"
                :model-value="working.goal[g.key]" :label="g.label" type="number" step="0.01"
                density="compact" hide-details style="max-width: 140px"
                @update:modelValue="(v) => setGoalParam(g.key, v)"
              ></v-text-field>
              <v-btn
                size="small" variant="tonal" prepend-icon="mdi-target" @click="snapGoalToPathEnd"
                title="Centre the end zone where the velocity commands end the path (the ✕ in the preview)"
              >Snap to path end</v-btn>
            </template>
          </div>
          <div v-for="e in goalErrors" :key="e" class="text-error text-caption mb-2">End zone: {{ e }}</div>
          <template v-if="working.terrain || working.goal">
            <div v-if="working.terrain" class="text-caption text-medium-emphasis mb-1">{{ terrainDescription }}</div>
            <div v-if="working.terrain" class="d-flex flex-wrap ga-2 mb-2">
              <v-text-field
                v-for="p in terrainParams" :key="p.key"
                :model-value="working.terrain[p.key]"
                :label="p.label" type="number" :min="p.min" :max="p.max" :step="p.integer ? 1 : p.step"
                density="compact" hide-details style="max-width: 170px"
                @update:modelValue="(v) => setTerrainParam(p.key, v)"
              ></v-text-field>
            </div>
            <TerrainPreview
              :terrain="working.terrain" :goal="working.goal" :commands="working.commands" :duration="Number(working.duration) || 0"
              @problems="(p) => (terrainErrors = p.errors)"
              @update:goal="(g) => (working.goal = g)"
            />
          </template>
        </div>

          </v-window-item>
          <v-window-item value="commands" eager>
        <div class="charts">
          <KeypointChart
            :commands="working.commands" axis="vx" :duration="working.duration"
            :limits="working.limits.vx" color="#1976D2" label="vx (forward)"
            @move-point="(i, t, v) => movePoint('vx', i, t, v)"
            @add-point="(t, v) => addPoint('vx', t, v)"
            @delete-point="deletePoint"
          />
          <KeypointChart
            :commands="working.commands" axis="vy" :duration="working.duration"
            :limits="working.limits.vy" color="#E69F00" label="vy (lateral)"
            @move-point="(i, t, v) => movePoint('vy', i, t, v)"
            @add-point="(t, v) => addPoint('vy', t, v)"
            @delete-point="deletePoint"
          />
          <KeypointChart
            :commands="working.commands" axis="wz" :duration="working.duration"
            :limits="working.limits.wz" color="#9C27B0" label="wz (yaw rate)"
            show-time-labels
            @move-point="(i, t, v) => movePoint('wz', i, t, v)"
            @add-point="(t, v) => addPoint('wz', t, v)"
            @delete-point="deletePoint"
          />
        </div>
        <div class="text-caption text-disabled mb-3">
          click empty area: add point · drag: move (snaps to 0.05 / 0.1&nbsp;s) · right-click a point: delete
        </div>

        <PushLane
          :events="working.events"
          :duration="working.duration"
          :body-names="bodyNames"
          @add-event="addEvent"
          @move-event="moveEvent"
          @delete-event="deleteEvent"
          @update-event="updateEvent"
        />
        <div class="text-caption text-disabled mb-3">
          push events apply a real force (N) (and optional torque) through the target body's own CoM at time t, held for a duration · click lane: add · click a marker: edit direction/torque/magnitude/target · drag: move (snaps 0.1&nbsp;s) · right-click: delete
        </div>

          </v-window-item>
        </v-window>

        <v-divider class="mb-2"></v-divider>
        <div class="d-flex align-center ga-2 flex-wrap">
          <v-btn v-if="!STATIC" color="primary" prepend-icon="mdi-content-save" :disabled="!canSave" @click="save">Save</v-btn>
          <v-btn variant="tonal" prepend-icon="mdi-play" :disabled="durationError !== ''" @click="applyToViewer">Apply to viewer</v-btn>
          <v-btn :color="STATIC ? 'primary' : undefined" variant="text" prepend-icon="mdi-download" @click="exportJson">Export JSON</v-btn>
          <span v-if="STATIC" class="text-caption text-medium-emphasis">
            Static deployment — edits aren't saved to disk; download the JSON to keep them.
          </span>
          <v-spacer></v-spacer>
          <span v-if="statusMsg" :class="statusIsError ? 'text-error' : 'text-success'" class="text-caption">{{ statusMsg }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import KeypointChart from '@/components/KeypointChart.vue';
import PushLane from '@/components/PushLane.vue';
import TerrainPreview from '@/components/TerrainPreview.vue';
import { appState, closeEditor, newBlankSequence, defaultLimits, MAX_DURATION } from '@/state/appState.js';
import { listSequences, loadSequenceFile, saveSequenceFile, deleteSequenceFile, slugify } from '@/state/sequenceStore.js';
import { STATIC } from '@/state/viewerMode.js';
import { commandSequencer } from '@/simulation/commandSequencer.js';
import { ALL_CONFIG, GOAL_MIN_RADIUS_M, OPT_IN_METRICS, PUSH_END_MARGIN_S, validateGoal } from '@/benchmark/testRow.js';
import { TERRAIN_TYPES, defaultTerrain } from '@/simulation/terrainGen.js';
import { commandedEnd, roundGoal } from '@/benchmark/terrainCheck.js';
import { loadTestScene } from '@/simulation/terrainScene.js';
import { demoRef } from '@/state/demoRef.js';

// Floor grip presets; the scene's own foot friction is 0.6.
const FRICTION_PRESETS = [
  { title: 'scene default (0.6)', value: 'scene' },
  { title: 'wet (0.3)', value: 'wet', friction: 0.3 },
  { title: 'icy (0.08)', value: 'icy', friction: 0.08 },
  { title: 'custom', value: 'custom' },
];

// Category and test name: the two halves of a test id (<category>/<name>).
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

function splitTestFile(file) {
  const id = String(file ?? '').replace(/\.json$/i, '');
  const slash = id.indexOf('/');
  return slash < 0 ? { category: '', testName: id } : { category: id.slice(0, slash), testName: id.slice(slash + 1) };
}

export default {
  name: 'TrajectoryEditor',
  components: { KeypointChart, PushLane, TerrainPreview },
  data() {
    return {
      tab: 'settings',
      OPT_IN_METRIC_ITEMS: [
        { value: 'gait_symmetry', title: 'Gait symmetry', hint: 'Left/right mirror of the joints; only means something on straight, steady walking' },
        { value: 'command_tracking', title: 'Command tracking', hint: 'How closely the robot follows the commanded velocities' },
        { value: 'drift', title: 'Drift', hint: 'Distance from where the commands would have taken the robot' },
        { value: 'action_smoothness', title: 'Smoothness', hint: 'How much the policy actions jump from step to step' },
      ],
      GOAL_FIELDS: [
        { key: 'x', label: 'x (m ahead)' },
        { key: 'y', label: 'y (m left)' },
        { key: 'radius_m', label: `radius (m, ≥ ${GOAL_MIN_RADIUS_M})` },
      ],
      STATIC,
      MAX_DURATION,
      FRICTION_PRESETS,
      terrainErrors: [],
      customFrictionMode: false,
      axes: [
        { key: 'vx', label: 'vx', color: '#1976D2' },
        { key: 'vy', label: 'vy', color: '#E69F00' },
        { key: 'wz', label: 'wz', color: '#9C27B0' }
      ],
      limitDrafts: defaultLimits(),
      savedList: [],
      listError: '',
      statusMsg: '',
      statusIsError: false,
      durationInput: appState.editorSequence?.duration ?? 15,
      // A test is saved as <category>/<test name>; a new category is just a new name here.
      category: splitTestFile(appState.editorFile).category,
      testName: splitTestFile(appState.editorFile).testName
    };
  },
  computed: {
    file: {
      get() {
        // No category means the single Hub config "default", so a benchmark
        // without categories still loads as plain `load_dataset(repo)`.
        const category = String(this.category ?? '').trim() || 'default';
        const testName = this.testName.trim();
        return testName ? `${category}/${testName}.json` : '';
      },
      set(value) {
        const { category, testName } = splitTestFile(value);
        this.category = category === 'default' ? '' : category;
        this.testName = testName;
      }
    },
    categories() {
      return [...new Set(this.savedList.map((item) => item.folder).filter((f) => f && f !== 'default'))].sort();
    },
    savedGroups() {
      const groups = new Map();
      for (const item of this.savedList) {
        const category = item.folder || '(none)';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(item);
      }
      return [...groups].map(([category, items]) => ({ category, items }));
    },
    idError() {
      const category = String(this.category ?? '').trim();
      const testName = this.testName.trim();
      if (!category && !testName) return '';
      if (category && !SLUG_RE.test(category)) return 'Category: lower case letters, digits and _ (e.g. push_walking)';
      if (category === ALL_CONFIG) return `Category "${ALL_CONFIG}" is reserved (the dataset config holding every test)`;
      if (!testName) return 'Type a Name to give the test a file name';
      if (!SLUG_RE.test(testName)) return 'Test name (from Name): lower case letters, digits and _ (e.g. chest_front)';
      return '';
    },
    working() {
      return appState.editorSequence;
    },
    bodyNames() {
      return appState.bodyNames;
    },
    // The test must last past its last keypoint, and past its last push's end by PUSH_END_MARGIN_S.
    lastT() {
      const cmds = this.working?.commands ?? [];
      const events = Array.isArray(this.working?.events) ? this.working.events : [];
      return Math.max(cmds.length ? cmds[cmds.length - 1].t : 0, ...events.map((ev) => ev.t + (ev.duration ?? 0) + PUSH_END_MARGIN_S));
    },
    minDuration() {
      return Math.ceil(this.lastT);
    },
    durationError() {
      const d = Number(this.durationInput);
      if (!Number.isFinite(d) || d <= 0) return 'Duration must be a positive number';
      if (d > MAX_DURATION) return `Duration cannot exceed ${MAX_DURATION}s`;
      if (d < this.lastT) return `Duration must be ≥ ${this.lastT.toFixed(1)}s (the last keypoint, or ${PUSH_END_MARGIN_S}s after the last push ends)`;
      return '';
    },
    canSave() {
      return this.durationError === '' && this.idError === '' && this.file.length > 0 && !this.terrainErrors.length && !this.goalErrors.length;
    },
    goalErrors() {
      return this.working?.goal ? validateGoal(this.working.goal) : [];
    },
    hasGoal: {
      get() {
        return !!this.working?.goal;
      },
      set(on) {
        if (!on) {
          this.working.goal = null;
          return;
        }
        // Default: where the commands end the path, 1 m radius.
        this.working.goal = { ...commandedEnd(this.working), radius_m: 1 };
      },
    },
    terrainTypeItems() {
      return [
        { title: 'flat floor', value: 'none' },
        ...Object.entries(TERRAIN_TYPES).map(([value, def]) => ({ title: def.label, value })),
      ];
    },
    terrainType: {
      get() {
        return this.working?.terrain?.type ?? 'none';
      },
      set(type) {
        if (type === 'none') {
          delete this.working.terrain;
          this.terrainErrors = [];
        } else if (type !== this.working.terrain?.type) {
          this.working.terrain = defaultTerrain(type);
        }
        this.setStatus('');
      }
    },
    terrainParams() {
      const def = TERRAIN_TYPES[this.working?.terrain?.type];
      if (!def) return [];
      return Object.entries(def.params).map(([key, p]) => ({
        key, ...p, step: p.max <= 1 ? 0.01 : p.max <= 5 ? 0.05 : 0.5,
      }));
    },
    terrainDescription() {
      return TERRAIN_TYPES[this.working?.terrain?.type]?.description ?? '';
    },
    frictionPreset: {
      get() {
        const f = this.working?.footFriction;
        if (this.customFrictionMode) return 'custom';
        if (f === undefined || f === null) return 'scene';
        return FRICTION_PRESETS.find((p) => p.friction === f)?.value ?? 'custom';
      },
      set(value) {
        this.customFrictionMode = value === 'custom';
        const preset = FRICTION_PRESETS.find((p) => p.value === value);
        if (value === 'scene') delete this.working.footFriction;
        else if (preset?.friction) this.working.footFriction = preset.friction;
        else if (!Number.isFinite(this.working.footFriction)) this.working.footFriction = 0.6;
        this.setStatus('');
      }
    },
    customFriction: {
      get() {
        return this.working?.footFriction ?? 0.6;
      },
      set(value) {
        const f = Number(value);
        if (Number.isFinite(f) && f > 0) this.working.footFriction = Math.round(f * 1000) / 1000;
      }
    },
    // The test's opted-in metrics; older sequences only carry the gaitSymmetry flag.
    metricsOptIn() {
      return this.working?.metricsOptIn ?? (this.working?.gaitSymmetry === true ? ['gait_symmetry'] : []);
    },
    settingsHasError() {
      return this.durationError !== '' || this.idError !== '';
    },
    environmentHasError() {
      return this.terrainErrors.length > 0 || this.goalErrors.length > 0;
    },
  },
  methods: {
    setStatus(msg, isError = false) {
      this.statusMsg = msg;
      this.statusIsError = isError;
    },
    async refreshList() {
      try {
        this.savedList = await listSequences();
        this.listError = '';
      } catch (e) {
        this.listError = `Persistence API unavailable: ${e.message}`;
        this.savedList = [];
      }
    },
    onNameChange() {
      // The test name derives from the human-readable Name, but results refer
      // to tests by id, so a test keeps its id once saved.
      if (!appState.editorFile) {
        this.testName = this.working.name.trim() ? slugify(this.working.name).replace(/\.json$/, '') : '';
      }
    },
    onDurationChange() {
      const d = Number(this.durationInput);
      if (Number.isFinite(d) && d > 0 && d <= MAX_DURATION && d >= this.lastT) {
        this.working.duration = Math.round(d * 100) / 100;
      }
    },
    heldAt(axis, t) {
      // value in effect at time t = last keypoint at or before t, else 0
      let value = 0;
      for (const c of this.working.commands) {
        if (c.t <= t + 1e-9) value = c[axis] ?? 0;
        else break;
      }
      return value;
    },
    movePoint(axis, index, t, value) {
      const cmd = this.working.commands[index];
      if (!cmd) return;
      cmd.t = t;
      cmd[axis] = value;
      this.setStatus('');
    },
    addPoint(axis, t, value) {
      const key = Math.round(t * 1000);
      const existing = this.working.commands.find((c) => Math.round(c.t * 1000) === key);
      if (existing) {
        existing[axis] = value;
      } else {
        const cmd = {
          t,
          vx: this.heldAt('vx', t),
          vy: this.heldAt('vy', t),
          wz: this.heldAt('wz', t)
        };
        cmd[axis] = value;
        this.working.commands.push(cmd);
        this.working.commands.sort((a, b) => a.t - b.t);
      }
      this.setStatus('');
    },
    deletePoint(index) {
      if (this.working.commands.length <= 1) {
        this.setStatus('Cannot delete the last remaining keypoint', true);
        return;
      }
      this.working.commands.splice(index, 1);
      this.setStatus('');
    },
    ensureEvents() {
      if (!Array.isArray(this.working.events)) this.working.events = [];
    },
    addEvent(t, dir = [1, 0, 0], force = 200, duration = 0.15) {
      this.working.events.push({ t, type: 'push', dir: [...dir], force, duration });
      this.working.events.sort((a, b) => a.t - b.t);
      this.setStatus('');
    },
    moveEvent(index, t) {
      const ev = this.working.events[index];
      if (!ev) return;
      ev.t = t;
      this.working.events.sort((a, b) => a.t - b.t);
      this.setStatus('');
    },
    deleteEvent(index) {
      this.working.events.splice(index, 1);
      this.setStatus('');
    },
    snapGoalToPathEnd() {
      this.working.goal = { ...this.working.goal, ...commandedEnd(this.working) };
      this.setStatus('');
    },
    setMetricOptIn(metric, on) {
      const set = new Set(this.metricsOptIn);
      if (on) set.add(metric); else set.delete(metric);
      this.working.metricsOptIn = OPT_IN_METRICS.filter((m) => set.has(m));
      if (set.has('gait_symmetry')) this.working.gaitSymmetry = true;
      else delete this.working.gaitSymmetry;
      this.setStatus('');
    },
    setGoalParam(key, value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      this.working.goal = { ...this.working.goal, [key]: key === 'radius_m' ? number : roundGoal(number) };
      this.setStatus('');
    },
    setTerrainParam(key, value) {
      const number = Number(value);
      if (value === '' || !Number.isFinite(number)) return;
      this.working.terrain = { ...this.working.terrain, [key]: number };
      this.setStatus('');
    },
    updateEvent(index, patch) {
      const ev = this.working.events[index];
      if (!ev) return;
      if (patch.dir) ev.dir = [...patch.dir];
      if (patch.force != null) ev.force = patch.force;
      if (patch.duration != null) ev.duration = patch.duration;
      // Torque/targetBody use 'in' rather than != null so an explicit null
      // (from the "add rotational torque" toggle, or picking "default" in the
      // body select) actually clears them, instead of being skipped like a
      // missing key would be.
      if ('torqueAxis' in patch) {
        if (patch.torqueAxis == null) delete ev.torqueAxis;
        else ev.torqueAxis = [...patch.torqueAxis];
      }
      if ('torqueMag' in patch) {
        if (patch.torqueMag == null) delete ev.torqueMag;
        else ev.torqueMag = patch.torqueMag;
      }
      if ('targetBody' in patch) {
        if (patch.targetBody == null) delete ev.targetBody;
        else ev.targetBody = patch.targetBody;
      }
      this.setStatus('');
    },
    ensureLimits() {
      const def = defaultLimits();
      if (!this.working.limits || typeof this.working.limits !== 'object') {
        this.working.limits = def;
        return;
      }
      for (const a of ['vx', 'vy', 'wz']) {
        const p = this.working.limits[a];
        if (!Array.isArray(p) || p.length !== 2 || !(Number(p[0]) < Number(p[1]))) {
          this.working.limits[a] = def[a];
        }
      }
    },
    syncLimitDrafts() {
      this.limitDrafts = {
        vx: [...this.working.limits.vx],
        vy: [...this.working.limits.vy],
        wz: [...this.working.limits.wz]
      };
    },
    // Rescale an axis's keypoints when its range changes, keeping each value at
    // the same % of max/min (positive and negative halves scaled separately so
    // zeros stay at zero): v>0 maps oldMax->newMax, v<0 maps oldMin->newMin.
    rescaleAboutZero(axis, oldLo, oldHi, newLo, newHi) {
      for (const c of this.working.commands) {
        const v = c[axis] ?? 0;
        let nv;
        if (v > 0) nv = oldHi > 0 ? (v / oldHi) * newHi : 0;
        else if (v < 0) nv = oldLo < 0 ? (v / oldLo) * newLo : 0;
        else nv = 0;
        nv = Math.min(Math.max(nv, newLo), newHi); // float-safety clamp
        c[axis] = Math.round(nv * 1000) / 1000;
      }
    },
    // Commit an edited min/max (called on blur/change so mid-typing values
    // don't rescale prematurely). Enforces min < max and a sane bound, then
    // rescales the axis's keypoints so they follow the new range (% of max/min).
    commitLimit(axis) {
      const ABS = 20;
      const GAP = 0.05;
      const [oldLo, oldHi] = this.working.limits[axis];
      let lo = Number(this.limitDrafts[axis][0]);
      let hi = Number(this.limitDrafts[axis][1]);
      if (!Number.isFinite(lo)) lo = oldLo;
      if (!Number.isFinite(hi)) hi = oldHi;
      lo = Math.min(Math.max(lo, -ABS), ABS);
      hi = Math.min(Math.max(hi, -ABS), ABS);
      if (lo >= hi) hi = lo + GAP;
      lo = Math.round(lo * 1000) / 1000;
      hi = Math.round(hi * 1000) / 1000;
      this.rescaleAboutZero(axis, oldLo, oldHi, lo, hi);
      this.working.limits[axis] = [lo, hi];
      this.limitDrafts[axis] = [lo, hi];
      this.setStatus('');
    },
    copyLimitsToAll(axis) {
      // Copy this axis's [min,max] to every axis, rescaling each axis's keypoints
      // about zero so they keep the same % of max/min (visual shape follows range).
      const [nlo, nhi] = this.working.limits[axis];
      for (const a of ['vx', 'vy', 'wz']) {
        if (a !== axis) {
          const [olo, ohi] = this.working.limits[a];
          this.rescaleAboutZero(a, olo, ohi, nlo, nhi);
          this.working.limits[a] = [nlo, nhi];
          this.limitDrafts[a] = [nlo, nhi];
        }
      }
      this.setStatus(`Copied ${axis} limits to all axes (scaled about zero)`);
    },
    createNew() {
      newBlankSequence();
      this.durationInput = this.working.duration;
      // Keep the category: a new test usually goes next to the last one.
      this.testName = '';
      this.ensureLimits();
      this.ensureEvents();
      this.syncLimitDrafts();
      this.setStatus('New blank trajectory (15s)');
    },
    async openSaved(fileName) {
      try {
        const seq = await loadSequenceFile(fileName);
        appState.editorSequence = { ...JSON.parse(JSON.stringify(seq)), _savedLimits: !!seq.limits };
        appState.editorFile = fileName;
        this.file = fileName;
        this.durationInput = this.working.duration;
        this.ensureLimits();
        this.ensureEvents();
        this.syncLimitDrafts();
        this.setStatus(`Loaded ${fileName}`);
      } catch (e) {
        this.setStatus(`Load failed: ${e.message}`, true);
      }
    },
    buildClean() {
      const limits = {
        vx: [...this.working.limits.vx],
        vy: [...this.working.limits.vy],
        wz: [...this.working.limits.wz]
      };
      // A test's own limits override every policy's trained command range, so
      // only save them when the test had them or they were changed here; the
      // defaults ensureLimits() fills in for editing must not be baked in.
      const changed = JSON.stringify(limits) !== JSON.stringify(defaultLimits());
      const clean = {
        name: this.working.name || 'sequence',
        duration: Number(this.working.duration),
        ...(this.working.terrain ? { terrain: { ...this.working.terrain } } : {}),
        ...(this.working._savedLimits || changed ? { limits } : {}),
        commands: this.working.commands.map((c) => ({
          t: Math.round(c.t * 1000) / 1000,
          vx: Math.round((c.vx ?? 0) * 1000) / 1000,
          vy: Math.round((c.vy ?? 0) * 1000) / 1000,
          wz: Math.round((c.wz ?? 0) * 1000) / 1000
        }))
      };
      const events = Array.isArray(this.working.events) ? this.working.events : [];
      if (events.length) {
        clean.events = events.map((ev) => {
          const out = {
            t: Math.round((ev.t ?? 0) * 1000) / 1000,
            type: ev.type || 'push',
            dir: [
              Number(ev.dir?.[0] ?? 1),
              Number(ev.dir?.[1] ?? 0),
              Number(ev.dir?.[2] ?? 0)
            ].map((v) => Math.round(v * 1000) / 1000),
            force: Math.round((ev.force ?? 200) * 1000) / 1000,
            duration: Math.round((ev.duration ?? 0.15) * 1000) / 1000
          };
          // Torque is optional — only emit the pair when both fields are set
          // (matches the validators' both-or-neither rule).
          if (Array.isArray(ev.torqueAxis) && Number.isFinite(Number(ev.torqueMag)) && Number(ev.torqueMag) !== 0) {
            out.torqueAxis = [
              Number(ev.torqueAxis[0] ?? 0),
              Number(ev.torqueAxis[1] ?? 0),
              Number(ev.torqueAxis[2] ?? 1)
            ].map((v) => Math.round(v * 1000) / 1000);
            out.torqueMag = Math.round(Number(ev.torqueMag) * 1000) / 1000;
          }
          // Which body the force/torque applies to (default: pelvis).
          if (typeof ev.targetBody === 'string' && ev.targetBody) out.targetBody = ev.targetBody;
          // Kept as loaded: the label shown in reports.
          if (typeof ev.label === 'string' && ev.label) out.label = ev.label;
          return out;
        });
      }
      // Floor grip and the gait-symmetry opt-in (Environment panel).
      if (Number.isFinite(Number(this.working.footFriction)) && this.working.footFriction !== null) {
        clean.footFriction = Number(this.working.footFriction);
      }
      if (this.metricsOptIn.length) clean.metricsOptIn = [...this.metricsOptIn];
      if (this.metricsOptIn.includes('gait_symmetry')) clean.gaitSymmetry = true;
      if (this.working.goal) clean.goal = { ...this.working.goal };
      return clean;
    },
    async save() {
      if (!this.canSave) return;
      let fileName = this.file.trim();
      if (!/\.json$/i.test(fileName)) fileName += '.json';
      try {
        await saveSequenceFile(fileName, this.buildClean());
        appState.editorFile = fileName;
        this.file = fileName;
        await this.refreshList();
        this.setStatus(`Saved ${fileName}`);
      } catch (e) {
        this.setStatus(`Save failed: ${e.message}`, true);
      }
    },
    async removeSaved(fileName) {
      try {
        await deleteSequenceFile(fileName);
        if (this.file === fileName) appState.editorFile = null;
        await this.refreshList();
        this.setStatus(`Deleted ${fileName}`);
      } catch (e) {
        this.setStatus(`Delete failed: ${e.message}`, true);
      }
    },
    async applyToViewer() {
      if (this.durationError !== '' || this.terrainErrors.length) return;
      try {
        const clean = this.buildClean();
        // The viewer plays the test on its course (or back on the flat floor).
        if (demoRef.current) await loadTestScene(demoRef.current, clean.terrain);
        const { warning } = commandSequencer.loadSequence(clean, this.working.name);
        this.setStatus(warning || 'Applied to viewer');
      } catch (e) {
        this.setStatus(`Apply failed: ${e.message}`, true);
      }
    },
    exportJson() {
      const blob = new Blob([JSON.stringify(this.buildClean(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (this.testName.trim() || slugify(this.working.name));
      if (!/\.json$/i.test(link.download)) link.download += '.json';
      link.click();
      URL.revokeObjectURL(url);
    },
    back() {
      closeEditor();
    }
  },
  created() {
    if (!appState.editorSequence) newBlankSequence();
    this.durationInput = appState.editorSequence.duration;
    this.file = appState.editorFile ?? '';
    this.ensureLimits();
    this.ensureEvents();
    this.syncLimitDrafts();
    this.refreshList();
  }
};
</script>

<style scoped>
.editor-page {
  min-height: 100vh;
  background: #f5f5f5;
}
.editor-body {
  display: flex;
  gap: 16px;
  padding: 16px;
  max-width: 1280px;
  margin: 0 auto;
}
.editor-sidebar {
  width: 260px;
  flex-shrink: 0;
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  height: fit-content;
}
.editor-main {
  flex: 1;
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  min-width: 0;
}
.editor-fields {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.charts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
}
.env-section {
  border-top: 1px solid #eee;
  padding-top: 8px;
}
.limit-axis {
  font: 600 12px monospace;
  width: 28px;
}
.tab-error { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: rgb(var(--v-theme-error)); }
</style>
