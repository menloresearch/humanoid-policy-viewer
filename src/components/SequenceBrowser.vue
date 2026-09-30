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
        density="compact"
        size="small"
        variant="text"
        prepend-icon="mdi-file-plus"
        @click="$emit('new')"
      >New test</v-btn>
    </div>

    <div class="d-flex align-center mt-1">
      <span class="text-caption text-medium-emphasis">
        Tests to benchmark ({{ selection.length }}/{{ items.length }})
      </span>
      <v-spacer />
      <v-btn variant="text" size="x-small" :disabled="running" @click="selectAll(true)">all</v-btn>
      <v-btn variant="text" size="x-small" :disabled="running" @click="selectAll(false)">none</v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" class="my-1">{{ error }}</v-alert>

    <div v-if="!loading && !tree.folders.length && !tree.files.length" class="text-caption text-medium-emphasis pa-2">
      No sequences found.
    </div>

    <!-- Tree -->
    <div class="tree-root">
      <SequenceNode
        v-for="folder in tree.folders"
        :key="'d:' + folder.path"
        :node="folder"
        :depth="0"
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
        :depth="0"
        :checked="selection.includes(f.file)"
        @toggle-select="toggleSelect"
        @play="onPlay"
        @edit="onEdit"
        @delete="onDelete"
      />
    </div>
  </div>
</template>

<script>
import { appState } from '@/state/appState.js';
import { STATIC } from '@/state/viewerMode.js';
import { listSequences, deleteSequenceFile } from '@/state/sequenceStore.js';
import SequenceNode from './SequenceNode.vue';
import SequenceFileRow from './SequenceFileRow.vue';

export default {
  name: 'SequenceBrowser',
  components: { SequenceNode, SequenceFileRow },
  props: {
    running: { type: Boolean, default: false }
  },
  emits: ['play', 'edit', 'new'],
  data() {
    return {
      STATIC,
      items: [],
      loading: false,
      error: ''
    };
  },
  created() {
    // Parent owns appState; ensure the shared selection array exists so this
    // component is robust even if mounted before it's initialised elsewhere.
    if (!Array.isArray(appState.benchmarkSelection)) appState.benchmarkSelection = [];
  },
  computed: {
    selection() {
      return appState.benchmarkSelection;
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
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.items = await listSequences();
        // Drop selections whose files no longer exist.
        const live = new Set(this.items.map((i) => i.file));
        for (let i = this.selection.length - 1; i >= 0; i--) {
          if (!live.has(this.selection[i])) this.selection.splice(i, 1);
        }
      } catch (e) {
        this.error = e?.message || 'Failed to list sequences';
      } finally {
        this.loading = false;
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
        await this.refresh();
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
  max-height: 260px;
  overflow-y: auto;
}
</style>
