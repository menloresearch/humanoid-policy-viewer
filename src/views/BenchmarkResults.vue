<template>
  <div class="results-page">
    <v-app-bar density="compact" color="primary" flat>
      <v-btn variant="text" prepend-icon="mdi-arrow-left" title="Back to viewer" @click="closeResults()">
        <span class="d-none d-sm-inline">Back to viewer</span>
      </v-btn>
      <v-app-bar-title class="d-none d-md-flex">Benchmark Results</v-app-bar-title>
      <template #append>
        <v-select
          v-if="resultItems.length"
          :model-value="appState.benchmarkResultsFile"
          :items="resultItems"
          item-title="title"
          item-value="value"
          label="Result"
          density="compact"
          hide-details
          variant="solo-filled"
          flat
          class="result-picker mr-2"
          :loading="loadingResult"
          @update:modelValue="selectResult"
        ></v-select>
        <span v-else-if="hasResults" class="text-caption mr-4">{{ generatedAtLabel }}</span>
        <v-btn
          v-if="hasResults"
          variant="text"
          size="small"
          class="mr-2"
          prepend-icon="mdi-file-download-outline"
          title="Download this result as a self-contained HTML report"
          @click="downloadReport"
        >HTML</v-btn>
        <v-btn-toggle v-model="viewMode" density="compact" mandatory variant="outlined" divided>
          <v-btn value="per-test" size="small">Per-test</v-btn>
          <v-btn value="aggregate" size="small">Aggregate</v-btn>
        </v-btn-toggle>
      </template>
    </v-app-bar>

    <!-- Empty state -->
    <div v-if="!hasResults" class="empty-state">
      <v-icon size="64" color="grey">mdi-chart-box-outline</v-icon>
      <div class="text-h6 mt-2">No benchmark results loaded</div>
      <div v-if="resultItems.length" class="text-body-2 text-medium-emphasis">
        Pick one of the {{ resultItems.length }} saved result(s) above, or run a new benchmark from the viewer.
      </div>
      <div v-else class="text-body-2 text-medium-emphasis">Run a benchmark from the viewer to see comparisons here.</div>
      <v-alert v-if="resultError || viewError" type="error" density="compact" class="mt-3">{{ resultError || viewError }}</v-alert>
      <v-btn class="mt-4" color="primary" @click="closeResults()">Back to viewer</v-btn>
    </div>

    <div v-else class="results-body">
      <v-alert v-if="resultError" type="error" density="compact" class="mb-4">{{ resultError }}</v-alert>
      <div class="text-h6">
        {{ view.benchmark.title }} <span class="text-medium-emphasis">v{{ view.benchmark.version }}</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        {{ generatedAtLabel }} · {{ policies.length }} policy(ies) × {{ tests.length }} test(s) · {{ view.cellCount }} cell(s){{ resultFileLabel }}
      </div>
      <v-alert v-if="!view.complete" type="warning" density="compact" class="mb-4">
        Partial result: {{ view.cellCount }} of {{ view.expectedCells }} cells{{ view.shard ? ` (shard ${view.shard.index}/${view.shard.count})` : '' }}.
        Task values need every cell, so they are left out.
      </v-alert>

      <!-- Shared legend: color -> policy -->
      <div class="policy-legend">
        <div v-for="p in policies" :key="p.key" class="legend-chip">
          <span class="swatch" :style="{ background: colorFor(p.key) }"></span>
          <span class="text-body-2">{{ p.label }}</span>
        </div>
      </div>

      <!-- What was run: the exact policies and tests behind these numbers -->
      <v-expansion-panels variant="accordion" class="mb-4 manifest">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <span class="text-subtitle-2">What was run</span>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="manifest-grid">
              <div class="scroll">
                <div class="section-title">Policies</div>
                <table class="cmp-table">
                  <thead><tr><th>Policy</th><th>Id</th><th>Weights</th></tr></thead>
                  <tbody>
                    <tr v-for="p in manifestPolicies" :key="'mp-' + p.key">
                      <td><span class="swatch" :style="{ background: colorFor(p.key) }"></span> {{ p.label }}</td>
                      <td class="mono">{{ p.id }}</td>
                      <td class="mono">{{ p.primary || 'from base config' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="scroll">
                <div class="section-title">Tests</div>
                <table class="cmp-table">
                  <thead><tr><th>Test</th><th>Id</th><th>Duration</th><th>Repeats</th><th>Keypoints</th><th>Pushes</th></tr></thead>
                  <tbody>
                    <tr v-for="t in tests" :key="'mt-' + t.id">
                      <td>{{ t.name }}</td>
                      <td class="mono">{{ t.id }}</td>
                      <td>{{ fmt(t.duration, 0) }}s</td>
                      <td :title="t.repeats.map((r) => `#${r.repeat}: seed ${r.seed}`).join('\n')">{{ t.repeats.length }}</td>
                      <td>{{ t.sequence.commands.length }}</td>
                      <td>{{ t.sequence.events ? t.sequence.events.length : 0 }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <!-- ================= PER-TEST ================= -->
      <div v-if="viewMode === 'per-test'">
        <div class="d-flex flex-wrap align-center ga-3 mb-4">
          <v-select
            v-model="selectedTestId"
            :items="testItems"
            item-title="title"
            item-value="value"
            label="Test"
            density="compact"
            hide-details
            variant="outlined"
            class="test-picker"
          ></v-select>
          <div v-if="selectedTest && selectedTest.repeats.length > 1" class="d-flex align-center ga-2">
            <span class="text-caption text-medium-emphasis">Repeat</span>
            <v-btn-toggle v-model="selectedRepeat" density="compact" mandatory variant="outlined" divided class="repeat-picker">
              <v-btn
                v-for="r in selectedTest.repeats"
                :key="'rp-' + r.repeat"
                :value="r.repeat"
                size="small"
                :title="`seed ${r.seed}`"
              >#{{ r.repeat }}</v-btn>
            </v-btn-toggle>
          </div>
          <span v-if="selectedRepeatInfo" class="text-caption text-medium-emphasis">
            repeat #{{ selectedRepeatInfo.repeat }} · seed {{ selectedRepeatInfo.seed }}
          </span>
        </div>

        <!-- Every policy's outcome on every repeat of this test; a click shows that repeat below. -->
        <div class="section-title">Outcome of each repeat</div>
        <v-table density="compact" class="cmp-table outcome-table mb-4">
          <thead>
            <tr>
              <th>Policy</th>
              <th v-for="r in selectedTest.repeats" :key="'oh-' + r.repeat" class="text-center" :title="`seed ${r.seed}`">#{{ r.repeat }}</th>
              <th class="text-center">Passed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in policies" :key="'or-' + p.key">
              <td class="policy-cell">
                <span class="swatch" :style="{ background: colorFor(p.key) }"></span>
                <span :title="p.label">{{ shortLabel(p.key) }}</span>
              </td>
              <td v-for="(o, i) in testOf(p, selectedTestId).outcomes" :key="'oc-' + p.key + i" class="text-center">
                <button
                  type="button"
                  :class="['outcome-pill', o ? o.kind : 'none', { selected: selectedTest.repeats[i].repeat === selectedRepeat }]"
                  :title="outcomeTitle(o)"
                  @click="selectedRepeat = selectedTest.repeats[i].repeat"
                >{{ o ? o.text : '—' }}</button>
              </td>
              <td class="text-center font-weight-medium">
                {{ testOf(p, selectedTestId).counts.passed }} / {{ testOf(p, selectedTestId).counts.total }}
              </td>
            </tr>
          </tbody>
        </v-table>

        <!-- The input: what this test commands -->
        <div class="section-title">Test input — commanded trajectory</div>
        <div class="chart-row">
          <div v-for="ax in AXES" :key="'in-' + ax.key" class="chart-cell">
            <div class="chart-cap">commanded {{ ax.label }}</div>
            <div class="chart-box"><Line :data="charts.input[ax.key]" :options="charts.axisOpts[ax.key]" /></div>
          </div>
        </div>
        <div v-if="inputEvents.length" class="chart-row mb-4">
          <div class="chart-cell wide">
            <div class="chart-cap">
              commanded push events — real force (N) through the target body's own CoM, held for a duration (positive = forward / left)
            </div>
            <div class="chart-box"><Bar :data="charts.pushInput" :options="charts.pushInputOpts" /></div>
          </div>
        </div>

        <template v-if="perTestRows.length">
          <!-- Outcome first: did each policy pass this repeat, and was the capture complete? -->
          <div class="section-title">Repeat #{{ selectedRepeat }}</div>
          <div class="outcome-strip mb-4">
            <div
              v-for="row in perTestRows"
              :key="'os-' + row.key"
              class="outcome"
              :class="STRIP_CLASS[row.outcome.kind]"
            >
              <span class="swatch" :style="{ background: colorFor(row.key) }"></span>
              <v-icon size="16" class="mr-1">{{ STRIP_ICON[row.outcome.kind] }}</v-icon>
              <span class="outcome-text">
                <b>{{ row.outcome.text }}</b>
                <span class="outcome-policy" :title="labelFor(row.key)">{{ shortLabel(row.key) }}</span>
              </span>
              <span v-if="row.outcome.detail" class="outcome-note" :title="row.outcome.detail">{{ row.outcome.detail }}</span>
            </div>
          </div>

          <!-- KPI row per policy -->
          <div class="kpi-grid mb-4">
            <div v-for="row in perTestRows" :key="row.key" class="kpi-card">
              <div class="kpi-head">
                <span class="swatch" :style="{ background: colorFor(row.key) }"></span>
                <span class="kpi-name text-subtitle-2">{{ labelFor(row.key) }}</span>
                <span :class="['outcome-pill', row.outcome.kind]">{{ row.outcome.text }}</span>
              </div>
              <div class="kpi-stats">
                <div><span class="kpi-val">{{ fmt(metricOf(row, 'trackRmse'), 3) }}</span><span class="kpi-lbl">track RMSE</span></div>
                <div><span class="kpi-val">{{ fmt(metricOf(row, 'symmetry'), 1) }}%</span><span class="kpi-lbl">symmetry</span></div>
                <div><span class="kpi-val">{{ fmt(metricOf(row, 'finalDrift'), 2) }}m</span><span class="kpi-lbl">final drift</span></div>
                <div><span class="kpi-val">{{ fmt(metricOf(row, 'jerk'), 3) }}</span><span class="kpi-lbl">jerk</span></div>
                <div><span class="kpi-val">{{ pushesLabel(row.metrics.perturbations) }}</span><span class="kpi-lbl">pushes survived</span></div>
              </div>
            </div>
          </div>

          <!-- Tracking: actual velocity per axis -->
          <div class="section-title">Actual velocity per policy (commanded profile is charted above)</div>
          <div class="chart-row">
            <div v-for="ax in AXES" :key="'trk-' + ax.key" class="chart-cell">
              <div class="chart-cap">{{ ax.label }}</div>
              <div class="chart-box"><Line :data="charts.tracking[ax.key]" :options="charts.axisOpts[ax.key]" /></div>
            </div>
          </div>

          <!-- Tracking error per axis -->
          <div class="section-title">Tracking error</div>
          <div class="chart-row">
            <div v-for="ax in AXES" :key="'err-' + ax.key" class="chart-cell">
              <div class="chart-cap">{{ ax.label }} error</div>
              <div class="chart-box"><Line :data="charts.error[ax.key]" :options="charts.errorOpts[ax.key]" /></div>
            </div>
          </div>

          <!-- Top-down trajectory (one panel per policy) + drift -->
          <div class="chart-row">
            <div class="chart-cell wide">
              <div class="d-flex align-center">
                <div class="section-title mb-0">Top-down trajectory (m)</div>
                <v-spacer />
                <template v-if="perTestRows.length > 1">
                  <v-btn icon size="x-small" variant="text" title="Previous policy" @click="stepTopDown(-1)">
                    <v-icon size="18">mdi-chevron-left</v-icon>
                  </v-btn>
                  <span class="text-caption text-medium-emphasis">{{ topDownIndex + 1 }} / {{ perTestRows.length }}</span>
                  <v-btn icon size="x-small" variant="text" title="Next policy" @click="stepTopDown(1)">
                    <v-icon size="18">mdi-chevron-right</v-icon>
                  </v-btn>
                </template>
              </div>
              <div class="chart-cap">
                <span class="swatch" :style="{ background: colorFor(topDownRow.key) }"></span>
                {{ labelFor(topDownRow.key) }} — actual (solid) vs canonical (orange, dotted)
              </div>
              <div class="chart-box tall"><Line :data="topDownData" :options="topDownOpts" /></div>
            </div>
            <div class="chart-cell wide">
              <div class="section-title">Position drift over time</div>
              <div class="chart-box tall"><Line :data="driftData" :options="charts.driftOpts" /></div>
            </div>
          </div>

          <!-- Push recovery + gait symmetry -->
          <div class="chart-row">
            <div v-if="hasPerturbations" class="chart-cell wide">
              <div class="section-title">Push recovery (survived / total)</div>
              <div class="chart-box"><Bar :data="pushData" :options="pushOpts" /></div>
            </div>
            <div v-if="hasGaitSymmetry" class="chart-cell wide">
              <div class="section-title">Gait symmetry — per-joint mirror RMSE</div>
              <div class="chart-box"><Bar :data="gaitData" :options="barOpts('rad')" /></div>
            </div>
          </div>

          <!-- Smoothness KPI tiles -->
          <div class="section-title">Smoothness</div>
          <div class="tile-grid mb-6">
            <div v-for="row in perTestRows" :key="'bal-' + row.key" class="tile-card">
              <div class="kpi-head">
                <span class="swatch" :style="{ background: colorFor(row.key) }"></span>
                <span class="kpi-name text-caption">{{ labelFor(row.key) }}</span>
              </div>
              <div class="tile-stats">
                <div><span class="t-val">{{ fmt(row.metrics.actionSmoothness?.meanAbsDelta, 4) }}</span><span class="t-lbl">mean action Δ</span></div>
                <div><span class="t-val">{{ fmt(row.metrics.actionSmoothness?.rmsDelta, 4) }}</span><span class="t-lbl">RMS action Δ</span></div>
              </div>
            </div>
          </div>
        </template>
        <v-alert v-else type="info" density="compact">No results recorded for this repeat.</v-alert>
      </div>

      <!-- ================= AGGREGATE ================= -->
      <div v-else>
        <!-- The benchmark's own scores first: each task with its 95% interval. -->
        <template v-if="taskRows.length">
          <div class="section-title">Tasks</div>
          <v-table density="compact" class="cmp-table mb-6">
            <thead>
              <tr>
                <th>Task</th>
                <th v-for="p in policies" :key="'th-' + p.key">
                  <span class="swatch" :style="{ background: colorFor(p.key) }"></span>
                  <span :title="p.label">{{ shortLabel(p.key) }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(task, i) in taskRows" :key="task.taskId">
                <td class="task-cell">
                  <b>{{ task.id }}</b> <span class="text-medium-emphasis">{{ task.taskId }}</span>
                  <div class="text-caption text-medium-emphasis">{{ task.description }}</div>
                </td>
                <td v-for="p in policies" :key="'tv-' + p.key + task.taskId" class="text-no-wrap">{{ formatTask(p.tasks[i]) }}</td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <!-- How every repeat of every test ended, per policy; a click opens that repeat. -->
        <div class="section-title">Outcomes</div>
        <div v-for="p in policies" :key="'po-' + p.key" class="mb-6">
          <div class="policy-head">
            <span class="swatch" :style="{ background: colorFor(p.key) }"></span>
            <span class="text-subtitle-2">{{ p.label }}</span>
            <span class="text-caption text-medium-emphasis ml-2">{{ p.counts.passed }} / {{ p.counts.total }} passed</span>
          </div>
          <v-table density="compact" class="cmp-table outcome-table">
            <thead>
              <tr>
                <th>Test</th>
                <th v-for="n in repeatNumbers" :key="'rh-' + n" class="text-center">#{{ n }}</th>
                <th class="text-center">Passed</th>
                <th v-for="m in MEANS" :key="'mh-' + m.key" class="text-right" :title="m.description">{{ meanLabel(m) }}</th>
                <th class="text-right">Pushes survived</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(t, ti) in tests" :key="'pt-' + p.key + t.id">
                <td class="test-cell">{{ t.name }} <span class="text-medium-emphasis">{{ t.config }}</span></td>
                <td v-for="n in repeatNumbers" :key="'pc-' + n" class="text-center">
                  <template v-if="outcomeAt(p, ti, n) !== undefined">
                    <button
                      type="button"
                      :class="['outcome-pill', outcomeAt(p, ti, n) ? outcomeAt(p, ti, n).kind : 'none']"
                      :title="outcomeTitle(outcomeAt(p, ti, n))"
                      @click="openRepeat(t.id, n)"
                    >{{ outcomeAt(p, ti, n) ? outcomeAt(p, ti, n).text : '—' }}</button>
                  </template>
                </td>
                <td class="text-center">{{ p.tests[ti].counts.passed }} / {{ p.tests[ti].counts.total }}</td>
                <td v-for="m in MEANS" :key="'pm-' + m.key" class="text-right">{{ fmt(p.tests[ti].means[m.key], m.digits) }}</td>
                <td class="text-right">{{ pushesLabel(p.tests[ti].pushes) }}</td>
              </tr>
              <tr class="total-row">
                <td>All tests</td>
                <td v-for="n in repeatNumbers" :key="'tc-' + n"></td>
                <td class="text-center">{{ p.counts.passed }} / {{ p.counts.total }}</td>
                <td v-for="m in MEANS" :key="'tm-' + m.key" class="text-right">{{ fmt(p.means[m.key], m.digits) }}</td>
                <td class="text-right">{{ pushesLabel(p.pushes) }}</td>
              </tr>
            </tbody>
          </v-table>
        </div>

        <div class="section-title">Across all {{ tests.length }} test(s)</div>
        <div class="chart-row">
          <div v-for="m in AGG_METRICS" :key="m.key" class="chart-cell">
            <div class="chart-cap">{{ m.label }}</div>
            <div class="chart-box"><Bar :data="aggMetricData(m.key)" :options="barOpts(m.unit, true)" /></div>
          </div>
        </div>

        <div class="section-title">Comparison table</div>
        <v-table density="compact" class="cmp-table mb-6">
          <thead>
            <tr>
              <th>Policy</th>
              <th class="text-right">Passed</th>
              <th class="text-right">Fell</th>
              <th class="text-right">Missed end zone</th>
              <th class="text-right">Errors</th>
              <th v-for="m in MEANS" :key="'ch-' + m.key" class="text-right" :title="m.description">{{ meanLabel(m) }}</th>
              <th class="text-right">Pushes survived</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in policies" :key="'cr-' + p.key">
              <td class="policy-cell">
                <span class="swatch" :style="{ background: colorFor(p.key) }"></span>
                <span :title="p.label">{{ shortLabel(p.key) }}</span>
              </td>
              <td class="text-right">{{ p.counts.passed }} / {{ p.counts.total }}</td>
              <td class="text-right">{{ p.counts.fell }}</td>
              <td class="text-right">{{ p.counts.missed }}</td>
              <td class="text-right" :class="{ 'text-error': p.counts.error }">{{ p.counts.error }}</td>
              <td v-for="m in MEANS" :key="'cm-' + m.key" class="text-right">{{ fmt(p.means[m.key], m.digits) }}</td>
              <td class="text-right">{{ pushesLabel(p.pushes) }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </div>
  </div>
</template>

<script>
import { appState, closeResults, setBenchmarkResults } from '@/state/appState.js';
import { RESULT_SCHEMA } from '@/benchmark/run.js';
import { MEANS, fmt, formatTask, resultView } from '@/benchmark/resultView.js';
import { listResults, loadResult } from '@/state/resultStore.js';
import { resolveLimits } from '@/simulation/commandSequencer.js';
import { downloadBenchmarkReport } from '@/simulation/benchmarkReport.js';
import {
  Chart, LineElement, PointElement, LineController,
  BarElement, BarController, LinearScale, CategoryScale, Legend, Tooltip
} from 'chart.js';
import { Line, Bar } from 'vue-chartjs';

Chart.register(
  LineElement, PointElement, LineController,
  BarElement, BarController, LinearScale, CategoryScale, Legend, Tooltip
);

// Validated categorical palette (dataviz skill, light surface), fixed order.
// Orange (#eb6834, the 8th hue of the validated categorical set) is reserved
// for the canonical-path overlay (see topDownData), so it's dropped here
// rather than assigned to a policy. Removing it from the end of the original
// order broke the magenta/red adjacency check, so red and violet are swapped
// to restore a passing order (validated via dataviz's validate_palette.js,
// light and dark).
const PALETTE = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#e34948', '#4a3aa7', '#e87ba4'];
const AXES = [
  { key: 'vx', label: 'Forward vx', unit: 'm/s' },
  { key: 'vy', label: 'Lateral vy', unit: 'm/s' },
  { key: 'wz', label: 'Yaw wz', unit: 'rad/s' }
];
const AGG_METRICS = [
  { key: 'trackRmse', label: 'Mean track RMSE', unit: '' },
  { key: 'symmetry', label: 'Mean symmetry %', unit: '%' },
  { key: 'finalDrift', label: 'Mean final drift (m)', unit: 'm' },
  { key: 'jerk', label: 'Mean jerk', unit: '' },
  { key: 'pushesSurvived', label: 'Total pushes survived', unit: '' },
  { key: 'pushScore', label: 'Mean push score', unit: '' }
];
const MEAN_BY_KEY = Object.fromEntries(MEANS.map((m) => [m.key, m]));
// How the outcome strip shows each kind of repeat outcome (resultView).
const STRIP_CLASS = { passed: 'good', missed: 'warn', fell: 'bad', error: 'bad' };
const STRIP_ICON = { passed: 'mdi-check-circle', missed: 'mdi-map-marker-remove', fell: 'mdi-account-off', error: 'mdi-alert-circle' };

export default {
  name: 'BenchmarkResults',
  components: { Line, Bar },
  data() {
    return {
      // Aggregate first: tasks and outcomes answer "which policy is better"
      // before drilling into a single test.
      viewMode: 'aggregate',
      selectedTestId: null,
      selectedRepeat: null,
      topDownIndex: 0,
      loadingResult: false,
      resultError: '',
      AXES,
      AGG_METRICS,
      MEANS,
      STRIP_CLASS,
      STRIP_ICON
    };
  },
  computed: {
    appState() {
      return appState;
    },
    resultFileLabel() {
      return appState.benchmarkResultsFile ? ` · ${appState.benchmarkResultsFile}` : '';
    },
    /** The loaded result.json as resultView's tables, or { error } when it can't be shown. */
    loaded() {
      const result = appState.benchmarkResults;
      if (!result) return { view: null, error: '' };
      if (result.schema !== RESULT_SCHEMA) {
        return { view: null, error: `Not a benchmark result (expected schema ${RESULT_SCHEMA}, got ${result.schema ?? 'none'}).` };
      }
      try {
        return { view: resultView(result), error: '' };
      } catch (e) {
        return { view: null, error: `Could not read this result: ${e.message}` };
      }
    },
    view() {
      return this.loaded.view;
    },
    viewError() {
      return this.loaded.error;
    },
    hasResults() {
      return this.view != null;
    },
    /** Saved results under benchmark_results/, newest first, as select items. */
    resultItems() {
      return appState.savedResults.map((result) => {
        const when = result.generatedAt ? new Date(result.generatedAt).toLocaleString() : result.file;
        const shape = result.policyCount != null && result.testCount != null
          ? ` — ${result.policyCount}p × ${result.testCount}t`
          : '';
        return { title: when + shape, value: result.file };
      });
    },
    generatedAtLabel() {
      const g = this.view && this.view.generatedAt;
      if (!g) return '';
      const d = new Date(g);
      return Number.isNaN(d.getTime()) ? String(g) : d.toLocaleString();
    },
    policies() {
      return this.view ? this.view.policies : [];
    },
    tests() {
      return this.view ? this.view.tests : [];
    },
    /** The result's own policy entries, for the weights file each one ran. */
    manifestPolicies() {
      const byKey = new Map((appState.benchmarkResults?.policies || []).map((p) => [p.key, p]));
      return this.policies.map((p) => ({ ...p, primary: byKey.get(p.key)?.primary ?? null }));
    },
    testItems() {
      return this.tests.map((t) => ({ title: t.name === t.id ? t.id : `${t.name} — ${t.id}`, value: t.id }));
    },
    /** Every repeat number any test ran, for the aggregate outcome columns. */
    repeatNumbers() {
      return [...new Set(this.tests.flatMap((t) => t.repeats.map((r) => r.repeat)))].sort((a, b) => a - b);
    },
    /** The benchmark's tasks in order; each policy's values line up with these. */
    taskRows() {
      return this.policies[0]?.tasks ?? [];
    },
    colorIndex() {
      const m = {};
      this.policies.forEach((p, i) => { m[p.key] = i % PALETTE.length; });
      return m;
    },
    selectedTest() {
      return this.tests.find((t) => t.id === this.selectedTestId) || { id: null, repeats: [], sequence: null };
    },
    selectedRepeatInfo() {
      return this.selectedTest.repeats.find((r) => r.repeat === this.selectedRepeat) || null;
    },
    inputSequence() {
      return this.selectedTest.sequence;
    },
    /** One row per policy that has the selected repeat: its outcome and that cell's metrics. */
    perTestRows() {
      const index = this.selectedTest.repeats.findIndex((r) => r.repeat === this.selectedRepeat);
      if (index < 0) return [];
      return this.policies
        .map((p) => {
          const outcome = this.testOf(p, this.selectedTestId).outcomes[index];
          return outcome ? { key: p.key, outcome, metrics: outcome.cell.metrics || {} } : null;
        })
        .filter(Boolean);
    },
    inputEvents() {
      return (this.inputSequence?.events || []).filter((e) => e?.type === 'push');
    },
    /**
     * Pushes get their own chart: the velocity charts can only mark *when* one
     * happened, not how hard or which way. Split each commanded force into its
     * forward/back and lateral components so direction is readable. This is
     * the commanded input, not a measured outcome — actual velocity change
     * depends on the target body's mass and contact/pose/policy response.
     */
    pushInputData() {
      const events = this.inputEvents;
      return {
        labels: events.map((e) => `t=${this.fmt(e.t, 1)}s`),
        datasets: [
          {
            label: 'forward/back (x)',
            data: events.map((e) => (Number(e.dir?.[0]) || 0) * (Number(e.force) || 0)),
            backgroundColor: PALETTE[0]
          },
          {
            label: 'lateral (y)',
            data: events.map((e) => (Number(e.dir?.[1]) || 0) * (Number(e.force) || 0)),
            backgroundColor: PALETTE[2]
          }
        ]
      };
    },
    pushInputOpts() {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
          tooltip: { enabled: true }
        },
        scales: {
          x: { grid: { display: false } },
          y: { title: { display: true, text: 'commanded force (N)' }, grid: { color: '#eee' } }
        }
      };
    },
    hasPerturbations() {
      return this.perTestRows.some((r) => r.metrics.perturbations);
    },
    hasGaitSymmetry() {
      return this.perTestRows.some((r) => (r.metrics.gaitSymmetry?.pairs || []).length);
    },
    /**
     * Every per-test chart's data and options, built once per (result, test,
     * repeat, policy set). Binding methods directly in the template returned
     * fresh objects on each re-render, so Chart.js tore down and rebuilt a
     * dozen canvases whenever anything on the page changed.
     */
    charts() {
      const data = { tracking: {}, error: {}, input: {}, axisOpts: {}, errorOpts: {} };
      for (const axis of AXES) {
        data.tracking[axis.key] = this.trackingData(axis.key);
        data.error[axis.key] = this.errorData(axis.key);
        data.input[axis.key] = this.inputData(axis.key);
        data.axisOpts[axis.key] = this.axisOpts(axis.key, axis.unit);
        data.errorOpts[axis.key] = this.lineOpts(axis.unit);
      }
      data.driftOpts = this.lineOpts('m');
      data.pushInput = this.pushInputData;
      data.pushInputOpts = this.pushInputOpts;
      return data;
    },
    /** The policy currently paged into the top-down panel. */
    topDownRow() {
      const rows = this.perTestRows;
      if (!rows.length) return {};
      return rows[Math.min(this.topDownIndex, rows.length - 1)];
    },
    /**
     * One policy at a time: overlaying several walked paths on a single
     * floor-plan is unreadable, so each policy gets its own panel showing its
     * actual path against the canonical path implied by the commands.
     */
    topDownData() {
      const row = this.topDownRow;
      const td = row?.metrics?.topDown || {};
      const datasets = [];
      if (Array.isArray(td.expected) && td.expected.length) {
        datasets.push(this.pathDataset('Canonical', td.expected, '#ff8c00', { dotted: true, order: 99 }));
      }
      if (Array.isArray(td.actual) && td.actual.length) {
        datasets.push(this.pathDataset(this.labelFor(row.key), td.actual, this.colorFor(row.key)));
      }
      return { datasets };
    },
    driftData() {
      const datasets = this.perTestRows.map((r) => {
        const s = (r.metrics.series || {});
        const t = s.time || [];
        const d = s.drift || [];
        return this.xyDataset(this.labelFor(r.key), t, d, this.colorFor(r.key));
      });
      return { datasets };
    },
    topDownOpts() {
      return {
        responsive: true,
        maintainAspectRatio: false,
        aspectRatio: 1,
        plugins: { legend: { display: false }, tooltip: { mode: 'nearest', intersect: false } },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'x (m)' }, grid: { color: '#eee' } },
          y: { type: 'linear', title: { display: true, text: 'y (m)' }, grid: { color: '#eee' } }
        }
      };
    },
    pushData() {
      const rows = this.perTestRows;
      return {
        labels: rows.map((r) => this.labelFor(r.key)),
        datasets: [{
          label: 'Survived',
          data: rows.map((r) => (r.metrics.perturbations ? r.metrics.perturbations.survived : 0)),
          backgroundColor: rows.map((r) => this.colorFor(r.key)),
          borderRadius: 4,
          maxBarThickness: 48
        }]
      };
    },
    pushOpts() {
      const totals = this.perTestRows.map((r) => (r.metrics.perturbations ? r.metrics.perturbations.total : 0));
      const meanScores = this.perTestRows.map((r) => (r.metrics.perturbations ? r.metrics.perturbations.meanScore : null));
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const score = meanScores[ctx.dataIndex];
                const scoreLabel = score == null ? '' : ` · mean score ${score.toFixed(2)}`;
                return `${ctx.parsed.y} / ${totals[ctx.dataIndex]} survived${scoreLabel}`;
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'count' }, grid: { color: '#eee' } }
        }
      };
    },
    gaitData() {
      // union of joints, ordered by first available policy
      const joints = [];
      this.perTestRows.forEach((r) => {
        const pairs = (r.metrics.gaitSymmetry && r.metrics.gaitSymmetry.pairs) || [];
        pairs.forEach((p) => { if (!joints.includes(p.joint)) joints.push(p.joint); });
      });
      const datasets = this.perTestRows.map((r) => {
        const pairs = (r.metrics.gaitSymmetry && r.metrics.gaitSymmetry.pairs) || [];
        const byJoint = {};
        pairs.forEach((p) => { byJoint[p.joint] = p.mirrorRmse; });
        return {
          label: this.labelFor(r.key),
          data: joints.map((j) => (Number.isFinite(byJoint[j]) ? byJoint[j] : null)),
          backgroundColor: this.colorFor(r.key),
          borderRadius: 3,
          maxBarThickness: 24
        };
      });
      return { labels: joints, datasets };
    },
    // ---- aggregate ----
    aggregateRows() {
      return this.policies.map((p) => ({ key: p.key, ...p.means, pushesSurvived: p.pushes ? p.pushes.survived : null }));
    }
  },
  watch: {
    hasResults: {
      immediate: true,
      handler() { this.ensureSelection(); }
    },
    // A test keeps the chosen repeat when it has it, else starts at its first.
    selectedTestId() {
      if (!this.selectedRepeatInfo) this.selectedRepeat = this.selectedTest.repeats[0]?.repeat ?? null;
      this.topDownIndex = 0;
    }
  },
  async mounted() {
    await this.refreshResults();
    if (!appState.benchmarkResults && appState.savedResults.length) {
      await this.selectResult(appState.savedResults[0].file);
    }
    this.ensureSelection();
  },
  methods: {
    closeResults,
    fmt,
    formatTask,
    async refreshResults() {
      try {
        appState.savedResults = await listResults();
      } catch (e) {
        // Static host / no dev endpoint: only the in-memory result is available.
        appState.savedResults = [];
      }
    },
    async selectResult(file) {
      if (!file || file === appState.benchmarkResultsFile) return;
      this.loadingResult = true;
      this.resultError = '';
      try {
        const result = await loadResult(file);
        setBenchmarkResults(result, file);
        // A different result has different tests/policies; restart the views.
        this.selectedTestId = null;
        this.selectedRepeat = null;
        this.topDownIndex = 0;
        this.ensureSelection();
      } catch (e) {
        this.resultError = `Could not load ${file}: ${e.message}`;
      } finally {
        this.loadingResult = false;
      }
    },
    stepTopDown(delta) {
      const n = this.perTestRows.length;
      if (n < 2) return;
      this.topDownIndex = (this.topDownIndex + delta + n) % n;
    },
    /** A policy's entry for one test (outcomes, counts, means, pushes). */
    testOf(policy, testId) {
      return policy.tests.find((t) => t.testId === testId) || { outcomes: [], counts: { passed: 0, total: 0 } };
    },
    /** Repeat `n` of test `ti` for a policy: its outcome, null if missing, undefined if the test has no such repeat. */
    outcomeAt(policy, ti, n) {
      const index = this.tests[ti].repeats.findIndex((r) => r.repeat === n);
      return index < 0 ? undefined : policy.tests[ti].outcomes[index];
    },
    outcomeTitle(outcome) {
      if (!outcome) return 'not in this result';
      return [`seed ${outcome.seed}`, outcome.detail].filter(Boolean).join(' — ');
    },
    /** Show one repeat of one test in the per-test view. */
    openRepeat(testId, repeat) {
      this.selectedRepeat = repeat;
      this.selectedTestId = testId;
      this.viewMode = 'per-test';
    },
    metricOf(row, key) {
      return MEAN_BY_KEY[key].of(row.metrics);
    },
    meanLabel(m) {
      return m.unit ? `${m.label} (${m.unit})` : m.label;
    },
    pushesLabel(pushes) {
      return pushes && pushes.total ? `${pushes.survived}/${pushes.total}` : 'n/a';
    },
    /**
     * Stepped, because the sequencer holds each keypoint until the next is due;
     * interpolating between them would misdraw the commanded input.
     */
    inputData(axis) {
      const sequence = this.inputSequence;
      if (!sequence) return { datasets: [] };
      const commands = [...sequence.commands].sort((a, b) => a.t - b.t);
      const data = commands.map((c) => ({ x: Number(c.t) || 0, y: Number(c[axis]) || 0 }));
      const last = commands[commands.length - 1];
      const duration = Number(sequence.duration) || 0;
      if (last && duration > (Number(last.t) || 0)) {
        data.push({ x: duration, y: Number(last[axis]) || 0 });
      }
      const datasets = [{
        label: `commanded ${axis}`,
        data,
        borderColor: '#8d99a6',
        backgroundColor: '#8d99a6',
        borderWidth: 2,
        stepped: 'after',
        pointRadius: 2,
        order: 2
      }];
      if (this.inputEvents.length) {
        datasets.push({
          label: 'push',
          data: this.inputEvents.map((e) => ({ x: Number(e.t) || 0, y: 0 })),
          borderColor: '#e34948',
          backgroundColor: '#e34948',
          showLine: false,
          pointStyle: 'triangle',
          pointRadius: 6,
          order: 1
        });
      }
      return { datasets };
    },
    /** The command limits in force for the selected test, per axis. */
    limitsFor(axis) {
      // useActive: false — this is a comparison/report view, not tied to
      // whatever policy happens to be loaded live in the 3D viewer.
      const limits = resolveLimits(this.inputSequence || {}, { useActive: false });
      return limits[axis] || null;
    },
    /**
     * Scale velocity axes to the range the test allowed, so every policy and
     * every test is read against the same yardstick. suggestedMin/Max rather
     * than min/max: a policy that overshoots its command still shows up.
     */
    axisOpts(axis, unit) {
      const opts = this.lineOpts(unit);
      const limits = this.limitsFor(axis);
      if (limits) {
        opts.scales.y = { ...opts.scales.y, suggestedMin: limits[0], suggestedMax: limits[1] };
      }
      return opts;
    },
    /** The same result.json as a self-contained report.html (benchmarkReport.js). */
    downloadReport() {
      if (!this.view) return;
      this.resultError = '';
      try {
        downloadBenchmarkReport(appState.benchmarkResults);
      } catch (e) {
        this.resultError = `Could not build the report: ${e.message}`;
      }
    },
    ensureSelection() {
      if (this.hasResults && !this.selectedTestId && this.tests.length) {
        this.selectedTestId = this.tests[0].id;
      }
    },
    colorFor(key) {
      return PALETTE[this.colorIndex[key] ?? 0];
    },
    /** Trailing file name of a policy label — full text stays in a tooltip. */
    shortLabel(key) {
      const label = this.labelFor(key);
      return String(label).split('/').pop();
    },
    labelFor(key) {
      const p = this.policies.find((x) => x.key === key);
      return (p && p.label) || key;
    },
    // Build parallel-array line dataset as {x,y} points (time arrays may differ per policy)
    xyDataset(label, xArr, yArr, color, opts = {}) {
      const data = [];
      const n = Math.min(xArr.length, yArr.length);
      for (let i = 0; i < n; i++) data.push({ x: xArr[i], y: yArr[i] });
      return {
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        borderDash: opts.dashed ? [6, 4] : [],
        // A run cut short can leave one or two samples; with no point marker a
        // line that short renders as nothing at all.
        pointRadius: data.length <= 3 ? 3 : 0,
        tension: 0.15,
        order: opts.order
      };
    },
    pathDataset(label, path, color, opts = {}) {
      const data = path.map((pt) => ({ x: pt[0], y: pt[1] }));
      // A canonical path can legitimately be a single point (a pure-yaw test
      // commands no translation), so always mark the points on a short path.
      const degenerate = data.length <= 3
        || (new Set(data.map((p) => `${p.x},${p.y}`)).size === 1);
      return {
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        borderDash: opts.dotted ? [1, 4] : (opts.dashed ? [6, 4] : []),
        borderCapStyle: opts.dotted ? 'round' : 'butt',
        pointRadius: degenerate ? 4 : 0,
        showLine: true,
        tension: 0,
        order: opts.order
      };
    },
    /**
     * Actual velocity per policy. The commanded profile is not repeated here —
     * it's the same for every policy and is charted in "Test input" above.
     */
    trackingData(axis) {
      return {
        datasets: this.perTestRows.map((r) => {
          const s = r.metrics.series || {};
          return this.xyDataset(
            this.labelFor(r.key),
            s.time || [],
            (s.actual && s.actual[axis]) || [],
            this.colorFor(r.key)
          );
        })
      };
    },
    errorData(axis) {
      const datasets = this.perTestRows.map((r) => {
        const s = r.metrics.series || {};
        const t = s.time || [];
        const err = (s.error && s.error[axis]) || [];
        return this.xyDataset(this.labelFor(r.key), t, err, this.colorFor(r.key));
      });
      return { datasets };
    },
    lineOpts(unit) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true }
        },
        scales: {
          x: { type: 'linear', title: { display: true, text: 't (s)' }, grid: { color: '#eee' } },
          y: { title: { display: !!unit, text: unit }, grid: { color: '#eee' } }
        }
      };
    },
    barOpts(unit, singleSeries = false) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: !singleSeries, position: 'bottom' }, tooltip: { enabled: true } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, title: { display: !!unit, text: unit }, grid: { color: '#eee' } }
        }
      };
    },
    aggMetricData(key) {
      const rows = this.aggregateRows;
      return {
        labels: rows.map((r) => this.shortLabel(r.key)),
        datasets: [{
          label: key,
          data: rows.map((r) => (Number.isFinite(r[key]) ? r[key] : 0)),
          backgroundColor: rows.map((r) => this.colorFor(r.key)),
          borderRadius: 4,
          maxBarThickness: 56
        }]
      };
    }
  }
};
</script>

