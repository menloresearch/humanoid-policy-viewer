import * as ort from 'onnxruntime-web/wasm';
import { ONNXModule } from './onnxHelper.js';
import { ObsHistory, Observations } from './observationHelpers.js';
import { policyIOErrorMessage, policyIOErrors } from './policyIO.js';
import { TrackingHelper } from './trackingHelper.js';
import { toFloatArray } from './utils/math.js';

export class PolicyRunner {
  constructor(config, options = {}) {
    this.config = config;
    this.policyJointNames = (options.policyJointNames ?? config.policy_joint_names ?? []).slice();
    if (this.policyJointNames.length === 0) {
      throw new Error('PolicyRunner requires policy_joint_names in config');
    }
    this.numActions = this.policyJointNames.length;

    this.actionScale = toFloatArray(options.actionScale ?? config.action_scale, this.numActions, 1.0);
    this.defaultJointPos = toFloatArray(options.defaultJointPos ?? [], this.numActions, 0.0);
    this.actionClip = typeof config.action_clip === 'number' ? config.action_clip : 10.0;

    this.module = new ONNXModule(config.onnx);
    this.inputKey = config.onnx?.meta?.in_keys?.[0] ?? 'policy';
    this.outputKey = config.onnx?.meta?.out_keys?.[0] ?? 'action';
    this.inputDict = {};
    this.isInferencing = false;
    this.lastActions = new Float32Array(this.numActions);
    // 0 = policy controls upper body, 1 = arms externally driven (teleop).
    this.interruptMask = 0;

    this.tracking = null;
    if (config.tracking) {
      this.tracking = new TrackingHelper({
        ...config.tracking,
        policy_joint_names: this.policyJointNames
      });
    }

    this.obsModules = this._buildObsModules(config.obs_config);
    this.numObs = this.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);

    this._dumpsRemaining = 0;
    this._dumpIdx = 0;
    this._dumpBuffer = [];
    this._dumpSaveOnFinish = false;
    this._dumpFilename = null;

