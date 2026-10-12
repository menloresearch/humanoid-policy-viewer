// Standalone HTML report (report.html) for a result.json.
//
// Everything is inlined — charts are hand-drawn SVG, no CDN, and only a few
// lines of script for the tabs — so the downloaded file renders identically
// offline and can be attached to a review or checked in next to a policy. The
// tables come from resultView (src/benchmark/resultView.js), as on the results
// page (BenchmarkResults.vue), so the two never disagree.

import { COMMAND_LIMITS } from './commandSequencer.js';
import { RESULT_SCHEMA } from '../benchmark/run.js';
import { MEANS, formatTask, resultView } from '../benchmark/resultView.js';

const PALETTE = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const CANONICAL_COLOR = '#8d99a6';

const AXES = [
  { key: 'vx', label: 'Forward vx', unit: 'm/s' },
  { key: 'vy', label: 'Lateral vy', unit: 'm/s' },
  { key: 'wz', label: 'Yaw wz', unit: 'rad/s' },
];

// Plot box: outer size plus the margins reserved for axes/labels.
const BOX = { w: 820, h: 250, left: 62, right: 16, top: 20, bottom: 36 };
const SQUARE = { w: 400, h: 400, left: 58, right: 16, top: 20, bottom: 36 };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function extent(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  let min = Math.min(...v);
  let max = Math.max(...v);
  if (min === max) {
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.1 : 0.5;
    min -= pad;
    max += pad;
  }
  return [min, max];
}

/**
 * Round a range outward to readable tick values. Returns the values plus the
 * decimal count the step needs — labelling by value instead would collapse a
 * small-magnitude axis (say 0.0004..0.0009) into a column of "0.00".
 */
function ticks(range, count = 5) {
  const [min, max] = range;
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.floor(min / step) * step;
  const values = [];
  for (let t = start; t <= max + step * 0.5; t += step) values.push(Number(t.toFixed(10)));
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
  return { values, decimals };
}

function limitsOf(sequence, axis) {
  const pair = sequence?.limits?.[axis];
  if (Array.isArray(pair) && pair.length === 2) {
    const lo = Number(pair[0]);
    const hi = Number(pair[1]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return [lo, hi];
  }
  return COMMAND_LIMITS[axis] ?? null;
}

/** Widen a data range to at least the allowed command range. */
function unionRange(range, bounds) {
  if (!bounds) return range;
  if (!range) return [...bounds];
  return [Math.min(range[0], bounds[0]), Math.max(range[1], bounds[1])];
}

function projector(xRange, yRange, box) {
  const innerW = box.w - box.left - box.right;
  const innerH = box.h - box.top - box.bottom;
  const [x0, x1] = xRange;
  const [y0, y1] = yRange;
  return {
    x: (v) => box.left + ((v - x0) / (x1 - x0 || 1)) * innerW,
    y: (v) => box.h - box.bottom - ((v - y0) / (y1 - y0 || 1)) * innerH,
    innerW,
    innerH,
  };
}

function polyline(points, project, color, { dashed = false, width = 1.6 } = {}) {
  const coords = points
    .filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))
    .map((p) => `${project.x(p[0]).toFixed(2)},${project.y(p[1]).toFixed(2)}`)
    .join(' ');
  if (!coords) return '';
  return `<polyline fill="none" stroke="${color}" stroke-width="${width}"`
    + `${dashed ? ' stroke-dasharray="6 4"' : ''} points="${coords}" />`;
}

function axes(xRange, yRange, project, box, xLabel, yLabel) {
  const xt = ticks(xRange);
  const yt = ticks(yRange);
  const grid = [
    ...yt.values.filter((t) => t >= yRange[0] && t <= yRange[1]).map((t) => {
      const y = project.y(t).toFixed(2);
      return `<line x1="${box.left}" y1="${y}" x2="${box.w - box.right}" y2="${y}" stroke="#e8ecf0" />`
        + `<text x="${box.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" class="tick">${fmt(t, yt.decimals)}</text>`;
    }),
    ...xt.values.filter((t) => t >= xRange[0] && t <= xRange[1]).map((t) => {
      const x = project.x(t).toFixed(2);
      return `<line x1="${x}" y1="${box.top}" x2="${x}" y2="${box.h - box.bottom}" stroke="#f2f5f7" />`
        + `<text x="${x}" y="${box.h - box.bottom + 14}" text-anchor="middle" class="tick">${fmt(t, xt.decimals)}</text>`;
    }),
  ].join('');
  const zeroLine = yRange[0] < 0 && yRange[1] > 0
    ? `<line x1="${box.left}" y1="${project.y(0).toFixed(2)}" x2="${box.w - box.right}" y2="${project.y(0).toFixed(2)}" stroke="#c9d2da" />`
    : '';
  return grid + zeroLine
    + `<line x1="${box.left}" y1="${box.h - box.bottom}" x2="${box.w - box.right}" y2="${box.h - box.bottom}" stroke="#9aa7b4" />`
    + `<line x1="${box.left}" y1="${box.top}" x2="${box.left}" y2="${box.h - box.bottom}" stroke="#9aa7b4" />`
    + `<text x="${box.w - box.right}" y="${box.h - 6}" text-anchor="end" class="axis-label">${esc(xLabel)}</text>`
    + `<text x="6" y="${box.top - 6}" class="axis-label">${esc(yLabel)}</text>`;
}