<style scoped>
.manifest-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}
.manifest .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
}
.result-picker {
  min-width: 260px;
  max-width: 340px;
}
.test-picker { flex: 0 1 360px; min-width: 220px; }
.results-page { height: 100%; display: flex; flex-direction: column; }
.results-body { padding: 16px 20px 40px; overflow-y: auto; }
.empty-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 40px;
}

.policy-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
.legend-chip { display: flex; align-items: center; gap: 6px; }
.swatch {
  display: inline-block; width: 12px; height: 12px; border-radius: 3px;
  vertical-align: middle; margin-right: 4px;
}

.section-title { font-size: 0.95rem; font-weight: 600; margin: 18px 0 8px; }

.kpi-grid, .tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.kpi-card, .tile-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; padding: 10px 12px; }
.kpi-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 6px;
  margin-bottom: 8px;
}
/* Policy paths are a single unbreakable token, so they need an explicit
   break opportunity — otherwise the name overflows its card instead of
   wrapping. The swatch keeps its size while the name takes the remainder. */
.kpi-head .swatch { flex: 0 0 auto; margin-top: 4px; }
.kpi-name {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.25;
}
.kpi-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 12px; }
.kpi-stats > div, .tile-stats > div { display: flex; flex-direction: column; }
.kpi-val { font-size: 1.15rem; font-weight: 600; line-height: 1.1; }
.kpi-lbl, .t-lbl { font-size: 0.7rem; color: rgba(0,0,0,0.6); }
.tile-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 12px; }
.t-val { font-size: 1rem; font-weight: 600; }

