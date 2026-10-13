<template>
  <v-dialog :model-value="modelValue" max-width="760" scrollable @update:modelValue="(v) => $emit('update:modelValue', v)">
    <v-card>
      <v-card-title class="text-subtitle-1 d-flex align-center">
        <v-icon size="18" class="mr-2">mdi-cog-outline</v-icon>
        {{ benchmarkTitle || 'Benchmark' }} settings
        <span class="text-caption text-medium-emphasis ml-2">benchmark.yaml</span>
      </v-card-title>
      <v-tabs v-model="tab" density="compact" class="px-4">
        <v-tab value="form" :disabled="!form">Settings</v-tab>
        <v-tab value="yaml">benchmark.yaml</v-tab>
      </v-tabs>

      <v-card-text class="pt-3">
        <v-progress-linear v-if="loading" indeterminate class="mb-3" />
        <v-alert v-if="error" type="error" density="compact" class="mb-3 pre-line">{{ error }}</v-alert>
        <v-alert v-if="!error && fileErrors.length" type="error" density="compact" class="mb-3">
          benchmark.yaml has problems; <code>npm run benchmark</code> refuses it until they are fixed:
          <ul class="ml-4"><li v-for="p in fileErrors" :key="p">{{ p }}</li></ul>
        </v-alert>
        <v-alert v-if="warnings.length" type="warning" density="compact" class="mb-3">
          {{ savedNote }}<code>npm run benchmark</code> would stop on:
          <ul class="ml-4"><li v-for="w in warnings" :key="w">{{ w }}</li></ul>
        </v-alert>

        <v-window v-model="tab">
          <v-window-item value="form">
            <div v-if="form">
              <div class="text-caption text-medium-emphasis mb-3">
                These settings are how <code>npm run benchmark</code> runs and scores this benchmark (repeats,
                seeds, randomisation, leaderboard tasks). The viewer's Run button plays each test once and does
                not use them.
              </div>

              <v-text-field v-model="form.title" label="Title" density="compact" variant="outlined" hide-details class="mb-3" />
              <v-textarea
                v-model="form.description" label="Description" rows="2" auto-grow
                density="compact" variant="outlined" hide-details class="mb-3"
              />
              <div class="d-flex align-center ga-3 mb-1">
                <v-text-field
                  v-model.number="form.version" label="Version" type="number" min="1" step="1"
                  density="compact" variant="outlined" hide-details style="max-width: 120px"
                />
                <span class="text-caption text-medium-emphasis">
                  Leaderboard task ids end in <code>_v{{ form.version }}</code>; bump the version whenever a change
                  can move a score, so old and new numbers never share a leaderboard.
                </span>
              </div>
              <v-alert v-if="needsBump" type="info" density="compact" variant="tonal" class="mb-3 mt-2">
                These changes can move scores.
                <template #append>
                  <v-btn size="small" variant="text" @click="form.version = original.version + 1">
                    Bump to {{ original.version + 1 }}
                  </v-btn>
                </template>
              </v-alert>

              <div class="section-title">Every test, unless a test entry below says otherwise</div>
              <div class="d-flex ga-3 mb-3">
                <v-text-field
                  v-model.number="form.repeats" label="Repeats" type="number" min="1" step="1"
                  hint="Runs per test, each with its own seed" persistent-hint density="compact" variant="outlined"
                />
                <v-text-field
                  v-model.number="form.seed" label="Seed" type="number" step="1"
                  hint="Repeat i of test t uses a seed derived from (seed, t, i)" persistent-hint density="compact" variant="outlined"
                />
                <v-text-field
                  v-model.number="form.timeout_s" label="Timeout (s)" type="number" min="1"
                  hint="Wall-clock budget per run" persistent-hint density="compact" variant="outlined"
                />
              </div>
              <div class="d-flex ga-3 mb-4">
                <v-select
                  v-model="form.action_delay" :items="actionDelayItems" label="Action delay"
                  hint="Delay between the policy's output and the motors" persistent-hint
                  density="compact" variant="outlined"
                />
                <v-text-field
                  v-model.number="form.initial_joint_noise_rad" label="Initial joint noise (rad)" type="number" min="0" step="0.01"
                  hint="Random offset added to each joint at the start; 0 = none" persistent-hint
                  density="compact" variant="outlined" style="max-width: 240px"
                />
              </div>

              <div class="section-title d-flex align-center">
                Tests
                <span class="text-caption text-medium-emphasis ml-2">which tests run; later entries override earlier ones</span>
                <v-spacer />
                <v-btn size="x-small" variant="text" prepend-icon="mdi-plus" @click="form.tests.push({ all: true })">Add</v-btn>
              </div>
              <div v-for="(entry, i) in form.tests" :key="'t' + i" class="d-flex align-center ga-2 mb-2">
                <v-select
                  :model-value="selectorKind(entry)" :items="selectorItems" density="compact" variant="outlined"
                  hide-details style="max-width: 150px" @update:modelValue="(kind) => setSelectorKind(entry, kind)"
                />
                <v-combobox
                  v-if="selectorKind(entry) !== 'all'"
                  v-model="entry[selectorKind(entry)]"
                  :items="selectorKind(entry) === 'config' ? configs : testIds"
                  :label="selectorKind(entry) === 'config' ? 'Category' : 'Test id'"
                  density="compact" variant="outlined" hide-details
                />
                <v-spacer v-else />
                <v-text-field
                  v-model.number="entry.repeats" label="Repeats" type="number" min="1" placeholder="default"
                  density="compact" variant="outlined" hide-details style="max-width: 110px"
                />
                <span v-if="extraKeys(entry).length" class="text-caption text-medium-emphasis" title="Edit these in the benchmark.yaml tab">
                  + {{ extraKeys(entry).join(', ') }}
                </span>
                <v-btn icon size="x-small" variant="text" title="Remove" @click="form.tests.splice(i, 1)">
                  <v-icon size="16">mdi-close</v-icon>
                </v-btn>
              </div>

              <div class="section-title d-flex align-center mt-4">
                Leaderboard tasks
                <span class="text-caption text-medium-emphasis ml-2">one leaderboard number each</span>
                <v-spacer />
                <v-btn size="x-small" variant="text" prepend-icon="mdi-plus" @click="addTask">Add</v-btn>
              </div>
              <div v-for="(task, i) in form.tasks" :key="'k' + i" class="d-flex align-center ga-2 mb-2">
                <v-text-field
                  v-model="task.id" label="Task id" placeholder="push_survival_rate"
                  density="compact" variant="outlined" hide-details
                />
                <v-select
                  v-model="task.metric" :items="metricItems" label="Metric"
                  density="compact" variant="outlined" hide-details style="max-width: 190px"
                />
                <template v-if="editableScope(task)">
                  <v-combobox
                    v-model="task.scope.config" :items="configs" label="Only category" placeholder="any"
                    density="compact" variant="outlined" hide-details style="max-width: 170px"
                  />
                  <v-text-field
                    v-model="task.scope.tag" label="Only tag" placeholder="any"
                    density="compact" variant="outlined" hide-details style="max-width: 120px"
                  />
                </template>
                <span v-else class="text-caption text-medium-emphasis" title="Edit this scope in the benchmark.yaml tab">
                  scope: {{ JSON.stringify(task.scope) }}
                </span>
                <v-btn icon size="x-small" variant="text" title="Remove" @click="form.tasks.splice(i, 1)">
                  <v-icon size="16">mdi-close</v-icon>
                </v-btn>
              </div>
            </div>
          </v-window-item>

          <v-window-item value="yaml">
            <v-alert v-if="formDirty" type="info" density="compact" variant="tonal" class="mb-2">
              Your changes on the Settings tab are not in this text; saving here discards them.
            </v-alert>
            <v-textarea
              v-model="draftText" class="yaml-text" rows="22" variant="outlined"
              hide-details spellcheck="false" autocomplete="off"
            />
            <div class="text-caption text-medium-emphasis mt-1">
              Every key is described in docs/benchmarks.md. Saving checks the file the way
              <code>npm run benchmark</code> does.
            </div>
          </v-window-item>
        </v-window>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">Close</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="loading || !dirty" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script>
