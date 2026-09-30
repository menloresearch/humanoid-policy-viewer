<template>
  <div class="results-page">
    <v-app-bar density="compact" color="primary" flat>
      <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="closeResults()">Back to viewer</v-btn>
      <v-app-bar-title>Benchmark Results</v-app-bar-title>
      <template #append>
        <v-select
          v-if="runItems.length"
          :model-value="appState.benchmarkResultsFile"
          :items="runItems"
          item-title="title"
          item-value="value"
          label="Run"
          density="compact"
          hide-details
          variant="solo-filled"
          flat
          class="run-picker mr-4"
          :loading="loadingRun"
          @update:modelValue="selectRun"
        ></v-select>
        <span v-else-if="hasResults" class="text-caption mr-4">{{ generatedAtLabel }}</span>
        <v-btn
          v-if="hasResults"
          variant="text"
          size="small"
          class="mr-2"
          prepend-icon="mdi-file-download-outline"
          title="Download this run as a self-contained HTML report"
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
      <div v-if="runItems.length" class="text-body-2 text-medium-emphasis">
        Pick one of the {{ runItems.length }} saved run(s) above, or run a new benchmark from the viewer.
      </div>
      <div v-else class="text-body-2 text-medium-emphasis">Run a benchmark from the viewer to see comparisons here.</div>
      <v-alert v-if="runError" type="error" density="compact" class="mt-3">{{ runError }}</v-alert>
      <v-btn class="mt-4" color="primary" @click="closeResults()">Back to viewer</v-btn>
    </div>

    <div v-else class="results-body">
      <v-alert v-if="runError" type="error" density="compact" class="mb-4">{{ runError }}</v-alert>
      <!-- Shared legend: color -> policy -->
      <div class="policy-legend">
        <div v-for="p in policies" :key="p.id" class="legend-chip">
          <span class="swatch" :style="{ background: colorFor(p.id) }"></span>
          <span class="text-body-2">{{ p.label }}</span>
        </div>
      </div>

      <!-- What was run: the exact policies and test JSONs behind these numbers -->
      <v-expansion-panels variant="accordion" class="mb-4 manifest">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <span class="text-subtitle-2">What was run</span>
            <span class="text-caption text-medium-emphasis ml-2">
              {{ policies.length }} policy(ies) × {{ tests.length }} test(s){{ runFileLabel }}
            </span>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="manifest-grid">
              <div>
                <div class="section-title">Policies</div>
                <table class="cmp-table">
                  <thead><tr><th>Policy</th><th>ONNX weights</th></tr></thead>
                  <tbody>
                    <tr v-for="p in policies" :key="'mp-' + p.id">
                      <td><span class="swatch" :style="{ background: colorFor(p.id) }"></span> {{ p.label }}</td>
                      <td class="mono">{{ p.onnxPath || 'from base config' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <div class="section-title">Tests</div>
                <table class="cmp-table">
                  <thead><tr><th>Test</th><th>File</th><th>Duration</th><th>Keypoints</th><th>Pushes</th></tr></thead>
                  <tbody>
                    <tr v-for="t in tests" :key="'mt-' + t.file">
                      <td>{{ t.name || t.file }}</td>
                      <td class="mono">{{ t.file }}</td>
                      <td>{{ fmt(t.duration, 0) }}s</td>
                      <td>{{ t.sequence ? t.sequence.commands.length : '—' }}</td>
                      <td>{{ t.sequence && t.sequence.events ? t.sequence.events.length : 0 }}</td>
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
        <v-select
          v-model="selectedTestFile"
          :items="testItems"
          item-title="title"
          item-value="value"
          label="Test"
          density="compact"
          hide-details
          variant="outlined"
          style="max-width: 360px"
          class="mb-4"
        ></v-select>

        <template v-if="perTestRows.length">
          <!-- Outcome first: did each policy survive this test, and was the
               capture complete? Both were previously buried in the KPI cards. -->
          <div class="outcome-strip mb-4">
            <div
              v-for="row in perTestRows"
              :key="'oc-' + row.policyId"
              class="outcome"
              :class="row.fell || row.error ? 'bad' : 'good'"
            >
              <span class="swatch" :style="{ background: colorFor(row.policyId) }"></span>
              <v-icon size="16" class="mr-1">
                {{ row.error ? 'mdi-alert-circle' : row.fell ? 'mdi-account-off' : 'mdi-check-circle' }}
              </v-icon>
              <span class="outcome-text">
                <b :title="row.error || null">{{ row.error ? 'error' : row.fell ? `FELL at ${fmt(row.fellTime, 1)}s` : 'completed upright' }}</b>
                <span class="outcome-policy" :title="labelFor(row.policyId)">{{ shortLabel(row.policyId) }}</span>
              </span>
              <span v-if="row.error" class="outcome-note" :title="row.error">{{ row.error }}</span>
              <span v-else-if="row.warning" class="outcome-note" :title="row.warning">{{ row.warning }}</span>
            </div>
          </div>

          <!-- The input: what this test JSON actually commands -->
          <div class="section-title">Test input — commanded trajectory{{ inputSequenceNote }}</div>
          <div v-if="inputSequence" class="chart-row">
            <div v-for="ax in AXES" :key="'in-' + ax.key" class="chart-cell">
              <div class="chart-cap">commanded {{ ax.label }}</div>
              <div class="chart-box"><Line :data="charts.input[ax.key]" :options="charts.axisOpts[ax.key]" /></div>
            </div>
          </div>
          <v-alert v-else type="info" density="compact" class="mb-4">
            The test JSON was not stored with this run. Runs recorded from now on embed it.
          </v-alert>
          <div v-if="inputEvents.length" class="chart-row mb-4">
            <div class="chart-cell wide">
              <div class="chart-cap">
                commanded push events — real force (N) through the target body's own CoM, held for a duration (positive = forward / left)
              </div>
              <div class="chart-box"><Bar :data="charts.pushInput" :options="charts.pushInputOpts" /></div>
            </div>
          </div>

          <!-- KPI row per policy -->
          <div class="kpi-grid mb-4">
            <div v-for="row in perTestRows" :key="row.policyId" class="kpi-card">
              <div class="kpi-head">
                <span class="swatch" :style="{ background: colorFor(row.policyId) }"></span>
                <span class="kpi-name text-subtitle-2">{{ labelFor(row.policyId) }}</span>
                <v-chip v-if="row.fell" size="x-small" color="error">fell @ {{ fmt(row.fellTime, 1) }}s</v-chip>
              </div>
              <div class="kpi-stats">
                <div><span class="kpi-val">{{ fmt(row.trackRmse, 3) }}</span><span class="kpi-lbl">track RMSE</span></div>
                <div><span class="kpi-val">{{ fmt(row.symmetry, 1) }}%</span><span class="kpi-lbl">symmetry</span></div>
                <div><span class="kpi-val">{{ fmt(row.finalDrift, 2) }}m</span><span class="kpi-lbl">final drift</span></div>
                <div><span class="kpi-val">{{ fmt(row.jerk, 3) }}</span><span class="kpi-lbl">jerk</span></div>
                <div><span class="kpi-val">{{ row.pushesLabel }}</span><span class="kpi-lbl">pushes survived</span></div>
              </div>
            </div>
          </div>

          <!-- Tracking: actual (solid) vs command (dashed) per axis -->
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
                <span class="swatch" :style="{ background: colorFor(topDownRow.policyId) }"></span>
                {{ labelFor(topDownRow.policyId) }} — actual (solid) vs canonical (orange, dotted)
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

          <!-- Balance / smoothness KPI tiles -->
          <div class="section-title">Balance &amp; smoothness</div>
          <div class="tile-grid mb-6">
            <div v-for="row in perTestRows" :key="'bal-' + row.policyId" class="tile-card">
              <div class="kpi-head">
                <span class="swatch" :style="{ background: colorFor(row.policyId) }"></span>
                <span class="kpi-name text-caption">{{ labelFor(row.policyId) }}</span>
              </div>
              <div class="tile-stats">
                <div><span class="t-val">{{ fmt(row.supMean, 3) }}</span><span class="t-lbl">support margin mean (m)</span></div>
                <div><span class="t-val">{{ fmt(row.supMin, 3) }}</span><span class="t-lbl">support margin min (m)</span></div>
                <div><span class="t-val">{{ fmt(row.meanDelta, 4) }}</span><span class="t-lbl">mean action Δ</span></div>
                <div><span class="t-val">{{ fmt(row.rmsDelta, 4) }}</span><span class="t-lbl">RMS action Δ</span></div>
              </div>
            </div>
          </div>
        </template>
        <v-alert v-else type="info" density="compact">No results recorded for this test.</v-alert>
      </div>

      <!-- ================= AGGREGATE ================= -->
      <div v-else>
        <!-- Survival first: which tests each policy stayed upright through. -->
        <div class="section-title">Fall summary — did the robot stay upright?</div>
        <v-table density="compact" class="cmp-table fall-table mb-6">
          <thead>
            <tr>
              <th>Policy</th>
              <th v-for="t in tests" :key="'fh-' + t.file" class="text-center">
                <span :title="t.file">{{ t.name || t.file }}</span>
              </th>
              <th class="text-center">Upright</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in policies" :key="'fr-' + p.id">
              <td>
                <span class="swatch" :style="{ background: colorFor(p.id) }"></span>
                <span :title="p.label">{{ shortLabel(p.id) }}</span>
              </td>
              <td v-for="t in tests" :key="'fc-' + p.id + t.file" class="text-center">
                <span :class="['fall-cell', fallCell(p.id, t.file).cls]" :title="fallCell(p.id, t.file).title">
                  {{ fallCell(p.id, t.file).text }}
                </span>
              </td>
              <td class="text-center font-weight-medium">{{ uprightCount(p.id) }} / {{ tests.length }}</td>
            </tr>
          </tbody>
        </v-table>

        <div class="section-title">Aggregate across {{ tests.length }} test(s)</div>
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
              <th v-for="m in AGG_METRICS" :key="'h-' + m.key" class="text-right">{{ m.label }}</th>
              <th class="text-right">Max force survived (N)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in aggregateRows" :key="a.policyId">
              <td class="policy-cell">
                <span class="swatch" :style="{ background: colorFor(a.policyId) }"></span>
                {{ labelFor(a.policyId) }}
              </td>
              <td class="text-right">{{ fmt(a.trackRmse, 3) }}</td>
              <td class="text-right">{{ fmt(a.symmetry, 1) }}%</td>
              <td class="text-right">{{ fmt(a.finalDrift, 2) }}</td>
              <td class="text-right">{{ fmt(a.jerk, 3) }}</td>
              <td class="text-right">{{ a.pushesSurvived }}</td>
              <td class="text-right">{{ fmt(a.pushScore, 2) }}</td>
              <td class="text-right">{{ a.maxForce != null ? fmt(a.maxForce, 0) : 'n/a' }}</td>
            </tr>
          </tbody>
        </v-table>

        <div class="section-title">Results by category</div>
        <v-table density="compact" class="cmp-table mb-6">
          <thead>
            <tr>
              <th>Category</th><th>Policy</th><th class="text-right">Upright</th>
              <th class="text-right">Track RMSE</th><th class="text-right">Pushes survived</th>
              <th class="text-right">Max force survived (N)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in categoryRows" :key="row.category + row.policyId">
              <td>{{ row.categoryLabel }}</td>
              <td class="policy-cell">
                <span class="swatch" :style="{ background: colorFor(row.policyId) }"></span>
                {{ labelFor(row.policyId) }}
              </td>
              <td class="text-right">{{ row.upright }} / {{ row.total }}</td>
              <td class="text-right">{{ fmt(row.trackRmse, 3) }}</td>
              <td class="text-right">{{ row.pushesLabel }}</td>
              <td class="text-right">{{ row.maxForce != null ? fmt(row.maxForce, 0) : 'n/a' }}</td>
            </tr>
          </tbody>
        </v-table>

        <div class="section-title">Push envelope by location</div>
        <p class="text-caption text-medium-emphasis mb-2">
          The category table above still lumps e.g. groin/pelvis in with shoulder pushes. Each push
          test file targets exactly one location, so this is the real per-location max-force breakdown.
        </p>
        <v-table density="compact" class="cmp-table mb-6">
          <thead>
            <tr>
              <th>Location</th><th>Policy</th><th class="text-right">Survived</th>
              <th class="text-right">Max force survived (N)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pushLocationRows" :key="row.file + row.policyId">
              <td>{{ row.name }}</td>
              <td class="policy-cell">
                <span class="swatch" :style="{ background: colorFor(row.policyId) }"></span>
                {{ labelFor(row.policyId) }}
              </td>
              <td class="text-right">{{ row.pert ? `${row.pert.survived}/${row.pert.total}` : 'n/a' }}</td>
              <td class="text-right">{{ row.maxForce != null ? fmt(row.maxForce, 0) : 'n/a' }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </div>
  </div>
</template>

<script>
import { appState, closeResults, setBenchmarkResults } from '@/state/appState.js';
import { listBenchmarks, loadBenchmark } from '@/state/benchmarkStore.js';
import { loadSequenceFile } from '@/state/sequenceStore.js';
import { resolveLimits } from '@/simulation/commandSequencer.js';
import {
  downloadBenchmarkReport, categoryOf, maxForceSurvived, computeCategoryRollup, isUpright
} from '@/simulation/benchmarkReport.js';
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

function mean(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export default {
  name: 'BenchmarkResults',
  components: { Line, Bar },
  data() {
    return {
      // Aggregate first: the fall summary and per-policy comparison answer
      // "which checkpoint is better" before drilling into a single test.
      viewMode: 'aggregate',
      selectedTestFile: null,
      topDownIndex: 0,
      loadingRun: false,
      runError: '',
      // Test JSONs recovered from disk for older runs that didn't embed them.
      fetchedSequences: {},
      AXES,
      AGG_METRICS
    };
  },
  computed: {
    appState() {
      return appState;
    },
    runFileLabel() {
      return appState.benchmarkResultsFile ? ` · ${appState.benchmarkResultsFile}` : '';
    },
    /** The selected test's declared command profile, embedded or recovered. */
    inputSequence() {
      const test = this.tests.find((t) => t.file === this.selectedTestFile);
      if (test?.sequence?.commands?.length) return test.sequence;
      const fetched = this.fetchedSequences[this.selectedTestFile];
      return fetched?.commands?.length ? fetched : null;
    },
    inputSequenceNote() {
      const test = this.tests.find((t) => t.file === this.selectedTestFile);
      if (test?.sequence?.commands?.length) return '';
      return this.inputSequence ? ' (current file on disk — not stored with this run)' : '';
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
    /** Saved runs under benchmarks/, newest first, as select items. */
    runItems() {
      return appState.benchmarkRuns.map((run) => {
        const when = run.generatedAt ? new Date(run.generatedAt).toLocaleString() : run.file;
        const shape = run.policyCount != null && run.testCount != null
          ? ` — ${run.policyCount}p × ${run.testCount}t`
          : '';
        return { title: when + shape, value: run.file };
      });
    },
    hasResults() {
      return appState.benchmarkResults != null;
    },
    br() {
      return appState.benchmarkResults;
    },
    generatedAtLabel() {
      const g = this.br && this.br.generatedAt;
      if (!g) return '';
      const d = new Date(g);
      return Number.isNaN(d.getTime()) ? String(g) : d.toLocaleString();
    },
    policies() {
      return (this.br && this.br.policies) || [];
    },
    tests() {
      return (this.br && this.br.tests) || [];
    },
    testItems() {
      return this.tests.map((t) => ({ title: t.name || t.file, value: t.file }));
    },
    colorIndex() {
      const m = {};
      this.policies.forEach((p, i) => { m[p.id] = i % PALETTE.length; });
      return m;
    },
    // rows (one per policy) for the selected test, with derived KPIs
    perTestRows() {
      if (!this.br || !this.selectedTestFile) return [];
      const rows = this.br.results.filter((r) => r.testFile === this.selectedTestFile);
      // order by policy declaration for stable colors
      return this.policies
        .map((p) => rows.find((r) => r.policyId === p.id))
        .filter(Boolean)
        .map((r) => this.deriveRow(r));
    },
    hasPerturbations() {
      return this.perTestRows.some((r) => r.perturbations);
    },
    hasGaitSymmetry() {
      return this.perTestRows.some((r) => (r.metrics.gaitSymmetry?.pairs || []).length);
    },
    /**
     * Every per-test chart's data and options, built once per (run, test,
     * policy set). Binding methods directly in the template returned fresh
     * objects on each re-render, so Chart.js tore down and rebuilt a dozen
     * canvases whenever anything on the page changed.
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
        datasets.push(this.pathDataset(this.labelFor(row.policyId), td.actual, this.colorFor(row.policyId)));
      }
      return { datasets };
    },
    driftData() {
      const datasets = this.perTestRows.map((r) => {
        const s = (r.metrics.series || {});
        const t = s.time || [];
        const d = s.drift || [];
        return this.xyDataset(this.labelFor(r.policyId), t, d, this.colorFor(r.policyId));
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
        labels: rows.map((r) => this.labelFor(r.policyId)),
        datasets: [{
          label: 'Survived',
          data: rows.map((r) => (r.perturbations ? r.perturbations.survived : 0)),
          backgroundColor: rows.map((r) => this.colorFor(r.policyId)),
          borderRadius: 4,
          maxBarThickness: 48
        }]
      };
    },
    pushOpts() {
      const totals = this.perTestRows.map((r) => (r.perturbations ? r.perturbations.total : 0));
      const meanScores = this.perTestRows.map((r) => (r.perturbations ? r.perturbations.meanScore : null));
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
          label: this.labelFor(r.policyId),
          data: joints.map((j) => (Number.isFinite(byJoint[j]) ? byJoint[j] : null)),
          backgroundColor: this.colorFor(r.policyId),
          borderRadius: 3,
          maxBarThickness: 24
        };
      });
      return { labels: joints, datasets };
    },
    // ---- aggregate ----
    aggregateRows() {
      return this.policies.map((p) => {
        const rows = this.br.results.filter((r) => r.policyId === p.id).map((r) => this.deriveRow(r));
        return {
          policyId: p.id,
          trackRmse: mean(rows.map((r) => r.trackRmse)),
          symmetry: mean(rows.map((r) => r.symmetry)),
          finalDrift: mean(rows.map((r) => r.finalDrift)),
          jerk: mean(rows.map((r) => r.jerk)),
          pushesSurvived: rows.reduce((a, r) => a + (r.perturbations ? r.perturbations.survived : 0), 0),
          pushScore: mean(rows.map((r) => (r.perturbations ? r.perturbations.meanScore : null))),
          maxForce: maxForceSurvived(rows)
        };
      });
    },
    // Same rows, grouped by each test's benchmark/ folder — shows whether a
    // policy has a specific weak spot rather than one blended-away number.
    categoryRows() {
      return computeCategoryRollup(this.tests, this.policies, this.br.results)
        .flatMap(({ category, categoryLabel: label, perPolicy }) => perPolicy.map((p) => ({
          category,
          categoryLabel: label,
          policyId: p.policyId,
          total: p.total,
          upright: p.upright,
          trackRmse: p.trackRmse,
          pushesLabel: p.pushTotal ? `${p.pushSurvived}/${p.pushTotal}` : 'n/a',
          maxForce: p.maxForce
        })))
        .filter((row) => row.total > 0);
    },
    // One row per push test file/policy — a category can still lump e.g.
    // groin/pelvis pushes with shoulder pushes, which have very different
    // force tolerances; each push test file targets exactly one location, so
    // this is the actual per-location max-force breakdown.
    pushLocationRows() {
      return this.tests
        .filter((t) => categoryOf(t.file).startsWith('push/'))
        .flatMap((t) => this.policies.map((p) => {
          const result = this.br.results.find((r) => r.testFile === t.file && r.policyId === p.id);
          if (!result) return null;
          const row = this.deriveRow(result);
          return {
            file: t.file,
            name: t.name || t.file,
            policyId: p.id,
            pert: row.perturbations,
            maxForce: maxForceSurvived([row])
          };
        }))
        .filter(Boolean);
    }
  },
  watch: {
    hasResults: {
      immediate: true,
      handler() { this.ensureSelection(); }
    },
    // Each test is paged independently; start at the first policy.
    selectedTestFile: {
      immediate: true,
      handler() {
        this.topDownIndex = 0;
        this.ensureInputSequence();
      }
    }
  },
  async mounted() {
    await this.refreshRuns();
    if (!appState.benchmarkResults && appState.benchmarkRuns.length) {
      await this.selectRun(appState.benchmarkRuns[0].file);
    }
    this.ensureSelection();
  },
  methods: {
    closeResults,
    async refreshRuns() {
      try {
        appState.benchmarkRuns = await listBenchmarks();
      } catch (e) {
        // Static host / no dev endpoint: only the in-memory run is available.
        appState.benchmarkRuns = [];
      }
    },
    async selectRun(file) {
      if (!file || file === appState.benchmarkResultsFile) return;
      this.loadingRun = true;
      this.runError = '';
      try {
        const run = await loadBenchmark(file);
        setBenchmarkResults(run, file);
        // A different run has different tests/policies; restart the views.
        this.selectedTestFile = null;
        this.topDownIndex = 0;
        this.ensureSelection();
      } catch (e) {
        this.runError = `Could not load ${file}: ${e.message}`;
      } finally {
        this.loadingRun = false;
      }
    },
    stepTopDown(delta) {
      const n = this.perTestRows.length;
      if (n < 2) return;
      this.topDownIndex = (this.topDownIndex + delta + n) % n;
    },
    /**
     * Older runs stored only {file, name, duration}. Recover the command
     * profile from disk so their input can still be inspected — flagged in the
     * heading, since the file may have been edited since the run.
     */
    async ensureInputSequence() {
      const file = this.selectedTestFile;
      if (!file) return;
      const test = this.tests.find((t) => t.file === file);
      if (test?.sequence?.commands?.length) return;
      if (this.fetchedSequences[file] !== undefined) return;
      try {
        this.fetchedSequences[file] = await loadSequenceFile(file);
      } catch {
        this.fetchedSequences[file] = null;
      }
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
      // whatever checkpoint happens to be loaded live in the 3D viewer.
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
    inputOpts(unit) {
      return this.lineOpts(unit);
    },
    /**
     * Export exactly what this page is showing: for an older run whose test
     * JSONs were recovered from disk, fold those into the payload so the
     * downloaded file carries the input plots too.
     */
    downloadReport() {
      if (!this.br) return;
      this.runError = '';
      try {
        const run = {
          ...this.br,
          tests: this.tests.map((test) => {
            if (test.sequence?.commands?.length) return test;
            const recovered = this.fetchedSequences[test.file];
            return recovered?.commands?.length
              ? { ...test, sequence: recovered, sequenceRecoveredFromDisk: true }
              : test;
          })
        };
        downloadBenchmarkReport(run);
      } catch (e) {
        this.runError = `Could not build the report: ${e.message}`;
      }
    },
    ensureSelection() {
      if (this.hasResults && !this.selectedTestFile && this.tests.length) {
        this.selectedTestFile = this.tests[0].file;
      }
    },
    colorFor(policyId) {
      return PALETTE[this.colorIndex[policyId] ?? 0];
    },
    /**
     * One cell of the fall matrix: fell (with the time), stayed upright, or no
     * usable result (policy failed to load, or the capture never ran).
     */
    fallCell(policyId, testFile) {
      const result = this.br?.results?.find((r) => r.policyId === policyId && r.testFile === testFile);
      if (!result) return { text: '—', cls: 'none', title: 'No result recorded' };
      if (result.error) return { text: '—', cls: 'none', title: result.error };
      const row = this.deriveRow(result);
      if (!isUpright(row)) {
        return {
          text: `fell ${this.fmt(row.fellTime, 1)}s`,
          cls: 'fell',
          title: `Fell at ${this.fmt(row.fellTime, 1)}s` + (row.warning ? ` · ${row.warning}` : '')
        };
      }
      return {
        text: 'upright',
        cls: 'upright',
        title: 'Stayed upright' + (row.warning ? ` · ${row.warning}` : '')
      };
    },
    uprightCount(policyId) {
      return this.tests.filter((t) => this.fallCell(policyId, t.file).cls === 'upright').length;
    },
    /** Trailing file name of a checkpoint label — full text stays in a tooltip. */
    shortLabel(policyId) {
      const label = this.labelFor(policyId);
      return String(label).split('/').pop();
    },
    labelFor(policyId) {
      const p = this.policies.find((x) => x.id === policyId);
      return (p && p.label) || policyId;
    },
    fmt(v, digits = 2) {
      if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return 'n/a';
      return Number(v).toFixed(digits);
    },
    deriveRow(r) {
      const m = r.metrics || {};
      const ct = (m.commandTracking && m.commandTracking.overall) || {};
      const gs = m.gaitSymmetry || {};
      const as = m.actionSmoothness || {};
      const bal = m.balance || {};
      const drift = m.drift || {};
      const fell = m.fell || {};
      const pert = m.perturbations || null;
      return {
        policyId: r.policyId,
        error: r.error || null,
        warning: r.warning || null,
        frames: r.frames ?? m.frames ?? null,
        expectedFrames: r.expectedFrames ?? null,
        metrics: m,
        trackRmse: mean([ct.vx, ct.vy, ct.wz]),
        symmetry: gs.symmetryScorePercent,
        finalDrift: drift.final_m,
        jerk: as.jerkLikeScore,
        perturbations: pert,
        pushesLabel: pert ? `${pert.survived}/${pert.total}` : 'n/a',
        supMean: bal.meanSupportMargin_m,
        supMin: bal.minSupportMargin_m,
        meanDelta: as.meanAbsDelta,
        rmsDelta: as.rmsDelta,
        fell: !!fell.fell,
        fellTime: fell.time
      };
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
            this.labelFor(r.policyId),
            s.time || [],
            (s.actual && s.actual[axis]) || [],
            this.colorFor(r.policyId)
          );
        })
      };
    },
    errorData(axis) {
      const datasets = this.perTestRows.map((r) => {
        const s = r.metrics.series || {};
        const t = s.time || [];
        const err = (s.error && s.error[axis]) || [];
        return this.xyDataset(this.labelFor(r.policyId), t, err, this.colorFor(r.policyId));
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
        labels: rows.map((r) => this.labelFor(r.policyId)),
        datasets: [{
          label: key,
          data: rows.map((r) => (Number.isFinite(r[key]) ? r[key] : 0)),
          backgroundColor: rows.map((r) => this.colorFor(r.policyId)),
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
.run-picker {
  min-width: 260px;
  max-width: 340px;
}
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
/* Checkpoint paths are a single unbreakable token, so they need an explicit
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
/* Long checkpoint paths wrap inside the cell rather than stretching the table. */
.cmp-table .policy-cell {
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 280px;
  line-height: 1.3;
}
.fall-table th { white-space: nowrap; }
.fall-cell {
  display: inline-block;
  min-width: 68px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.74rem;
  font-weight: 500;
}
.fall-cell.upright { background: rgba(27, 175, 122, 0.16); color: #0b6b4a; }
.fall-cell.fell { background: rgba(227, 73, 72, 0.16); color: #a3201f; }
.fall-cell.none { background: rgba(0, 0, 0, 0.06); color: rgba(0, 0, 0, 0.5); }

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
</style>
