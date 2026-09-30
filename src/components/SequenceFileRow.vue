<template>
  <div
    class="row file-row d-flex align-center ga-1"
    :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
    title="Double-click to play"
    @dblclick="$emit('play', file.file)"
  >
    <v-checkbox-btn
      :model-value="checked"
      class="flex-shrink-0"
      density="compact"
      hide-details
      @click.stop
      @update:modelValue="$emit('toggle-select', file.file)"
    />
    <v-icon size="14" class="text-medium-emphasis flex-shrink-0">mdi-file-outline</v-icon>
    <span class="name" :title="file.file">{{ file.name }}</span>
    <span class="badges d-flex ga-1">
      <span v-if="file.duration != null" class="badge">{{ Number(file.duration).toFixed(0) }}s</span>
      <span v-if="file.keypointCount != null" class="badge" title="keypoints">{{ file.keypointCount }}k</span>
      <span v-if="file.eventCount" class="badge" title="push events">{{ file.eventCount }}e</span>
    </span>
    <v-btn icon size="x-small" variant="text" title="Edit" @click.stop="$emit('edit', file.file)">
      <v-icon size="14">mdi-pencil</v-icon>
    </v-btn>
    <v-btn icon size="x-small" variant="text" title="Delete" @click.stop="$emit('delete', file.file)">
      <v-icon size="14">mdi-delete-outline</v-icon>
    </v-btn>
  </div>
</template>

<script>
// One test file in the sequence browser's tree. Split into its own SFC (rather
// than an inline `template:` option) because this app ships the runtime-only
// Vue build, which cannot compile template strings at runtime.
export default {
  name: 'SequenceFileRow',
  props: {
    file: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    checked: { type: Boolean, default: false }
  },
  emits: ['toggle-select', 'play', 'edit', 'delete']
};
</script>

<style scoped>
.row {
  /* min-width:0 on the row lets the flexible name actually shrink */
  min-width: 0;
  min-height: 26px;
  border-radius: 4px;
  padding-right: 2px;
}
.row:hover {
  background: rgba(127, 127, 127, 0.12);
}
.file-row {
  cursor: default;
}
/* The name takes the leftover space and clips; badges and buttons keep their
   intrinsic width, so nothing overlaps however long the filename is. */
.name {
  font-size: 12px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.badges {
  flex: 0 0 auto;
}
.v-btn {
  flex: 0 0 auto;
}
.badge {
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(127, 127, 127, 0.18);
  white-space: nowrap;
}
</style>