import { RANDOMIZERS } from '@/benchmark/protocol.js';
import { METRICS } from '@/benchmark/summary.js';
import { loadBenchmarkSettings, saveBenchmarkSettings } from '@/state/testStore.js';

const SELECTOR_KEYS = ['all', 'config', 'id'];
const copy = (value) => JSON.parse(JSON.stringify(value));
// What the form's fields would write, without the blanks an empty row or scope leaves.
const scored = (form) => JSON.stringify([
  form.repeats, form.seed, form.timeout_s, form.action_delay, form.initial_joint_noise_rad,
  form.tests.map(withoutBlanks), form.tasks.map(withoutBlanks),
]);
function withoutBlanks(entry) {
  const clean = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === '' || value === null || value === undefined) continue;
    if (key === 'scope') {
      const scope = withoutBlanks(value);
      if (Object.keys(scope).length) clean.scope = scope;
    } else clean[key] = value;
  }
  return clean;
}
// A task's scope in the form always has config and tag, so the fields can bind to them.
const formTask = (task) => ({ ...task, scope: { config: '', tag: '', ...(task.scope ?? {}) } });

// Edits a benchmark's benchmark.yaml (through the dev server's /api/benchmark): the
// common settings as a form, or the whole file as text.
export default {
  name: 'BenchmarkSettingsDialog',
  props: {
    modelValue: { type: Boolean, default: false },
    benchmark: { type: String, default: null }, // benchmark key; null = the server's default
    benchmarkTitle: { type: String, default: '' }
  },
  emits: ['update:modelValue', 'saved'],
  data() {
    return {
      tab: 'form',
      loading: false,
      saving: false,
      error: '',
      fileErrors: [],
      warnings: [],
      savedNote: '',
      text: '', // benchmark.yaml as loaded or last saved
      draftText: '',
      form: null,
      original: null,
      configs: [],
      testIds: [],
      actionDelayItems: [
        { title: 'Not set (same as midpoint)', value: null },
        ...RANDOMIZERS.action_delay.map((value) => ({
          title: value === 'env_range' ? 'env_range: drawn per repeat from the policy\'s range' : 'midpoint: fixed, middle of the policy\'s range',
          value
        }))
      ],
      selectorItems: [
        { title: 'All tests', value: 'all' },
        { title: 'Category', value: 'config' },
        { title: 'One test', value: 'id' }
      ],
      metricItems: Object.keys(METRICS)
    };
  },
  computed: {
    formDirty() {
      return !!this.form && JSON.stringify(this.prepared(this.form)) !== JSON.stringify(this.prepared(this.original));
    },
    dirty() {
      return this.tab === 'yaml' ? this.draftText !== this.text : this.formDirty;
    },
    needsBump() {
      return !!this.form && this.form.version === this.original.version && scored(this.form) !== scored(this.original);
    }
  },
  watch: {
    modelValue(open) {
      if (open) this.load();
    }
  },
  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      this.savedNote = '';
      try {
        this.show(await loadBenchmarkSettings(this.benchmark));
        this.tab = this.form ? 'form' : 'yaml';
      } catch (e) {
        this.error = e?.message || 'Could not read benchmark.yaml';
      } finally {
        this.loading = false;
      }
    },
    show(result) {
      this.text = result.text;
      this.draftText = result.text;
      this.fileErrors = result.errors || [];
      this.warnings = result.warnings || [];
      this.configs = result.configs || [];
      this.testIds = result.testIds || [];
      this.form = result.fields ? { ...copy(result.fields), tasks: result.fields.tasks.map(formTask) } : null;
      this.original = this.form ? copy(this.form) : null;
    },
    /** The form as the server takes it: { fields }. */
    prepared(form) {
      return { ...form, tests: form.tests.map(withoutBlanks), tasks: form.tasks.map(withoutBlanks) };
    },
    async save() {
      this.saving = true;
      this.error = '';
      try {
        const edit = this.tab === 'yaml' ? { text: this.draftText } : { fields: this.prepared(this.form) };
        const result = await saveBenchmarkSettings(this.benchmark, edit, this.text);
        this.show(result);
        this.$emit('saved');
        if (this.warnings.length) this.savedNote = 'Saved. ';
        else this.$emit('update:modelValue', false);
      } catch (e) {
        this.error = e?.message || 'Could not save benchmark.yaml';
      } finally {
        this.saving = false;
      }
    },
    selectorKind(entry) {
      return SELECTOR_KEYS.find((key) => key in entry) ?? 'all';
    },
    setSelectorKind(entry, kind) {
      for (const key of SELECTOR_KEYS) delete entry[key];
      entry[kind] = kind === 'all' ? true : '';
    },
    /** Settings a test entry overrides that the form has no field for. */
    extraKeys(entry) {
      return Object.keys(entry).filter((key) => !SELECTOR_KEYS.includes(key) && key !== 'repeats');
    },
    /** A scope of single values on config and/or tag; anything else (lists, id) is left to the text tab. */
    editableScope(task) {
      return Object.entries(task.scope).every(([key, value]) => ['config', 'tag'].includes(key) && !Array.isArray(value));
    },
    addTask() {
      this.form.tasks.push(formTask({ id: '', metric: this.metricItems[0] }));
    }
  }
};
</script>

<style scoped>
.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pre-line {
  white-space: pre-line;
}
.yaml-text :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.45;
}
</style>