function legend(items) {
  if (!items.length) return '';
  return '<div class="legend">' + items.map((item) => (
    `<span class="chip"><span class="swatch" style="background:${item.color}${item.dashed ? ';opacity:.65' : ''}"></span>${esc(item.label)}${item.dashed ? ' <em>(dashed)</em>' : ''}</span>`
  )).join('') + '</div>';
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

/**
 * series: [{ label, color, dashed, points: [[x, y], ...] }]
 * markers: [{ x, label }] — drawn as labelled vertical rules (push events).
 */
function lineChart({ title, note, xLabel, yLabel, series, markers = [], yBounds = null, box = BOX }) {
  const usable = series.filter((s) => s.points?.length);
  if (!usable.length) {
    return section(title, note, '<p class="muted">No data recorded.</p>');
  }
  const xRange = extent(usable.flatMap((s) => s.points.map((p) => p[0])));
  // Anchor velocity axes to the range the test allowed, widened if a policy
  // overshot it, so the same axis reads the same across policies and tests.
  const yRange = unionRange(extent(usable.flatMap((s) => s.points.map((p) => p[1]))), yBounds);
  if (!xRange || !yRange) return section(title, note, '<p class="muted">No data recorded.</p>');
  const project = projector(xRange, yRange, box);
  const rules = markers
    .filter((m) => Number.isFinite(m?.x) && m.x >= xRange[0] && m.x <= xRange[1])
    .map((m) => {
      const x = project.x(m.x).toFixed(2);
      return `<line x1="${x}" y1="${box.top}" x2="${x}" y2="${box.h - box.bottom}" stroke="#e34948" `
        + `stroke-width="1" stroke-dasharray="3 3" />`
        + `<text x="${x}" y="${box.top - 6}" text-anchor="middle" class="tick" fill="#e34948">${esc(m.label ?? '')}</text>`;
    }).join('');
  const svg = `<svg viewBox="0 0 ${box.w} ${box.h}" role="img" aria-label="${esc(title)}">`
    + `<rect x="0" y="0" width="${box.w}" height="${box.h}" fill="#fff" />`
    + axes(xRange, yRange, project, box, xLabel, yLabel)
    + rules
    + usable.map((s) => polyline(s.points, project, s.color, { dashed: s.dashed })).join('')
    + '</svg>';
  return section(title, note, legend(usable) + svg);
}

/**
 * Turn a test's velocity keypoints into a stepped trace. The sequencer holds
 * each keypoint's value until the next one is due, so a straight line between
 * keypoints would misrepresent the commanded input.
 */
function steppedCommand(commands, axis, duration) {
  const sorted = [...(commands || [])]
    .filter((c) => Number.isFinite(Number(c?.t)))
    .sort((a, b) => a.t - b.t);
  if (!sorted.length) return [];
  const points = [];
  sorted.forEach((command, index) => {
    const value = Number(command[axis]) || 0;
    const start = Number(command.t) || 0;
    const end = index + 1 < sorted.length ? Number(sorted[index + 1].t) : Math.max(start, duration || start);
    points.push([start, value], [end, value]);
  });
  return points;
}

/** The command profile a test JSON declares, plus its push events. */
function inputTrajectoryCharts(sequence) {
  if (!sequence || !Array.isArray(sequence.commands) || !sequence.commands.length) {
    return '<p class="muted">The test JSON was not stored with this result, so its command profile '
      + 'cannot be shown. Runs recorded from now on embed it.</p>';
  }
  const duration = Number(sequence.duration) || 0;
  const events = (sequence.events || []).filter((e) => e?.type === 'push');
  const markers = events.map((e) => ({
    x: Number(e.t),
    label: `push F=${fmt(e.force, 0)}N`,
  }));
  const charts = AXES.map((axis) => lineChart({
    title: `Commanded ${axis.label}`,
    xLabel: 't (s)',
    yLabel: axis.unit,
    yBounds: limitsOf(sequence, axis.key),
    markers,
    series: [{
      label: `commanded ${axis.key}`,
      color: CANONICAL_COLOR,
      points: steppedCommand(sequence.commands, axis.key, duration),
    }],
  })).join('');
  const pushChart = events.length
    ? groupedBars({
      title: 'Commanded push events',
      note: 'Each push is a real force (N) through the robot\'s own center of mass, held for a duration — split here into forward/back and lateral components. Positive is forward / left. The resulting velocity change depends on the target body\'s mass and the sim\'s contact/balance response.',
      categories: events.map((e) => `t=${fmt(e.t, 1)}s`),
      yLabel: 'commanded force (N)',
      groups: [
        {
          label: 'forward/back (x)',
          color: '#2a78d6',
          values: events.map((e) => (Number(e.dir?.[0]) || 0) * (Number(e.force) || 0)),
        },
        {
          label: 'lateral (y)',
          color: '#eda100',
          values: events.map((e) => (Number(e.dir?.[1]) || 0) * (Number(e.force) || 0)),
        },
      ],
    })
    : '';
  const keypointTable = scroll('<table><thead><tr><th>t (s)</th><th>vx</th><th>vy</th><th>wz</th></tr></thead><tbody>'
    + [...sequence.commands].sort((a, b) => a.t - b.t).map((c) => (
      `<tr><td>${fmt(c.t, 2)}</td><td>${fmt(c.vx, 2)}</td><td>${fmt(c.vy, 2)}</td><td>${fmt(c.wz, 2)}</td></tr>`
    )).join('')
    + '</tbody></table>');
  const eventTable = events.length
    ? scroll('<table><thead><tr><th>t (s)</th><th>direction</th><th>force (N)</th><th>duration (s)</th><th>target body</th></tr></thead><tbody>'
      + events.map((e) => `<tr><td>${fmt(e.t, 2)}</td><td>[${fmt(e.dir?.[0], 2)}, ${fmt(e.dir?.[1], 2)}]</td><td>${fmt(e.force, 1)}</td><td>${fmt(e.duration, 3)}</td><td>${esc(e.targetBody || 'pelvis')}</td></tr>`).join('')
      + '</tbody></table>')
    : '';
  return charts
    + pushChart
    + section('Velocity keypoints', 'The literal contents of the test JSON — each keypoint is held until the next is due.', keypointTable)
    + (eventTable ? section('Push events', 'A real force (N) through the target body\'s own center of mass, held for a duration.', eventTable) : '');
}

/** Equal-aspect floor-plan path chart (top-down trajectory). */
function pathChart({ title, note, series, box = SQUARE }) {
  const usable = series.filter((s) => s.points?.length);
  if (!usable.length) return section(title, note, '<p class="muted">No path recorded.</p>');
  let xRange = extent(usable.flatMap((s) => s.points.map((p) => p[0])));
  let yRange = extent(usable.flatMap((s) => s.points.map((p) => p[1])));
  if (!xRange || !yRange) return section(title, note, '<p class="muted">No path recorded.</p>');
  // Equal metres-per-pixel on both axes so a circular path looks circular.
  const span = Math.max(xRange[1] - xRange[0], yRange[1] - yRange[0]);
  const centre = (r) => (r[0] + r[1]) / 2;
  xRange = [centre(xRange) - span / 2, centre(xRange) + span / 2];
  yRange = [centre(yRange) - span / 2, centre(yRange) + span / 2];
  const project = projector(xRange, yRange, box);
  const svg = `<svg viewBox="0 0 ${box.w} ${box.h}" role="img" aria-label="${esc(title)}" class="square">`
    + `<rect x="0" y="0" width="${box.w}" height="${box.h}" fill="#fff" />`
    + axes(xRange, yRange, project, box, 'x (m)', 'y (m)')
    + usable.map((s) => polyline(s.points, project, s.color, { dashed: s.dashed })).join('')
    + usable.map((s) => {
      const start = s.points.find((p) => Number.isFinite(p?.[0]));
      return start ? `<circle cx="${project.x(start[0]).toFixed(2)}" cy="${project.y(start[1]).toFixed(2)}" r="3" fill="${s.color}" />` : '';
    }).join('')
    + '</svg>';
  return section(title, note, legend(usable) + svg);
}

/** groups: [{ label, color, values: [] }] aligned to `categories`. */
function groupedBars({ title, note, categories, groups, yLabel }) {
  if (!categories.length || !groups.length) {
    return section(title, note, '<p class="muted">No data recorded.</p>');
  }
  const box = { ...BOX, h: 260, bottom: 74 };
  const all = groups.flatMap((g) => g.values).filter(Number.isFinite);
  // Bars grow from a zero baseline in both directions, so signed values (a
  // push impulse along -x, say) draw downward instead of being clipped away.
  const maxValue = Math.max(0, ...all);
  const minValue = Math.min(0, ...all);
  const yRange = [minValue, maxValue > minValue ? maxValue : minValue + 1];
  const project = projector([0, 1], yRange, box);
  const baseline = project.y(0);
  const slot = project.innerW / categories.length;
  const barWidth = Math.max(2, (slot * 0.72) / groups.length);
  const bars = categories.map((category, ci) => {
    const slotLeft = box.left + ci * slot + slot * 0.14;
    const label = `<text x="${(box.left + ci * slot + slot / 2).toFixed(2)}" y="${box.h - box.bottom + 14}" `
      + `text-anchor="end" class="tick" transform="rotate(-35 ${(box.left + ci * slot + slot / 2).toFixed(2)} ${box.h - box.bottom + 14})">${esc(category)}</text>`;
    return groups.map((group, gi) => {
      const value = group.values[ci];
      if (!Number.isFinite(value)) return '';
      const y = project.y(value);
      const top = Math.min(y, baseline);
      const height = Math.max(1, Math.abs(baseline - y));
      return `<rect x="${(slotLeft + gi * barWidth).toFixed(2)}" y="${top.toFixed(2)}" width="${barWidth.toFixed(2)}" `
        + `height="${height.toFixed(2)}" fill="${group.color}"><title>${esc(group.label)} · ${esc(category)}: ${fmt(value, 4)}</title></rect>`;
    }).join('') + label;
  }).join('');
  const zeroRule = minValue < 0
    ? `<line x1="${box.left}" y1="${baseline.toFixed(2)}" x2="${box.w - box.right}" y2="${baseline.toFixed(2)}" stroke="#9aa7b4" />`
    : '';
  const yt = ticks(yRange);
  const yTicks = yt.values.filter((t) => t >= yRange[0] && t <= yRange[1]).map((t) => {
    const y = project.y(t).toFixed(2);
    return `<line x1="${box.left}" y1="${y}" x2="${box.w - box.right}" y2="${y}" stroke="#e8ecf0" />`
      + `<text x="${box.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" class="tick">${fmt(t, yt.decimals)}</text>`;
  }).join('');
  const svg = `<svg viewBox="0 0 ${box.w} ${box.h}" role="img" aria-label="${esc(title)}">`
    + `<rect x="0" y="0" width="${box.w}" height="${box.h}" fill="#fff" />`
    + yTicks
    + `<line x1="${box.left}" y1="${box.h - box.bottom}" x2="${box.w - box.right}" y2="${box.h - box.bottom}" stroke="#9aa7b4" />`
    + `<line x1="${box.left}" y1="${box.top}" x2="${box.left}" y2="${box.h - box.bottom}" stroke="#9aa7b4" />`
    + `<text x="6" y="${box.top - 6}" class="axis-label">${esc(yLabel ?? '')}</text>`
    + zeroRule
    + bars
    + '</svg>';
  return section(title, note, legend(groups) + svg);
}

function section(title, note, body) {
  return `<section><h3>${esc(title)}</h3>${note ? `<p class="explain">${esc(note)}</p>` : ''}${body}</section>`;
}

function xySeries(times, values) {
  const points = [];
  const n = Math.min(times?.length ?? 0, values?.length ?? 0);
  for (let i = 0; i < n; i++) points.push([times[i], values[i]]);
  return points;
}

// ---------------------------------------------------------------------------
// tables — the rows come from resultView, as on the results page
// ---------------------------------------------------------------------------

const scroll = (table) => `<div class="scroll">${table}</div>`;

const swatch = (color) => `<span class="swatch" style="background:${color}"></span>`;

// A policy in a table: its swatch and last path segment, the full label on
// hover (a local policy's label is its absolute path; the legend shows it).
const policyName = (policy, colorFor) => (
  `${swatch(colorFor(policy.key))} <span title="${esc(policy.label)}">${esc(String(policy.label).split('/').pop())}</span>`
);

const meanHeader = (m) => `<th title="${esc(m.description)}">${esc(m.label)}${m.unit ? ` (${esc(m.unit)})` : ''}</th>`;

const pushText = (pushes) => (pushes ? `${pushes.survived}/${pushes.total}` : 'n/a');

/** One repeat's outcome as a coloured pill; its seed and any error or warning in the tooltip. */
function outcomePill(outcome) {
  if (!outcome) return '<span class="pill none" title="not in this result">—</span>';
  const title = [`seed ${outcome.seed}`, outcome.detail].filter(Boolean).join(' — ');
  return `<span class="pill ${outcome.kind}" title="${esc(title)}">${esc(outcome.text)}</span>`;
}

/** Tasks × policies, each a value with its 95% interval. */
function tasksTable(view, colorFor) {
  const tasks = view.policies[0]?.tasks ?? [];
  if (!tasks.length) return '';
  return scroll('<table><thead><tr><th>Task</th>'
    + view.policies.map((p) => `<th>${policyName(p, colorFor)}</th>`).join('')
    + '</tr></thead><tbody>'
    + tasks.map((task, i) => `<tr>
        <td><b>${esc(task.id)}</b> <span class="muted">${esc(task.taskId)}</span><br><span class="muted">${esc(task.description)}</span></td>
        ${view.policies.map((p) => `<td>${esc(formatTask(p.tasks[i]))}</td>`).join('')}
      </tr>`).join('')
    + '</tbody></table>');
}

/** One policy's tests × repeats, with how many passed and the metric means per test. */
function policyOutcomeTable(view, policy) {
  const repeatNumbers = [...new Set(view.tests.flatMap((t) => t.repeats.map((r) => r.repeat)))].sort((a, b) => a - b);
  return scroll('<table><thead><tr><th>Test</th>'
    + repeatNumbers.map((n) => `<th>#${n}</th>`).join('')
    + '<th>Passed</th>' + MEANS.map(meanHeader).join('') + '<th>Pushes survived</th>'
    + '</tr></thead><tbody>'
    + view.tests.map((test, ti) => {
      const pt = policy.tests[ti];
      return `<tr><td>${esc(test.name)} <span class="muted">${esc(test.config)}</span></td>`
        + repeatNumbers.map((n) => {
          const ri = test.repeats.findIndex((r) => r.repeat === n);
          return `<td class="center">${ri < 0 ? '' : outcomePill(pt.outcomes[ri])}</td>`;
        }).join('')
        + `<td>${pt.counts.passed}/${pt.counts.total}</td>`
        + MEANS.map((m) => `<td>${fmt(pt.means[m.key], m.digits)}</td>`).join('')
        + `<td>${pushText(pt.pushes)}</td></tr>`;
    }).join('')
    + `<tr class="total"><td>All tests</td><td colspan="${repeatNumbers.length}"></td>`
    + `<td>${policy.counts.passed}/${policy.counts.total}</td>`
    + MEANS.map((m) => `<td>${fmt(policy.means[m.key], m.digits)}</td>`).join('')
    + `<td>${pushText(policy.pushes)}</td></tr>`
    + '</tbody></table>');
}

/** One row per policy: outcome counts and its metric means across tests. */
function aggregateTable(view, colorFor) {
  return scroll('<table><thead><tr><th>Policy</th><th>Passed</th><th>Fell</th><th>Missed end zone</th><th>Errors</th>'
    + MEANS.map(meanHeader).join('') + '<th>Pushes survived</th></tr></thead><tbody>'
    + view.policies.map((p) => `<tr>
        <td>${policyName(p, colorFor)}</td>
        <td>${p.counts.passed}/${p.counts.total}</td><td>${p.counts.fell}</td><td>${p.counts.missed}</td>
        <td>${p.counts.error ? `<span class="err">${p.counts.error}</span>` : 0}</td>
        ${MEANS.map((m) => `<td>${fmt(p.means[m.key], m.digits)}</td>`).join('')}
        <td>${pushText(p.pushes)}</td>
      </tr>`).join('')
    + '</tbody></table>');
}

// ---------------------------------------------------------------------------
// one repeat of one test, every policy side by side
// ---------------------------------------------------------------------------

function repeatBody(test, entries, colorFor) {
  if (!entries.length) return '<p class="muted">No cells recorded for this repeat.</p>';
  const ok = entries.filter((e) => e.outcome.kind !== 'error' && e.metrics.series);
  const failed = entries.filter((e) => e.outcome.kind === 'error');
  const line = (e) => ({ label: e.policy.label, color: colorFor(e.policy.key) });

  // Outcome first: passed / fell / missed the end zone / errored, plus any capture caveat.
  const STATE = { passed: 'good', missed: 'warn', fell: 'bad', error: 'bad' };
  const outcomes = '<div class="outcomes">'
    + entries.map(({ policy, outcome }) => `<span class="outcome ${STATE[outcome.kind]}">`
      + swatch(colorFor(policy.key))
      + `<b>${esc(outcome.text)}</b> <span class="outcome-policy">${esc(policy.label.split('/').pop())}</span>`
      + (outcome.kind !== 'error' && outcome.detail ? `<span class="outcome-note">${esc(outcome.detail)}</span>` : '')
      + '</span>').join('')
    + '</div>';
  const errorNotes = failed.map((e) => `<div class="warn"><b>${esc(e.policy.label)}</b>: ${esc(e.outcome.detail)}</div>`).join('');

  const kpiTable = scroll(`<table><thead><tr>
      <th>Policy</th><th>Outcome</th><th>RMSE vx</th><th>RMSE vy</th><th>RMSE wz</th><th>Symmetry %</th>
      <th>Final drift (m)</th><th>Max drift (m)</th><th>Jerk</th><th>RMS action Δ</th><th>Pushes</th>
    </tr></thead><tbody>`
    + entries.map(({ policy, outcome, metrics: m }) => {
      const rmse = m.commandTracking?.overall ?? {};
      return `<tr>
        <td>${policyName(policy, colorFor)}</td>
        <td>${outcomePill(outcome)}</td>
        <td>${fmt(rmse.vx)}</td><td>${fmt(rmse.vy)}</td><td>${fmt(rmse.wz)}</td>
        <td>${fmt(m.gaitSymmetry?.symmetryScorePercent, 1)}</td>
        <td>${fmt(m.drift?.final_m, 2)}</td><td>${fmt(m.drift?.max_m, 2)}</td>
        <td>${fmt(m.actionSmoothness?.jerkLikeScore)}</td><td>${fmt(m.actionSmoothness?.rmsDelta, 4)}</td>
        <td>${pushText(m.perturbations?.total ? m.perturbations : null)}</td>
      </tr>`;
    }).join('')
    + '</tbody></table>');

  // Actual velocity per policy; the commanded profile is charted once per test,
  // above the repeat tabs, rather than repeated under every axis.
  const trackingCharts = AXES.map((axis) => lineChart({
    title: `${axis.label} — actual per policy`,
    xLabel: 't (s)',
    yLabel: axis.unit,
    yBounds: limitsOf(test.sequence, axis.key),
    series: ok.map((e) => ({ ...line(e), points: xySeries(e.metrics.series.time, e.metrics.series.actual?.[axis.key]) })),
  })).join('');

  const errorCharts = AXES.map((axis) => lineChart({
    title: `${axis.label} — tracking error (actual − command)`,
    xLabel: 't (s)',
    yLabel: axis.unit,
    series: ok.map((e) => ({ ...line(e), points: xySeries(e.metrics.series.time, e.metrics.series.error?.[axis.key]) })),
  })).join('');

  const driftChart = lineChart({
    title: 'Position drift over time',
    note: 'Distance between the actual root position and the position implied by integrating the commanded velocity.',
    xLabel: 't (s)',
    yLabel: 'm',
    series: ok.map((e) => ({ ...line(e), points: xySeries(e.metrics.series.time, e.metrics.series.drift) })),
  });

  // Top-down: one panel per policy, each against its own canonical path.
  const topDown = ok.length ? '<h3>Top-down trajectory — one panel per policy</h3>'
    + '<p class="explain">Floor-plan view (x versus y). The dashed grey line is the canonical path implied by the commands; the coloured line is what the policy actually walked. Dots mark the start.</p>'
    + '<div class="grid">'
    + ok.map((e) => pathChart({
      title: e.policy.label,
      series: [
        { label: 'canonical', color: CANONICAL_COLOR, dashed: true, points: e.metrics.topDown?.expected || [] },
        { label: 'actual', color: colorFor(e.policy.key), points: e.metrics.topDown?.actual || [] },
      ],
    })).join('')
    + '</div>' : '';

  const pairsOf = (e) => e.metrics.gaitSymmetry?.pairs || [];
  const jointLabels = [...new Set(ok.flatMap((e) => pairsOf(e).map((p) => p.joint)))];
  const symmetryChart = jointLabels.length ? groupedBars({
    title: 'Gait symmetry — per-joint mirror RMSE',
    note: 'Left/right mirror error per joint pair over the whole test. Lower is more symmetric; a limp shows up as one or two tall bars.',
    categories: jointLabels,
    yLabel: 'rad',
    groups: ok.map((e) => ({ ...line(e), values: jointLabels.map((joint) => pairsOf(e).find((p) => p.joint === joint)?.mirrorRmse ?? NaN) })),
  }) : '';

  const pushRows = ok.filter((e) => e.metrics.perturbations);
  const pushCell = (event) => {
    if (event.fallenBeforePush) return '<span class="err">already down</span>';
    if (event.score == null) return 'n/a';
    const label = event.recovered ? fmt(event.score, 2) : '<span class="err">fell</span>';
    return `${label}<br><span class="muted">${esc(event.alignClass)}</span>`;
  };
  const pushTable = pushRows.length
    ? section('Push recovery', 'Each push is a real force (N) through the target body\'s own center of mass, held for a duration. Score (0-1) measures how well command tracking survived the push — not just whether the robot fell — accounting for whether the push went with or against the robot\'s own commanded motion; see the "align" row.',
      scroll('<table><thead><tr><th>Policy</th><th>Survived</th><th>Mean score</th>'
        + (pushRows[0].metrics.perturbations.events || []).map((e) => `<th>t=${fmt(e.t, 1)}s<br>[${fmt(e.dir?.[0], 1)}, ${fmt(e.dir?.[1], 1)}] F=${fmt(e.force, 0)}N${e.targetBody ? ` @${esc(e.targetBody)}` : ''}</th>`).join('')
        + '</tr></thead><tbody>'
        + pushRows.map((e) => {
          const pert = e.metrics.perturbations;
          return `<tr><td>${policyName(e.policy, colorFor)}</td>`
            + `<td>${pert.survived}/${pert.total}</td><td>${fmt(pert.meanScore, 2)}</td>`
            + (pert.events || []).map((event) => `<td>${pushCell(event)}</td>`).join('')
            + '</tr>';
        }).join('')
        + '</tbody></table>'))
    : '';

  return outcomes + errorNotes + kpiTable + trackingCharts + errorCharts + driftChart + topDown + symmetryChart + pushTable;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light }
body { margin: 0; padding: 32px 36px 64px; background: #f7f9fb; color: #17212b;
       font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       overflow-wrap: anywhere }
h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.01em }
h2 { margin: 40px 0 4px; font-size: 19px; border-bottom: 1px solid #dbe2e8; padding-bottom: 6px }
h3 { margin: 22px 0 4px; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #43525f }
.muted { color: #63727f }
.explain { max-width: 70ch; color: #52606d; margin: 2px 0 10px }
section { margin-bottom: 8px }
.scroll { max-width: 100%; overflow-x: auto }
table { border-collapse: collapse; margin: 6px 0 14px; background: #fff; font-variant-numeric: tabular-nums }
th, td { border: 1px solid #dbe2e8; padding: 6px 10px; text-align: right; white-space: nowrap }
th:first-child, td:first-child { text-align: left }
td.center { text-align: center }
thead th { background: #eef2f6; font-weight: 600 }
tr.total td { background: #f3f6f9; font-weight: 600 }
svg { width: 100%; max-width: 820px; height: auto; background: #fff; border: 1px solid #dbe2e8; border-radius: 4px }
svg.square { max-width: 400px }
.tick { font-size: 9px; fill: #63727f }
.axis-label { font-size: 10px; fill: #43525f }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 2px 0 6px }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #43525f }
.chip em { color: #8d99a6; font-style: normal }
.swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block }
.grid { display: flex; flex-wrap: wrap; gap: 16px }
.grid > section { margin: 0 }
.err { color: #b3261e; font-weight: 600 }
code { background: #eef2f6; border-radius: 3px; padding: 1px 5px; font-size: 12px }
.pill { display: inline-block; min-width: 66px; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 500; text-align: center }
.pill.passed { background: #d9f2e8; color: #0b6b4a }
.pill.fell { background: #fbdedd; color: #a3201f }
.pill.missed { background: #fdefd3; color: #8a5300 }
.pill.error { background: #3a2a2a; color: #fff }
.pill.none { background: #eceff2; color: #7b8794 }
.outcomes { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 14px }
.outcome { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid; font-size: 13px }
.outcome.good { border-color: #8fd9c0; background: #f2fbf7 }
.outcome.bad { border-color: #f0b3b0; background: #fff5f4 }
.outcome.warn { border-color: #f1cf8f; background: #fffaf0 }
.outcome-policy { color: #63727f; font-size: 12px }
.outcome-note { background: rgba(0,0,0,.06); color: #52606d; border-radius: 10px; padding: 1px 7px; font-size: 11px }
.warn { background: #fff4f3; border: 1px solid #f3c6c2; border-radius: 4px; padding: 8px 12px; margin: 8px 0 }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px }
.tabs.main { position: sticky; top: 0; z-index: 1; background: #f7f9fb; padding: 10px 0; border-bottom: 1px solid #dbe2e8 }
.tab { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid #dbe2e8; background: #fff;
       color: #43525f; border-radius: 6px; padding: 6px 14px }
.tab:hover { border-color: #b7c2cb }
.tab.active { background: #17212b; border-color: #17212b; color: #fff }
.tab-group-label { display: flex; align-items: center; font-size: 11px; text-transform: uppercase;
       letter-spacing: .05em; color: #8d99a6; padding: 0 4px 0 10px; margin-left: 6px;
       border-left: 1px solid #dbe2e8 }
.tab-group-label:first-child { border-left: none; margin-left: 0 }
@media (max-width: 600px) { body { padding: 16px 16px 48px } h1 { font-size: 21px } }
`;

// Vanilla JS, no build step: a tab shows the pane of its group whose
// data-pane matches its data-show and hides the group's other panes. The main
// group switches between the aggregate and the tests; each test has a group
// for its repeats. Runs once at the bottom of the document.
const TAB_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var group = tab.getAttribute('data-group');
      var target = tab.getAttribute('data-show');
      document.querySelectorAll('.tab[data-group="' + group + '"]').forEach(function (t) { t.classList.toggle('active', t === tab); });
      document.querySelectorAll('.pane[data-group="' + group + '"]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== target; });
      if (group === 'main') window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    });
  });
})();
</script>`;

const tab = (group, show, label, active, title = '') => `<button type="button" class="tab${active ? ' active' : ''}" data-group="${group}" data-show="${show}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;

const pane = (group, name, body, shown) => `<div class="pane" data-group="${group}" data-pane="${name}"${shown ? '' : ' hidden'}>${body}</div>`;

/** Build the full standalone HTML document for a result.json. */
export function buildBenchmarkReportHtml(result) {
  if (result?.schema !== RESULT_SCHEMA) throw new Error(`Not a benchmark result (expected schema ${RESULT_SCHEMA})`);
  const view = resultView(result);
  const policies = view.policies;
  const colorFor = (key) => PALETTE[Math.max(0, policies.findIndex((p) => p.key === key)) % PALETTE.length];
  const generated = view.generatedAt ? new Date(view.generatedAt).toLocaleString() : new Date().toLocaleString();
  const cellCount = (n) => `${n} cell${n === 1 ? '' : 's'}`;

  const partial = view.complete ? ''
    : `<div class="warn"><b>Partial result</b>: ${view.cellCount} of ${cellCount(view.expectedCells)}`
      + `${view.shard ? ` (shard ${view.shard.index}/${view.shard.count})` : ''}. Task values need every cell, so they are left out.</div>`;

  // ---- aggregate ----
  const aggregate = (view.complete ? `<h2>Tasks</h2>
<p class="explain">The benchmark's scores: each is a mean over the tests in its scope, with a 95% interval from the spread across repeats.</p>
${tasksTable(view, colorFor)}` : '')
    + `<h2>Outcomes</h2>
<p class="explain">How each repeat ended: passed, fell (with the time), stayed upright but missed the test's end zone (with the distance), or errored. Hover a cell for its seed and any error or capture warning. The means leave out errored repeats.</p>`
    + policies.map((p) => `<h3>${swatch(colorFor(p.key))} ${esc(p.label)}</h3>${policyOutcomeTable(view, p)}`).join('')
    + '<h2>Across all tests</h2>'
    + aggregateTable(view, colorFor);

  // ---- per test, a tab per repeat ----
  // Indexed names (t0, t1, ...) avoid escaping test ids for use in attribute selectors.
  const testPanes = view.tests.map((test, ti) => {
    const group = `t${ti}`;
    const repeats = test.repeats.map(({ repeat, seed }, ri) => {
      const entries = policies
        .map((policy) => ({ policy, outcome: policy.tests[ti].outcomes[ri] }))
        .filter((e) => e.outcome)
        .map((e) => ({ ...e, metrics: e.outcome.cell.metrics || {} }));
      return { repeat, seed, body: `<p class="muted">Repeat #${repeat} · seed ${seed}</p>${repeatBody(test, entries, colorFor)}` };
    });
    const repeatTabs = repeats.length > 1
      ? `<nav class="tabs">${repeats.map((r, i) => tab(group, `r${i}`, `#${r.repeat}`, i === 0, `seed ${r.seed}`)).join('')}</nav>`
      : '';
    const outcomeRows = scroll('<table><thead><tr><th>Policy</th>'
      + test.repeats.map((r) => `<th title="seed ${r.seed}">#${r.repeat}</th>`).join('')
      + '<th>Passed</th></tr></thead><tbody>'
      + policies.map((p) => `<tr><td>${policyName(p, colorFor)}</td>`
        + p.tests[ti].outcomes.map((o) => `<td class="center">${outcomePill(o)}</td>`).join('')
        + `<td>${p.tests[ti].counts.passed}/${p.tests[ti].counts.total}</td></tr>`).join('')
      + '</tbody></table>');
    const body = `<h2>${esc(test.name)}</h2>`
      + `<p class="muted">${esc(test.id)} · ${fmt(test.duration, 0)} s · ${test.repeats.length} repeat(s)</p>`
      + outcomeRows
      + '<h3>Test input — commanded trajectory</h3>'
      + inputTrajectoryCharts(test.sequence)
      + repeatTabs
      + (repeats.length ? repeats.map((r, i) => pane(group, `r${i}`, r.body, i === 0)).join('') : '<p class="muted">No cells recorded for this test.</p>');
    return pane('main', group, body, false);
  }).join('');

  // Tests come grouped by config; label each run of tests with its config.
  let lastConfig = null;
  const tabs = '<nav class="tabs main">'
    + tab('main', 'agg', 'Aggregate', true)
    + view.tests.map((t, ti) => {
      const divider = t.config !== lastConfig ? `<span class="tab-group-label">${esc(t.config)}</span>` : '';
      lastConfig = t.config;
      return divider + tab('main', `t${ti}`, t.name, false, t.id);
    }).join('')
    + '</nav>';

  // ---- manifest: exactly which policies and which tests took part ----
  const policyTable = '<h3>Policies</h3>'
    + scroll('<table><thead><tr><th>Policy</th><th>Id</th><th>Weights</th><th>ONNX sha256</th><th>Revision</th></tr></thead><tbody>'
      + result.policies.map((p) => `<tr>
          <td>${swatch(colorFor(p.key))} ${esc(p.label)}</td><td>${esc(p.id)}</td>
          <td>${esc(p.primary || 'n/a')}</td><td>${p.files?.onnx ? `<code>${esc(p.files.onnx.slice(0, 12))}</code>` : 'n/a'}</td>
          <td>${p.sha ? `<code>${esc(p.sha.slice(0, 12))}</code>` : 'n/a'}</td>
        </tr>`).join('')
      + '</tbody></table>');
  const testTable = '<h3>Tests</h3>'
    + scroll('<table><thead><tr><th>Test</th><th>Id</th><th>Duration (s)</th><th>Repeats</th><th>Keypoints</th><th>Push events</th><th>Command limits vx / vy / wz</th></tr></thead><tbody>'
      + view.tests.map((t) => `<tr>
          <td>${esc(t.name)}</td><td>${esc(t.id)}</td><td>${fmt(t.duration, 0)}</td>
          <td title="seeds ${esc(t.repeats.map((r) => r.seed).join(', '))}">${t.repeats.length}</td>
          <td>${t.sequence?.commands?.length ?? 'n/a'}</td>
          <td>${t.sequence?.events?.length ?? 0}</td>
          <td>${AXES.map((axis) => {
            const l = limitsOf(t.sequence, axis.key);
            return l ? `${fmt(l[0], 1)}…${fmt(l[1], 1)}` : 'n/a';
          }).join(' / ')}</td>
        </tr>`).join('')
      + '</tbody></table>');
  const source = view.benchmark.id || result.benchmark.path || result.benchmark.source || '';

  // Escaping `</` keeps the payload from terminating the <script> element early.
  const embedded = JSON.stringify(result).replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(view.benchmark.title)} v${esc(view.benchmark.version)} — ${esc(generated)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(view.benchmark.title)} <span class="muted">v${esc(view.benchmark.version)}</span></h1>
<p class="muted">${esc(generated)} · ${policies.length} policy(ies) × ${view.tests.length} test(s) · ${cellCount(view.cellCount)}${source ? ` · ${esc(source)}` : ''}</p>
${partial}
${legend(policies.map((p) => ({ label: p.label, color: colorFor(p.key) })))}
<h2>What was run</h2>
${policyTable}
${testTable}
${tabs}
${pane('main', 'agg', aggregate, true)}
${testPanes}
<h2>Raw data</h2>
<p class="explain">The complete result.json — every policy, every test and every metric series drawn
above — is embedded in this file. Open this file in a text editor, or in a browser console run
<code>JSON.parse(document.getElementById('benchmark-result').textContent)</code> to get it back.</p>
<script type="application/json" id="benchmark-result">${embedded}</script>
${TAB_SCRIPT}
</body>
</html>
`;
}

/** Build the report and hand it to the browser as a download. */
export function downloadBenchmarkReport(result, filename = null) {
  const html = buildBenchmarkReportHtml(result);
  const stamp = (result?.generatedAt || new Date().toISOString()).slice(0, 19).replace(/[-:]/g, '');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `benchmark_report_${stamp}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click has been handed off to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return link.download;
}
