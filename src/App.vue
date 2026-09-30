<template>
  <v-app>
    <v-main>
      <!-- Demo must stay mounted (its WebGL sim has no teardown), so hide it
           with v-show rather than unmounting when the editor is open. -->
      <div v-show="appState.page === 'viewer'">
        <Demo />
      </div>
      <TrajectoryEditor v-if="appState.page === 'editor'" />
      <BenchmarkResults v-if="appState.page === 'results'" />
    </v-main>
  </v-app>
</template>

<script>
import Demo from '@/views/Demo.vue'
import TrajectoryEditor from '@/views/TrajectoryEditor.vue'
import BenchmarkResults from '@/views/BenchmarkResults.vue'
import { appState } from '@/state/appState.js'

export default {
  name: 'App',
  components: {
    Demo,
    TrajectoryEditor,
    BenchmarkResults
  },
  setup() {
    return { appState }
  }
}
</script>

<style>
body,
.v-application {
  font-family: 'Google Sans', 'Noto Sans SC', Arial, sans-serif !important;
}

html,
body {
  overflow-x: clip;
  width: 100%;
  position: relative;
}

.v-application {
  overflow-x: clip;
}

.v-container {
  max-width: 100%;
}
</style>
