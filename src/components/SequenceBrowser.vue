<template>
  <div class="sequence-browser">
    <div v-if="STATIC" class="text-caption text-medium-emphasis pa-2">
      Static deployment: tests below are the read-only bundle built by CI — edits
      and deletes aren't saved to disk. Use "Export JSON" in the editor to
      download your changes instead.
    </div>
    <!-- Toolbar -->
    <div class="d-flex align-center flex-wrap ga-1 mb-1">
      <v-btn
        density="compact"
        size="small"
        variant="text"
        prepend-icon="mdi-refresh"
        :loading="loading"
        @click="refresh"
      >Refresh</v-btn>
      <v-btn
        v-if="!STATIC"
        density="compact"
        size="small"
        variant="text"
        prepend-icon="mdi-folder-plus"
        :disabled="running"
        @click="startCreate"
      >New benchmark</v-btn>
    </div>

    <!-- New benchmark: a dataset folder under benchmark_datasets/ on the dev server -->
    <div v-if="creating" class="create-form pa-2 mb-1">
      <v-text-field
        v-model="newName"
        label="Folder name"
        placeholder="push-recovery"
        density="compact"
        hide-details="auto"
        :rules="[() => nameError || true]"
        autofocus
        @keydown.enter="create"
        @keydown.esc="creating = false"
      />
      <v-text-field
        v-model="newTitle"
        label="Title (optional)"
        density="compact"
        hide-details
        class="mt-1"
        @keydown.enter="create"
        @keydown.esc="creating = false"
      />
      <div class="d-flex align-center ga-1 mt-1">
        <v-spacer />
        <v-btn size="small" variant="text" @click="creating = false">Cancel</v-btn>
        <v-btn
          size="small"
          color="primary"
          variant="flat"
          :disabled="!newName || !!nameError"
          :loading="createBusy"
          @click="create"
        >Create</v-btn>
      </div>
    </div>

    <v-alert v-if="error" type="error" density="compact" class="my-1">{{ error }}</v-alert>

    <div v-if="!loading && !suites.length" class="text-caption text-medium-emphasis pa-2">
      No benchmarks found.
    </div>

    <!-- Benchmarks; the open one shows its tests by category -->
    <div class="tree-root">
      <div v-for="suite in suites" :key="suite.key ?? ''" class="suite">
        <div
          class="row suite-row d-flex align-center ga-1"
          :class="{ current: isCurrent(suite) }"
          :title="(suite.description ? suite.description + '\n' : '') + 'Click to open, double-click to run every test'"
          @click="openSuite(suite)"
          @dblclick="runSuite(suite)"
        >
          <v-icon size="14" class="flex-shrink-0" @click.stop="toggleCollapse(suite)">
            {{ isOpen(suite) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
          </v-icon>
          <v-icon size="14" class="text-medium-emphasis flex-shrink-0">
            {{ isOpen(suite) ? 'mdi-folder-open' : 'mdi-folder' }}
          </v-icon>
          <span class="name suite-name">{{ suite.title || suite.key }}</span>
          <v-progress-circular v-if="running && isCurrent(suite)" indeterminate size="12" width="2" color="primary" />
          <span class="badge count" title="tests">{{ isCurrent(suite) && loaded ? items.length : suite.testCount }}</span>
          <v-btn
            icon
            size="x-small"
            variant="text"
            title="Run every test"
            :disabled="running"
            @click.stop="runSuite(suite)"
          >
            <v-icon size="14">mdi-play</v-icon>
          </v-btn>
        </div>

        <div v-if="isOpen(suite)" class="suite-body">
          <div class="d-flex align-center">
            <span class="text-caption text-medium-emphasis">
              Tests to benchmark ({{ selection.length }}/{{ items.length }})
            </span>
            <v-spacer />
            <v-btn variant="text" size="x-small" :disabled="running" @click="selectAll(true)">all</v-btn>
            <v-btn variant="text" size="x-small" :disabled="running" @click="selectAll(false)">none</v-btn>
          </div>

          <div v-if="loaded && !items.length" class="text-caption text-medium-emphasis pa-1">
            No tests yet.
          </div>
          <SequenceNode
            v-for="folder in tree.folders"
            :key="'d:' + folder.path"
            :node="folder"
            :depth="1"
            :selection="selection"
            @toggle-select="toggleSelect"
            @play="onPlay"
            @edit="onEdit"
            @delete="onDelete"
          />
          <SequenceFileRow
            v-for="f in tree.files"
            :key="'f:' + f.file"
            :file="f"
            :depth="1"
            :checked="selection.includes(f.file)"
            @toggle-select="toggleSelect"
            @play="onPlay"
            @edit="onEdit"
            @delete="onDelete"
          />
          <div
            v-if="!STATIC"
            class="row add-row d-flex align-center ga-1"
            :style="{ paddingLeft: '18px' }"
            @click="$emit('new')"
          >
            <v-icon size="14" class="flex-shrink-0">mdi-plus</v-icon>
            <span class="name">Add test</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { appState } from '@/state/appState.js';
import { STATIC } from '@/state/viewerMode.js';
import { listSequences, listSuites, createSuite, deleteSequenceFile } from '@/state/sequenceStore.js';
import SequenceNode from './SequenceNode.vue';
import SequenceFileRow from './SequenceFileRow.vue';

const SUITE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** What appState.currentSuite holds for `suite`: null for the server's default. */
function suiteRef(suite) {
  return suite.session ? null : suite.key;
}

// The benchmarks the dev server knows, one open at a time: click a benchmark
// to open it (its tests, by category, are what the benchmark runs and what the
// editor saves into), double-click it to run every test. Inside, a test row
// works as before: double-click plays it, the pencil edits it.
export default {
  name: 'SequenceBrowser',
  components: { SequenceNode, SequenceFileRow },
  props: {
    running: { type: Boolean, default: false }
  },
  emits: ['play', 'edit', 'new', 'run'],
  data() {
    return {
      STATIC,
      suites: [],
      items: [], // tests of the open benchmark
      loaded: false,
      collapsed: false,
      loading: false,
      error: '',
      creating: false,
      createBusy: false,
      newName: '',
      newTitle: ''
    };
  },
  created() {
    // Parent owns appState; ensure the shared selection array exists so this
    // component is robust even if mounted before it's initialised elsewhere.
    if (!Array.isArray(appState.benchmarkSelection)) appState.benchmarkSelection = [];
    this.loadPromise = null;
  },
  computed: {
    selection() {
      return appState.benchmarkSelection;
    },
    nameError() {
      if (!this.newName) return '';
      if (!SUITE_NAME_RE.test(this.newName)) return 'Lower case letters, digits and - (e.g. push-recovery)';
      if (this.suites.some((s) => s.key.split('/').pop() === this.newName)) return 'A benchmark of that name exists';
      return '';
    },
    tree() {
      // Build a nested folder tree from the flat list's `folder` segments.
      const root = { name: '', path: '', folders: [], files: [], count: 0, _map: {} };
      const ensureFolder = (segments) => {
        let cur = root;
        let acc = '';
        for (const seg of segments) {
          acc = acc ? acc + '/' + seg : seg;
          if (!cur._map[seg]) {
            const child = { name: seg, path: acc, folders: [], files: [], count: 0, _map: {} };
            cur._map[seg] = child;
            cur.folders.push(child);
          }
          cur = cur._map[seg];
        }
        return cur;
      };
      for (const it of this.items) {
        const folderPath = (it.folder || '').replace(/^\/+|\/+$/g, '');
        const segments = folderPath ? folderPath.split('/') : [];
        ensureFolder(segments).files.push(it);
      }
      // Roll up counts (folder + descendant file totals) and sort.
      const finalize = (n) => {
        n.folders.sort((a, b) => a.name.localeCompare(b.name));
        n.files.sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
        let count = n.files.length;
        for (const f of n.folders) count += finalize(f);
        n.count = count;
        return count;
      };
      finalize(root);
      return root;
    }
  },
  mounted() {
    this.refresh();
  },
  methods: {
    isCurrent(suite) {
      return suiteRef(suite) === appState.currentSuite;
    },
    isOpen(suite) {
      return this.isCurrent(suite) && !this.collapsed;
    },
    /** Title of the open benchmark, for the parent's run dialog. */
    currentSuiteTitle() {
      const suite = this.suites.find((s) => this.isCurrent(s));
      return suite ? suite.title || suite.key : '';
    },
    /** Reloads the benchmark list and the open benchmark's tests. */
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.suites = await listSuites();
        // The open benchmark may be gone (folder deleted); fall back to the default.
        if (!this.suites.some((s) => this.isCurrent(s))) {
          const fallback = this.suites.find((s) => s.session) || this.suites[0];
          this.setCurrent(fallback ? suiteRef(fallback) : null);
        }
      } catch (e) {
        this.error = e?.message || 'Failed to list benchmarks';
      } finally {
        this.loading = false;
      }
      await this.loadTests();
    },
    async loadTests() {
      this.loading = true;
      this.error = '';
      const load = (async () => {
        try {
          this.items = await listSequences();
          this.loaded = true;
          // Drop selections whose files no longer exist.
          const live = new Set(this.items.map((i) => i.file));
          for (let i = this.selection.length - 1; i >= 0; i--) {
            if (!live.has(this.selection[i])) this.selection.splice(i, 1);
          }
        } catch (e) {
          this.items = [];
          this.error = e?.message || 'Failed to list tests';
        } finally {
          this.loading = false;
        }
      })();
      this.loadPromise = load;
      await load;
    },
    setCurrent(ref) {
      if (ref === appState.currentSuite) return;
      appState.currentSuite = ref;
      // The selection names tests of the open benchmark only.
      this.selection.splice(0);
      this.items = [];
      this.loaded = false;
    },
    async openSuite(suite) {
      if (this.running) return;
      this.collapsed = false;
      if (this.isCurrent(suite) && this.loaded) return;
      if (this.isCurrent(suite) && this.loadPromise) {
        await this.loadPromise;
        if (this.loaded) return;
      }
      this.setCurrent(suiteRef(suite));
      await this.loadTests();
    },
    toggleCollapse(suite) {
      if (this.isCurrent(suite)) this.collapsed = !this.collapsed;
      else this.openSuite(suite);
    },
    /** Double-click: open the benchmark, check every test and ask the parent to run them. */
    async runSuite(suite) {
      if (this.running) return;
      await this.openSuite(suite);
      if (!this.isCurrent(suite)) return;
      if (!this.items.length) {
        this.error = `${suite.title || suite.key} has no tests yet — add one first.`;
        return;
      }
      this.selectAll(true);
      this.$emit('run');
    },
    startCreate() {
      this.creating = true;
      this.newName = '';
      this.newTitle = '';
    },
    async create() {
      if (!this.newName || this.nameError || this.createBusy) return;
      this.createBusy = true;
      this.error = '';
      try {
        const suite = await createSuite(this.newName, this.newTitle.trim());
        this.creating = false;
        this.suites = await listSuites();
        await this.openSuite(suite);
      } catch (e) {
        this.error = e?.message || 'Failed to create the benchmark';
      } finally {
        this.createBusy = false;
      }
    },
    toggleSelect(file) {
      const i = this.selection.indexOf(file);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(file);
    },
    selectAll(all) {
      // Mutate the shared array in place (not reassign) so appState's
      // reference stays intact, same as toggleSelect above.
      this.selection.splice(0, this.selection.length, ...(all ? this.items.map((i) => i.file) : []));
    },
    onPlay(file) {
      this.$emit('play', file);
    },
    onEdit(file) {
      this.$emit('edit', file);
    },
    async onDelete(file) {
      this.error = '';
      if (STATIC) {
        this.error = "Static deployments can't delete files — this is the read-only bundle built by CI.";
        return;
      }
      try {
        await deleteSequenceFile(file);
        const i = this.selection.indexOf(file);
        if (i >= 0) this.selection.splice(i, 1);
        await this.loadTests();
      } catch (e) {
        this.error = e?.message || 'Failed to delete';
      }
    }
  }
};
</script>

<style scoped>
.sequence-browser {
  font-size: 12px;
}
.tree-root {
  max-height: 320px;
  overflow-y: auto;
}
.row {
  min-width: 0;
  min-height: 26px;
  border-radius: 4px;
  padding-left: 4px;
  padding-right: 2px;
}
.row:hover {
  background: rgba(127, 127, 127, 0.12);
}
.suite-row,
.add-row {
  cursor: pointer;
  user-select: none;
}
.suite-row.current {
  background: rgba(127, 127, 127, 0.08);
}
.name {
  font-size: 12px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.suite-name {
  font-weight: 600;
}
.add-row {
  opacity: 0.75;
}
.suite-body {
  padding-left: 4px;
  margin-bottom: 4px;
}
.badge {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(127, 127, 127, 0.18);
  white-space: nowrap;
}
.badge.count {
  opacity: 0.7;
}
.create-form {
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 4px;
}
</style>
