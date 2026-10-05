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
        <div class="editor-fields">
          <v-text-field
            v-model="working.name" label="Name" density="compact" hide-details
            style="max-width: 240px" @update:modelValue="onNameChange"
          ></v-text-field>
          <v-combobox
            v-model="category" :items="categories" label="Category" density="compact" hide-details
            placeholder="pick or type a new one" style="max-width: 200px"
          ></v-combobox>
          <v-text-field
            v-model="testName" label="Test name" density="compact" hide-details
            placeholder="my_test" style="max-width: 200px"
          ></v-text-field>
          <v-text-field
            v-model.number="durationInput" label="Duration (s)" type="number"
            density="compact" hide-details :min="minDuration" :max="MAX_DURATION" step="1"
            style="max-width: 140px"
            :error="durationError !== ''" @update:modelValue="onDurationChange"
          ></v-text-field>
        </div>
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

        <v-divider class="mb-2"></v-divider>
        <div class="text-subtitle-2 mb-1">Derived quantities (robot mass ≈ {{ mass.toFixed(1) }} kg)</div>
        <div class="charts">
          <DerivedChart kind="momentum" :commands="working.commands" :duration="working.duration"
            :mass="mass" :v-max="momentumVMax" label="Linear momentum (M·v)" />
          <DerivedChart kind="impulse" :commands="working.commands" :duration="working.duration"
            :mass="mass" :v-max="momentumVMax" label="Impulse |Δp| per keypoint transition" />
        </div>
        <div class="text-caption text-disabled mb-3">
          command-derived: momentum = mass × commanded velocity; impulse = mass × |Δv| at each step.
          Angular terms (wz) are omitted — whole-body yaw inertia varies with pose.
        </div>

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
import DerivedChart from '@/components/DerivedChart.vue';
import PushLane from '@/components/PushLane.vue';
import { appState, closeEditor, newBlankSequence, defaultLimits, MAX_DURATION } from '@/state/appState.js';
import { listSequences, loadSequenceFile, saveSequenceFile, deleteSequenceFile, slugify } from '@/state/sequenceStore.js';
import { STATIC } from '@/state/viewerMode.js';
import { commandSequencer } from '@/simulation/commandSequencer.js';

// Category and test name: the two halves of a test id (<category>/<name>).
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

function splitTestFile(file) {
  const id = String(file ?? '').replace(/\.json$/i, '');
  const slash = id.indexOf('/');
  return slash < 0 ? { category: '', testName: id } : { category: id.slice(0, slash), testName: id.slice(slash + 1) };
}

export default {
  name: 'TrajectoryEditor',
  components: { KeypointChart, DerivedChart, PushLane },
  data() {
    return {
      STATIC,
      MAX_DURATION,
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
        const category = String(this.category ?? '').trim();
        const testName = this.testName.trim();
        return category && testName ? `${category}/${testName}.json` : '';
      },
      set(value) {
        ({ category: this.category, testName: this.testName } = splitTestFile(value));
      }
    },
    categories() {
      return [...new Set(this.savedList.map((item) => item.folder).filter(Boolean))].sort();
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
      if (!SLUG_RE.test(category)) return 'Category: lower case letters, digits and _ (e.g. push_walking)';
      if (!SLUG_RE.test(testName)) return 'Test name: lower case letters, digits and _ (e.g. chest_front)';
      return '';
    },
    working() {
      return appState.editorSequence;
    },
    mass() {
      return appState.mass;
    },
    bodyNames() {
      return appState.bodyNames;
    },
    momentumVMax() {
      const l = this.working?.limits;
      if (!l) return 1.5;
      return Math.max(
        Math.abs(l.vx[0]), Math.abs(l.vx[1]),
        Math.abs(l.vy[0]), Math.abs(l.vy[1]),
        0.1
      );
    },
    lastT() {
      const cmds = this.working?.commands ?? [];
      return cmds.length ? cmds[cmds.length - 1].t : 0;
    },
    minDuration() {
      return Math.ceil(this.lastT);
    },
    durationError() {
      const d = Number(this.durationInput);
      if (!Number.isFinite(d) || d <= 0) return 'Duration must be a positive number';
      if (d > MAX_DURATION) return `Duration cannot exceed ${MAX_DURATION}s`;
      if (d < this.lastT) return `Duration must be ≥ last keypoint (${this.lastT.toFixed(1)}s)`;
      return '';
    },
    canSave() {
      return this.durationError === '' && this.idError === '' && this.file.length > 0;
    }
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
      if (!this.testName.trim()) this.testName = slugify(this.working.name).replace(/\.json$/, '');
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
        // A terrain test keeps its course (the editor has no control for it).
        ...(typeof this.working.terrain === 'string' && this.working.terrain ? { terrain: this.working.terrain } : {}),
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
          // Kept as loaded: the label shown in reports and the benchmark tier.
          if (typeof ev.label === 'string' && ev.label) out.label = ev.label;
          if (ev.tier === 'reasonable' || ev.tier === 'beyond') out.tier = ev.tier;
          return out;
        });
      }
      // Test settings the editor has no controls for are kept as loaded.
      if (Number.isFinite(Number(this.working.footFriction)) && this.working.footFriction !== null) {
        clean.footFriction = Number(this.working.footFriction);
      }
      if (this.working.gaitSymmetry === true) clean.gaitSymmetry = true;
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
    applyToViewer() {
      if (this.durationError !== '') return;
      try {
        const { warning } = commandSequencer.loadSequence(this.buildClean(), this.working.name);
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
.limit-axis {
  font: 600 12px monospace;
  width: 28px;
}
</style>