.chart-row { display: flex; flex-wrap: wrap; gap: 16px; }
.chart-cell { flex: 1 1 300px; min-width: 280px; }
.chart-cell.wide { flex: 1 1 420px; min-width: 340px; }
.chart-cap { font-size: 0.8rem; color: rgba(0,0,0,0.6); margin-bottom: 4px; }
.chart-box { height: 220px; }
.chart-box.tall { height: 320px; }

/* Outcome strip: fall/capture status, read before any chart. */
.outcome-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.outcome {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid;
  font-size: 0.8rem;
}
.outcome.good { border-color: rgba(27, 175, 122, 0.5); background: rgba(27, 175, 122, 0.08); }
.outcome.bad { border-color: rgba(227, 73, 72, 0.5); background: rgba(227, 73, 72, 0.08); }
.outcome.warn { border-color: rgba(230, 150, 20, 0.55); background: rgba(230, 150, 20, 0.08); }
.outcome-text { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.outcome-policy {
  color: rgba(0, 0, 0, 0.6);
  font-size: 0.72rem;
  max-width: 190px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.outcome-note {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.6);
  font-size: 0.68rem;
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmp-table .swatch { margin-right: 6px; }
/* Long policy paths wrap inside the cell rather than stretching the table. */
.cmp-table .policy-cell {
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 280px;
  line-height: 1.3;
}
/* One repeat's outcome; a button where a click opens that repeat. */
.outcome-pill {
  display: inline-block;
  min-width: 68px;
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  font-size: 0.74rem;
  font-weight: 500;
  white-space: nowrap;
}
button.outcome-pill { cursor: pointer; }
.outcome-pill.passed { background: rgba(27, 175, 122, 0.16); color: #0b6b4a; }
.outcome-pill.fell, .outcome-pill.error { background: rgba(227, 73, 72, 0.16); color: #a3201f; }
.outcome-pill.missed { background: rgba(230, 150, 20, 0.18); color: #8a5300; }
.outcome-pill.none { background: rgba(0, 0, 0, 0.06); color: rgba(0, 0, 0, 0.5); }
.outcome-pill.selected { border-color: currentColor; }
.outcome-table th { white-space: nowrap; }
.test-cell { white-space: nowrap; }
.task-cell { min-width: 220px; }
.total-row td { font-weight: 600; border-top: 2px solid rgba(0, 0, 0, 0.12); }
.policy-head { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 4px; }
.scroll { overflow-x: auto; }

/* The manifest tables are plain <table>s, so they carry their own borders. */
.manifest-grid .cmp-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.8rem;
}
.manifest-grid .cmp-table th,
.manifest-grid .cmp-table td {
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
.manifest-grid .cmp-table th {
  font-weight: 600;
  color: rgba(0, 0, 0, 0.6);
  white-space: nowrap;
}

/* Phone width: the same 16px gutter as the report, no horizontal page scroll. */
@media (max-width: 600px) {
  .results-body { padding: 12px 16px 32px; }
  .result-picker { min-width: 0; max-width: 150px; }
  .chart-cell, .chart-cell.wide { min-width: 0; flex-basis: 100%; }
  .manifest-grid { grid-template-columns: minmax(0, 1fr); }
  .test-picker { flex-basis: 100%; }
}
</style>