    this._csvLogging = false;
    this._csvRows = [];
    this._csvStep = 0;
    this._csvStartedAt = 0;
    this._csvFilename = null;
    this._htmlFilename = null;
    this._csvHeader = null;
  }

  enableDumps(n = 3, opts = {}) {
    this._dumpsRemaining = Math.max(0, Number(n) | 0);
    this._dumpIdx = 0;
    this._dumpBuffer = [];
    this._dumpSaveOnFinish = !!opts.saveToFile;
    this._dumpFilename = opts.filename || null;
    this._dumpSilent = !!opts.silent;
  }

  stopDumps() {
    const hadBuffer = this._dumpBuffer && this._dumpBuffer.length > 0;
    this._dumpsRemaining = 0;
    if (this._dumpSaveOnFinish && hadBuffer) {
      this._flushDumpsToFile();
    }
  }

  startCsvLogging(opts = {}) {
    this._csvLogging = true;
    this._csvRows = [];
    this._csvStep = 0;
    this._csvStartedAt = performance.now();
    this._csvFilename = opts.filename || null;
    this._htmlFilename = opts.htmlFilename || null;
    this._csvHeader = this._buildCsvHeader();
  }

  stopCsvLogging() {
    if (!this._csvLogging && this._csvRows.length === 0) {
      return;
    }
    this._csvLogging = false;
    this._downloadCsvAndGraph();
  }

  async init() {
    await this.module.init();
    const { session, inKeys, outKeys } = this.module;
    const ioErrors = [...policyIOErrors({
      inputMetadata: session.inputMetadata,
      outputMetadata: session.outputMetadata,
      inputName: session.inputNames[inKeys.indexOf(this.inputKey)],
      outputName: session.outputNames[outKeys.indexOf(this.outputKey)],
      numObs: this.numObs,
      numActions: this.numActions,
      recipeError: this.config.obs_config_error,
    }), ...this.module.statePlan.errors];
    if (ioErrors.length) {
      throw new Error(policyIOErrorMessage(ioErrors));
    }
    this.reset();
  }

  _buildObsModules(obsConfig) {
    const obsList = (obsConfig && Array.isArray(obsConfig.policy)) ? obsConfig.policy : [];
    return obsList.map((obsConfigEntry) => {
      const ObsClass = Observations[obsConfigEntry.name];
      if (!ObsClass) {
        throw new Error(`Unknown observation type: ${obsConfigEntry.name}`);
      }
      const kwargs = { ...obsConfigEntry };
      delete kwargs.name;
      delete kwargs.history_length;
      const obs = new ObsClass(this, kwargs);
      const historyLength = obsConfigEntry.history_length ?? 1;
      return historyLength > 1 ? new ObsHistory(obs, historyLength) : obs;
    });
  }

  reset(state = null) {
    this.inputDict = this.module.initInput() ?? {};
    this.lastActions.fill(0.0);
    if (this.tracking) {
      this.tracking.reset(state);
    }
    for (const obs of this.obsModules) {
      if (typeof obs.reset === 'function') {
        obs.reset(state);
      }
    }
    this._dumpsRemaining = 0;
    this._dumpIdx = 0;
  }

  async step(state) {
    if (this.isInferencing) {
      return null;
    }

    if (!state) {
      throw new Error('PolicyRunner.step requires a state object');
    }

    this.isInferencing = true;
    try {
      if (this.tracking) {
        this.tracking.advance();
      }

      const obsForPolicy = new Float32Array(this.numObs);
      let offset = 0;
      for (const obs of this.obsModules) {
        if (typeof obs.update === 'function') {
          obs.update(state);
        }
        const obsValue = obs.compute(state);
        const obsArray = ArrayBuffer.isView(obsValue) ? obsValue : Float32Array.from(obsValue);
        obsForPolicy.set(obsArray, offset);
        offset += obsArray.length;
      }

      this.inputDict[this.inputKey] = new ort.Tensor('float32', obsForPolicy, [1, obsForPolicy.length]);

      const [result, carry] = await this.module.runInference(this.inputDict);
      this.inputDict = { ...this.inputDict, ...carry };

      const action = result[this.outputKey]?.data;
      if (!action || action.length !== this.numActions) {
        throw new Error('PolicyRunner received invalid action output');
      }

      const clip = typeof this.actionClip === 'number' ? this.actionClip : Infinity;
      for (let i = 0; i < this.numActions; i++) {
        const value = action[i];
        const clamped = clip !== Infinity ? Math.max(-clip, Math.min(clip, value)) : value;
        this.lastActions[i] = clamped;
      }

      const target = new Float32Array(this.numActions);
      for (let i = 0; i < this.numActions; i++) {
        target[i] = this.defaultJointPos[i] + this.actionScale[i] * this.lastActions[i];
      }

      if (this._dumpsRemaining > 0) {
        this._dumpIdx += 1;
        this._dumpsRemaining -= 1;
        this._logDump(obsForPolicy, this.lastActions, target);
        if (this._dumpsRemaining === 0 && this._dumpSaveOnFinish) {
          this._flushDumpsToFile();
        }
      }

      if (this._csvLogging) {
        this._appendCsvRow(obsForPolicy, this.lastActions);
      }

      return target;
    } finally {
      this.isInferencing = false;
    }
  }


  _buildCsvHeader() {
    return ['step_num', ...this._buildObservationCsvParts().labels, ...this._buildActionLabels()];
  }

  _buildObservationCsvParts(obs = null) {
    const labels = [];
    const values = [];
    const obsList = (this.config.obs_config && Array.isArray(this.config.obs_config.policy))
      ? this.config.obs_config.policy
      : [];
    let offset = 0;

    for (let entryIdx = 0; entryIdx < obsList.length; entryIdx++) {
      const entry = obsList[entryIdx];
      const module = this.obsModules[entryIdx];
      const size = module?.size ?? 0;
      const segment = obs ? obs.slice(offset, offset + size) : null;

      // A stacked history repeats the term's columns once per step, oldest first.
      const steps = module instanceof ObsHistory ? module.length : 1;
      const perStep = size / steps;
      for (let step = 0; step < steps; step++) {
        const first = labels.length;
        const stepSegment = segment ? segment.slice(step * perStep, (step + 1) * perStep) : null;
        this._pushEntryCsvParts(labels, values, entry, perStep, stepSegment);
        if (steps > 1) {
          for (let i = first; i < labels.length; i++) labels[i] = `${labels[i]}_t_minus_${steps - 1 - step}`;
        }
      }
      offset += size;
    }

    return { labels: labels.slice(0, this.numObs), values: values.slice(0, this.numObs) };
  }

  _pushEntryCsvParts(labels, values, entry, size, segment) {
    const name = entry.name;
    if (name === 'AsimovAngVel' || name === 'RootAngVelB') {
      this._pushScalarCsvParts(labels, values, ['base_ang_vel_x', 'base_ang_vel_y', 'base_ang_vel_z'], segment);
    } else if (name === 'AsimovProjectedGravity' || name === 'ProjectedGravityB') {
      this._pushScalarCsvParts(labels, values, ['projected_gravity_x', 'projected_gravity_y', 'projected_gravity_z'], segment);
    } else if (name === 'AsimovCommand') {
      this._pushScalarCsvParts(labels, values, ['command_x', 'command_y', 'command_yaw'], segment);
    } else if (name === 'AsimovGaitClock') {
      this._pushScalarCsvParts(labels, values, entry.order === 'sin_cos' ? ['gait_clock_sin', 'gait_clock_cos'] : ['gait_clock_cos', 'gait_clock_sin'], segment);
    } else if (name === 'AsimovInterruptMask') {
      this._pushScalarCsvParts(labels, values, ['interrupt_mask'], segment);
    } else if (name === 'BootIndicator') {
      this._pushScalarCsvParts(labels, values, ['boot_indicator'], segment);
    } else if (name === 'ComplianceFlagObs') {
      this._pushScalarCsvParts(labels, values, ['compliance_enabled', 'compliance_threshold', 'compliance_kp'], segment);
    } else if (name === 'AsimovJointPosSlot') {
      this._pushJointSlotCsvParts(labels, values, entry, `joint_pos_${entry.slot_name ?? 'slot'}`, segment);
    } else if (name === 'AsimovJointVelSlot') {
      this._pushJointSlotCsvParts(labels, values, entry, `joint_vel_${entry.slot_name ?? 'slot'}`, segment);
    } else if (name === 'AsimovPrevActions') {
      this._pushPolicyJointCsvParts(labels, values, 'prev_action', 1, segment);
    } else if (name === 'PrevActions') {
      const steps = Math.max(1, Math.floor(entry.history_steps ?? 4));
      this._pushPolicyJointCsvParts(labels, values, 'prev_action', steps, segment);
    } else if (name === 'JointPos') {
      const steps = entry.pos_steps ?? [0, 1, 2, 3, 4, 8];
      const perStep = this.numActions;
      for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
        const stepSegment = segment ? segment.slice(stepIdx * perStep, (stepIdx + 1) * perStep) : null;
        this._pushPolicyJointCsvParts(labels, values, `joint_pos_history_t_minus_${steps[stepIdx]}`, 1, stepSegment);
      }
    } else {
      for (let i = 0; i < size; i++) {
        labels.push(this._cleanColumnName(`${name ?? 'obs'}_${i}`));
        if (segment) values.push(segment[i]);
      }
    }
  }

  _pushScalarCsvParts(labels, values, names, segment) {
    for (let i = 0; i < names.length; i++) {
      labels.push(this._cleanColumnName(names[i]));
      if (segment) values.push(segment[i]);
    }
  }

  _pushJointSlotCsvParts(labels, values, entry, prefix, segment) {
    const sourceIndices = entry.indices ?? [];
    const orderedIndices = this._preferredSlotOrder(entry.slot_name, sourceIndices);
    for (const idx of orderedIndices) {
      labels.push(this._cleanColumnName(`${prefix}_${this.policyJointNames[idx] ?? `joint_${idx}`}`));
      if (segment) {
        const src = sourceIndices.indexOf(idx);
        values.push(src >= 0 ? segment[src] : '');
      }
    }
  }

  _preferredSlotOrder(slotName, sourceIndices) {
    const preferred = {
      slot01: [0, 6, 18, 13, 12, 1, 7, 19, 14],
      slot23: [2, 8, 20, 15, 3, 9, 21, 16],
      slot45: [4, 10, 22, 17, 5, 11]
    }[slotName];
    if (!preferred) {
      return sourceIndices;
    }
    const sourceSet = new Set(sourceIndices);
    const ordered = preferred.filter((idx) => sourceSet.has(idx));
    for (const idx of sourceIndices) {
      if (!ordered.includes(idx)) {
        ordered.push(idx);
      }
    }
    return ordered;
  }

  _pushPolicyJointCsvParts(labels, values, prefix, repeats, segment) {
    for (let step = 0; step < repeats; step++) {
      const stepPrefix = repeats > 1 ? `${prefix}_${step}` : prefix;
      for (let i = 0; i < this.policyJointNames.length; i++) {
        labels.push(this._cleanColumnName(`${stepPrefix}_${this.policyJointNames[i]}`));
        if (segment) values.push(segment[(step * this.numActions) + i]);
      }
    }
  }

  _buildActionLabels() {
    return this.policyJointNames.map((name, i) => `action_${this._cleanColumnName(name ?? `joint_${i}`)}`);
  }

  _cleanColumnName(value) {
    return String(value)
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
  }

  _appendCsvRow(obs, rawActions) {
    if (!this._csvHeader) {
      this._csvHeader = this._buildCsvHeader();
    }
    const row = [this._csvStep, ...this._buildObservationCsvParts(obs).values, ...rawActions];
    this._csvRows.push(row.map((value) => this._formatCsvValue(value)).join(','));
    this._csvStep += 1;
  }

  _formatCsvValue(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : '';
  }

  _downloadCsvAndGraph() {
    if (!this._csvHeader || this._csvRows.length === 0) {
      this._csvRows = [];
      return;
    }
    const csvContent = `${this._csvHeader.join(',')}\n${this._csvRows.join('\n')}\n`;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this._downloadText(
      this._csvFilename || `policy_log_${ts}.csv`,
      csvContent,
      'text/csv;charset=utf-8'
    );
    this._downloadText(
      this._htmlFilename || `policy_log_graph_${ts}.html`,
      this._buildGraphHtml(csvContent),
      'text/html;charset=utf-8'
    );
    this._csvRows = [];
    this._csvStep = 0;
    this._csvHeader = null;
    this._csvFilename = null;
    this._htmlFilename = null;
  }

  _downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  _buildGraphHtml(csvContent) {
    const escapedCsv = JSON.stringify(csvContent);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Policy Log Graph</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; background: #f6f7f9; color: #17202a; }
  header { padding: 16px 20px; background: #17202a; color: #fff; }
  main { padding: 16px 20px; }
  .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  select, button { font: inherit; padding: 6px 8px; }
  canvas { width: 100%; height: 520px; background: #fff; border: 1px solid #d5dae1; display: block; }
  .meta { color: #52606d; font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<header><h1>Policy Log Graph</h1></header>
<main>
  <div class="toolbar">
    <label>Column <select id="column"></select></label>
    <button id="prev">Prev</button>
    <button id="next">Next</button>
  </div>
  <canvas id="plot" width="1400" height="520"></canvas>
  <div class="meta" id="meta"></div>
</main>
<script>
const csvText = ${escapedCsv};
const lines = csvText.trim().split(/\\r?\\n/);
const headers = lines[0].split(',');
const rows = lines.slice(1).map((line) => line.split(',').map(Number));
const xIdx = 0;
const select = document.getElementById('column');
for (let i = 1; i < headers.length; i++) {
  const option = document.createElement('option');
  option.value = String(i);
  option.textContent = headers[i];
  select.appendChild(option);
}
const canvas = document.getElementById('plot');
const ctx = canvas.getContext('2d');
const meta = document.getElementById('meta');
function draw() {
  const idx = Number(select.value);
  const xs = rows.map((row) => row[xIdx]);
  const ys = rows.map((row) => row[idx]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return;
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = 50;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d5dae1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
  const xmap = (x) => pad + ((x - xmin) / Math.max(1e-9, xmax - xmin)) * (w - 2 * pad);
  const ymap = (y) => h - pad - ((y - ymin) / (ymax - ymin)) * (h - 2 * pad);
  ctx.strokeStyle = '#1463ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ys.forEach((y, i) => {
    const x = xmap(xs[i]);
    const py = ymap(y);
    if (i === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
  });
  ctx.stroke();
  ctx.fillStyle = '#17202a';
  ctx.font = '14px Arial';
  ctx.fillText(headers[idx], pad, 24);
  ctx.fillText('step_num', w - pad - 64, h - 16);
  ctx.fillText(ymax.toPrecision(5), 8, pad + 4);
  ctx.fillText(ymin.toPrecision(5), 8, h - pad + 4);
  meta.textContent = rows.length + ' samples, ' + headers.length + ' columns. y min=' + ymin + ', max=' + ymax;
}
select.addEventListener('change', draw);
document.getElementById('prev').addEventListener('click', () => {
  select.selectedIndex = Math.max(0, select.selectedIndex - 1);
  draw();
});
document.getElementById('next').addEventListener('click', () => {
  select.selectedIndex = Math.min(select.options.length - 1, select.selectedIndex + 1);
  draw();
});
draw();
</script>
</body>
</html>`;
  }

  _logDump(obs, rawActions, target) {
    const f = (v, d = 4) => Number(v).toFixed(d);
    const n = this.numActions;
    const fmt3 = (a, i) => `[${f(a[i])}, ${f(a[i+1])}, ${f(a[i+2])}]`;

    const lines = [];
    lines.push(`=== OBS DUMP #${this._dumpIdx} (${obs.length} floats) ===`);
    lines.push(`ang_vel: ${fmt3(obs, 0)}`);
    lines.push(`gravity: ${fmt3(obs, 3)}`);
    lines.push(`cmd:     ${fmt3(obs, 6)}`);
    lines.push(`joint_pos + joint_vel + prev_act (${n} each):`);
    const posOff = 9;
    const velOff = 9 + n;
    const actOff = 9 + 2 * n;
    for (let i = 0; i < n; i++) {
      lines.push(`  [${String(i).padStart(2)}] pos=${f(obs[posOff + i])} vel=${f(obs[velOff + i])} act=${f(obs[actOff + i])}`);
    }
    lines.push(`=== ACTION DUMP #${this._dumpIdx} ===`);
    for (let i = 0; i < n; i++) {
      lines.push(`  action[${String(i).padStart(2)}] raw=${f(rawActions[i])} -> motor[${String(i).padStart(2)}] pos=${f(target[i])} scale=${f(this.actionScale[i])} offset=${f(this.defaultJointPos[i])}`);
    }
    const text = lines.join('\n');
    if (!this._dumpSilent) {
      console.log(text);
    }
    if (this._dumpBuffer) {
      this._dumpBuffer.push(text);
    }
  }

  async _flushDumpsToFile() {
    if (!this._dumpBuffer || this._dumpBuffer.length === 0) return;
    const content = this._dumpBuffer.join('\n') + '\n';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = this._dumpFilename || `viewer_dump_${ts}.log`;
    try {
      const res = await fetch('/api/save-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        console.log(`[PolicyRunner] dump saved to ${data.path}`);
      } else {
        console.warn('[PolicyRunner] save-log failed:', data);
      }
    } catch (err) {
      console.warn('[PolicyRunner] save-log error:', err);
    }
    this._dumpBuffer = [];
  }
}
