<template>
  <div class="node">
    <div
      class="row folder-row d-flex align-center ga-1"
      :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
      @click="open = !open"
    >
      <v-icon size="14" class="flex-shrink-0">{{ open ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
      <v-icon size="14" class="text-medium-emphasis flex-shrink-0">{{ open ? 'mdi-folder-open' : 'mdi-folder' }}</v-icon>
      <span class="name folder-name" :title="node.path">{{ node.name }}</span>
      <span class="badge count">{{ node.count }}</span>
    </div>
    <div v-show="open">
      <SequenceNode
        v-for="child in node.folders"
        :key="'d:' + child.path"
        :node="child"
        :depth="depth + 1"
        :selection="selection"
        @toggle-select="$emit('toggle-select', $event)"
        @play="$emit('play', $event)"
        @edit="$emit('edit', $event)"
        @delete="$emit('delete', $event)"
      />
      <SequenceFileRow
        v-for="f in node.files"
        :key="'f:' + f.file"
        :file="f"
        :depth="depth + 1"
        :checked="selection.includes(f.file)"
        @toggle-select="$emit('toggle-select', $event)"
        @play="$emit('play', $event)"
        @edit="$emit('edit', $event)"
        @delete="$emit('delete', $event)"
      />
    </div>
  </div>
</template>

<script>
import SequenceFileRow from './SequenceFileRow.vue';

// A folder in the sequence tree. Recurses on itself via `name` (Vue resolves a
// component's own name inside its template).
export default {
  name: 'SequenceNode',
  components: { SequenceFileRow },
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    selection: { type: Array, required: true }
  },
  emits: ['toggle-select', 'play', 'edit', 'delete'],
  data() {
    return { open: true };
  }
};
</script>

<style scoped>
.row {
  min-width: 0;
  min-height: 26px;
  border-radius: 4px;
  padding-right: 2px;
}
.row:hover {
  background: rgba(127, 127, 127, 0.12);
}
.folder-row {
  cursor: pointer;
}
.name {
  font-size: 12px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.folder-name {
  font-weight: 600;
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
</style>
