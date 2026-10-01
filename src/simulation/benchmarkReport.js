// Standalone HTML report for a completed benchmark run.
//
// Everything is inlined — charts are hand-drawn SVG, no CDN and no runtime JS —
// so the downloaded file renders identically offline and can be attached to a
// review or checked in next to a checkpoint. The numbers here are derived the
// same way as BenchmarkResults.vue so the two never disagree.

import { COMMAND_LIMITS } from './commandSequencer.js';

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

export function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
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
    return '<p class="muted">The test JSON was not stored with this run, so its command profile '
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
  const keypointTable = '<table><thead><tr><th>t (s)</th><th>vx</th><th>vy</th><th>wz</th></tr></thead><tbody>'
    + [...sequence.commands].sort((a, b) => a.t - b.t).map((c) => (
      `<tr><td>${fmt(c.t, 2)}</td><td>${fmt(c.vx, 2)}</td><td>${fmt(c.vy, 2)}</td><td>${fmt(c.wz, 2)}</td></tr>`
    )).join('')
    + '</tbody></table>';
  const eventTable = events.length
    ? '<table><thead><tr><th>t (s)</th><th>direction</th><th>force (N)</th><th>duration (s)</th><th>target body</th></tr></thead><tbody>'
      + events.map((e) => `<tr><td>${fmt(e.t, 2)}</td><td>[${fmt(e.dir?.[0], 2)}, ${fmt(e.dir?.[1], 2)}]</td><td>${fmt(e.force, 1)}</td><td>${fmt(e.duration, 3)}</td><td>${esc(e.targetBody || 'pelvis')}</td></tr>`).join('')
      + '</tbody></table>'
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

// ---------------------------------------------------------------------------
// categorization — a test's folder (see benchmark/*/*.json) IS its category,
// so this needs no separate taxonomy to maintain: reorganizing benchmark/
// reorganizes the report. A root-level file (no folder) is "general".
// ---------------------------------------------------------------------------

export function categoryOf(file) {
  const idx = String(file || '').lastIndexOf('/');
  return idx === -1 ? 'general' : file.slice(0, idx);
}

const CATEGORY_LABELS = {
  general: 'General',
  locomotion: 'Locomotion',
  distance: 'Distance / endurance',
  friction: 'Friction stress',
  'push/standing': 'Push — standing',
  'push/walking': 'Push — walking',
  'push/sustained': 'Push — sustained ramp',
};

export function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || cat.split('/').map((s) => s[0].toUpperCase() + s.slice(1)).join(' — ');
}

// ---------------------------------------------------------------------------
// row derivation (mirrors BenchmarkResults.vue deriveRow)
// ---------------------------------------------------------------------------

export function deriveRow(result) {
  const m = result?.metrics || {};
  const ct = m.commandTracking?.overall || {};
  const gs = m.gaitSymmetry || {};
  const as = m.actionSmoothness || {};
  const bal = m.balance || {};
  const drift = m.drift || {};
  const pert = m.perturbations || null;
  return {
    policyId: result.policyId,
    error: result.error || null,
    warning: result.warning || null,
    frames: result.frames ?? m.frames ?? null,
    metrics: m,
    rmse: ct,
    trackRmse: mean([ct.vx, ct.vy, ct.wz]),
    symmetry: gs.symmetryScorePercent,
    pairs: gs.pairs || [],
    finalDrift: drift.final_m,
    maxDrift: drift.max_m,
    jerk: as.jerkLikeScore,
    meanDelta: as.meanAbsDelta,
    rmsDelta: as.rmsDelta,
    supMean: bal.meanSupportMargin_m,
    supMin: bal.minSupportMargin_m,
    perturbations: pert,
    fell: !!m.fell?.fell,
    fellTime: m.fell?.time ?? null,
  };
}

/**
 * Highest push force (N) actually survived across a set of derived rows —
 * the max `force` among perturbation events with `recovered === true`. A
 * "9/10 survived" count doesn't say whether that's 9 easy low-force pushes
 * or 9 pushes right up near the policy's real limit; this does. Returns
 * null when the rows carry no recovered push event (non-push categories,
 * or a category where every push failed).
 */
export function maxForceSurvived(rows) {
  let max = null;
  for (const row of rows) {
    for (const e of row?.perturbations?.events || []) {
      if (e?.recovered !== true || !Number.isFinite(e.force)) continue;
      const f = Math.abs(e.force);
      if (max === null || f > max) max = f;
    }
  }
  return max;
}

/**
 * A row counts as "upright" when it produced a usable result that didn't
 * fall — a warning does NOT disqualify it, it's just a caveat surfaced
 * alongside. Shared by the category rollup below and by
 * BenchmarkResults.vue's fall-summary matrix so the two "upright" concepts
 * can't quietly diverge, even though they're displayed differently (a plain
 * count here, a titled matrix cell there).
 */
export function isUpright(row) {
  return !row.error && !row.fell;
}

/**
 * Group `tests` by category (see categoryOf) and, within each category,
 * build one summary per policy from its rows — the loop that used to be
 * reimplemented near-verbatim in benchmarkReport.js, render-pr-summary.mjs
 * and BenchmarkResults.vue. Each consumer formats/labels the numbers
 * differently (HTML table, Markdown table, reactive Vue rows), so this
 * returns the raw per-policy numbers rather than pre-formatted strings.
 */
export function computeCategoryRollup(tests, policies, results) {
  const categories = [...new Set(tests.map((t) => categoryOf(t.file)))].sort();
  return categories.map((category) => {
    const catTests = tests.filter((t) => categoryOf(t.file) === category);
    const perPolicy = policies.map((policy) => {
      const rows = catTests
        .map((t) => results.find((r) => r.testFile === t.file && r.policyId === policy.id))
        .filter(Boolean)
        .map(deriveRow);
      const pushSurvived = rows.reduce((sum, r) => sum + (r.perturbations?.survived ?? 0), 0);
      const pushTotal = rows.reduce((sum, r) => sum + (r.perturbations?.total ?? 0), 0);
      return {
        policyId: policy.id,
        policy,
        rows,
        total: rows.length,
        upright: rows.filter(isUpright).length,
        trackRmse: mean(rows.map((r) => r.trackRmse)),
        finalDrift: mean(rows.map((r) => r.finalDrift)),
        pushSurvived,
        pushTotal,
        maxForce: maxForceSurvived(rows),
        errors: rows.filter((r) => r.error).length,
      };
    });
    return { category, categoryLabel: categoryLabel(category), perPolicy };
  });
}

function xySeries(times, values) {
  const points = [];
  const n = Math.min(times?.length ?? 0, values?.length ?? 0);
  for (let i = 0; i < n; i++) points.push([times[i], values[i]]);
  return points;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light }
body { margin: 0; padding: 32px 36px 64px; background: #f7f9fb; color: #17212b;
       font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif }
h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.01em }
h2 { margin: 40px 0 4px; font-size: 19px; border-bottom: 1px solid #dbe2e8; padding-bottom: 6px }
h3 { margin: 22px 0 4px; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #43525f }
.muted { color: #63727f }
.explain { max-width: 70ch; color: #52606d; margin: 2px 0 10px }
section { margin-bottom: 8px }
table { border-collapse: collapse; margin: 6px 0 14px; background: #fff; font-variant-numeric: tabular-nums }
th, td { border: 1px solid #dbe2e8; padding: 6px 10px; text-align: right; white-space: nowrap }
th:first-child, td:first-child { text-align: left }
thead th { background: #eef2f6; font-weight: 600 }
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
.pill { display: inline-block; min-width: 66px; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 500 }
.pill.upright { background: #d9f2e8; color: #0b6b4a }
.pill.fell { background: #fbdedd; color: #a3201f }
.pill.none { background: #eceff2; color: #7b8794 }
.outcomes { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 14px }
.outcome { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid; font-size: 13px }
.outcome.good { border-color: #8fd9c0; background: #f2fbf7 }
.outcome.bad { border-color: #f0b3b0; background: #fff5f4 }
.outcome-policy { color: #63727f; font-size: 12px }
.outcome-note { background: rgba(0,0,0,.06); color: #52606d; border-radius: 10px; padding: 1px 7px; font-size: 11px }
.warn { background: #fff4f3; border: 1px solid #f3c6c2; border-radius: 4px; padding: 8px 12px; margin: 8px 0 }
.tabs { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 4px;
        background: #f7f9fb; padding: 10px 0; margin: 4px 0 8px; border-bottom: 1px solid #dbe2e8 }
.tab { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid #dbe2e8; background: #fff;
       color: #43525f; border-radius: 6px; padding: 6px 14px }
.tab:hover { border-color: #b7c2cb }
.tab.active { background: #17212b; border-color: #17212b; color: #fff }
.tab-group-label { display: flex; align-items: center; font-size: 11px; text-transform: uppercase;
       letter-spacing: .05em; color: #8d99a6; padding: 0 4px 0 10px; margin-left: 6px;
       border-left: 1px solid #dbe2e8 }
.tab-group-label:first-child { border-left: none; margin-left: 0 }
`;

/** Build the full standalone HTML document for a benchmark run. */
export function buildBenchmarkReportHtml(run) {
  if (!run || !Array.isArray(run.results)) {
    throw new Error('No benchmark results to report');
  }
  const policies = Array.isArray(run.policies) ? run.policies : [];
  const tests = Array.isArray(run.tests) ? run.tests : [];
  const colorFor = (policyId) => PALETTE[Math.max(0, policies.findIndex((p) => p.id === policyId)) % PALETTE.length];
  const labelFor = (policyId) => policies.find((p) => p.id === policyId)?.label || policyId;

  const rowsFor = (testFile) => policies
    .map((p) => run.results.find((r) => r.testFile === testFile && r.policyId === p.id))
    .filter(Boolean)
    .map(deriveRow);

  // ---- aggregate ----
  const aggregate = policies.map((policy) => {
    const rows = run.results.filter((r) => r.policyId === policy.id).map(deriveRow);
    const pushSurvived = rows.reduce((sum, r) => sum + (r.perturbations?.survived ?? 0), 0);
    const pushTotal = rows.reduce((sum, r) => sum + (r.perturbations?.total ?? 0), 0);
    return {
      policy,
      tests: rows.length,
      trackRmse: mean(rows.map((r) => r.trackRmse)),
      symmetry: mean(rows.map((r) => r.symmetry)),
      finalDrift: mean(rows.map((r) => r.finalDrift)),
      jerk: mean(rows.map((r) => r.jerk)),
      pushes: pushTotal ? `${pushSurvived}/${pushTotal}` : 'n/a',
      // Coarse, across every push category combined — see "Results by
      // category" below for the per-location breakdown a single number like
      // this necessarily hides (e.g. groin/pelvis tolerating far more force
      // than shoulders).
      maxForce: maxForceSurvived(rows),
      falls: rows.filter((r) => r.fell).length,
      errors: rows.filter((r) => r.error).length,
    };
  });

  // Survival matrix: policy × test, read before any of the averages.
  const cellFor = (policyId, testFile) => {
    const result = run.results.find((r) => r.policyId === policyId && r.testFile === testFile);
    if (!result) return { text: '—', cls: 'none' };
    if (result.error) return { text: '—', cls: 'none' };
    const fell = result.metrics?.fell;
    if (fell?.fell) return { text: `fell ${fmt(fell.time, 1)}s`, cls: 'fell' };
    return { text: 'upright', cls: 'upright' };
  };
  const fallTable = '<table><thead><tr><th>Policy</th>'
    + tests.map((t) => `<th>${esc(t.name || t.file)}</th>`).join('')
    + '<th>Upright</th></tr></thead><tbody>'
    + policies.map((p) => {
      const cells = tests.map((t) => cellFor(p.id, t.file));
      const upright = cells.filter((c) => c.cls === 'upright').length;
      return `<tr>
        <td><span class="swatch" style="background:${colorFor(p.id)}"></span> ${esc(p.label)}</td>
        ${cells.map((c) => `<td><span class="pill ${c.cls}">${esc(c.text)}</span></td>`).join('')}
        <td>${upright} / ${tests.length}</td>
      </tr>`;
    }).join('')
    + '</tbody></table>';

  const aggregateTable = `<table><thead><tr>
      <th>Policy</th><th>Tests</th><th>Track RMSE</th><th>Symmetry %</th>
      <th>Final drift (m)</th><th>Jerk</th><th>Pushes survived</th><th>Max force survived (N)</th><th>Falls</th>
    </tr></thead><tbody>`
    + aggregate.map((a) => `<tr>
        <td><span class="swatch" style="background:${colorFor(a.policy.id)}"></span> ${esc(a.policy.label)}${a.errors ? ' <span class="err">(load failed)</span>' : ''}</td>
        <td>${a.tests}</td><td>${fmt(a.trackRmse)}</td><td>${fmt(a.symmetry, 1)}</td>
        <td>${fmt(a.finalDrift, 2)}</td><td>${fmt(a.jerk)}</td><td>${esc(a.pushes)}</td>
        <td>${a.maxForce != null ? fmt(a.maxForce, 0) : 'n/a'}</td><td>${a.falls}</td>
      </tr>`).join('')
    + '</tbody></table>';

  // ---- by category ----
  // A category is a test's folder (push/standing, locomotion, friction, ...).
  // Same per-row metrics as the aggregate table above, just grouped — this
  // is what actually answers "did standing pushes get worse but walking
  // pushes get better," which one flat aggregate number can't.
  const categoryRollup = computeCategoryRollup(tests, policies, run.results);
  const categoryTable = '<table><thead><tr><th>Category</th><th>Policy</th><th>Tests</th><th>Upright</th>'
    + '<th>Track RMSE</th><th>Final drift (m)</th><th>Pushes survived</th><th>Max force survived (N)</th></tr></thead><tbody>'
    + categoryRollup.flatMap(({ category, perPolicy }) => perPolicy.map((p, i) => `<tr>
        ${i === 0 ? `<td rowspan="${perPolicy.length}">${esc(categoryLabel(category))}</td>` : ''}
        <td><span class="swatch" style="background:${colorFor(p.policy.id)}"></span> ${esc(p.policy.label)}${p.errors ? ' <span class="err">(load failed)</span>' : ''}</td>
        <td>${p.total}</td>
        <td>${p.upright}/${p.total}</td>
        <td>${fmt(p.trackRmse)}</td>
        <td>${fmt(p.finalDrift, 2)}</td>
        <td>${p.pushTotal ? `${p.pushSurvived}/${p.pushTotal}` : 'n/a'}</td>
        <td>${p.maxForce != null ? fmt(p.maxForce, 0) : 'n/a'}</td>
      </tr>`)).join('')
    + '</tbody></table>';

  // ---- push envelope by location ----
  // The category rollup above groups by folder (push/standing, push/walking,
  // ...), which still lumps e.g. groin/pelvis pushes in with shoulder pushes
  // — exactly the kind of single-number masking maxForceSurvived exists to
  // avoid. Each push test file IS one location (see benchmark/push/**), so
  // one row per (test, policy) here is the actual per-location breakdown.
  const pushTests = tests.filter((t) => categoryOf(t.file).startsWith('push/'));
  const pushEnvelopeTable = pushTests.length ? '<table><thead><tr><th>Location</th><th>Policy</th>'
    + '<th>Survived</th><th>Max force survived (N)</th></tr></thead><tbody>'
    + pushTests.flatMap((t) => policies.map((p, i) => {
      const result = run.results.find((r) => r.testFile === t.file && r.policyId === p.id);
      if (!result) return '';
      const row = deriveRow(result);
      const pert = row.perturbations;
      const maxForce = maxForceSurvived([row]);
      return `<tr>
        ${i === 0 ? `<td rowspan="${policies.length}">${esc(t.name || t.file)}</td>` : ''}
        <td><span class="swatch" style="background:${colorFor(p.id)}"></span> ${esc(p.label)}${row.error ? ` <span class="err" title="${esc(row.error)}">(error)</span>` : ''}</td>
        <td>${pert ? `${pert.survived}/${pert.total}` : 'n/a'}</td>
        <td>${maxForce != null ? fmt(maxForce, 0) : 'n/a'}</td>
      </tr>`;
    })).join('')
    + '</tbody></table>' : '';

  // ---- per test ----
  // Each test's markup is wrapped in a `view` div the tab script below
  // shows/hides — same aggregate/per-test split as BenchmarkResults.vue's
  // view-mode toggle, just tabs over a static document instead of a
  // v-if branch. Indexed ids (t0, t1, ...) avoid escaping test file paths
  // for use as attribute-selector values.
  const testSections = tests.map((test, index) => {
    const rows = rowsFor(test.file);
    const viewId = `t${index}`;
    if (!rows.length) {
      return `<div class="view" data-view="${viewId}" hidden><h2>${esc(test.name || test.file)}</h2><p class="muted">No results recorded for this test.</p></div>`;
    }
    const failed = rows.filter((r) => r.error);
    const ok = rows.filter((r) => !r.error && r.metrics.series);

    const kpiTable = `<table><thead><tr>
        <th>Policy</th><th>RMSE vx</th><th>RMSE vy</th><th>RMSE wz</th><th>Symmetry %</th>
        <th>Final drift (m)</th><th>Max drift (m)</th><th>Jerk</th><th>RMS action Δ</th>
        <th>Support margin mean / min (m)</th><th>Pushes</th><th>Fell</th>
      </tr></thead><tbody>`
      + rows.map((r) => `<tr>
          <td><span class="swatch" style="background:${colorFor(r.policyId)}"></span> ${esc(labelFor(r.policyId))}</td>
          <td>${fmt(r.rmse.vx)}</td><td>${fmt(r.rmse.vy)}</td><td>${fmt(r.rmse.wz)}</td>
          <td>${fmt(r.symmetry, 1)}</td><td>${fmt(r.finalDrift, 2)}</td><td>${fmt(r.maxDrift, 2)}</td>
          <td>${fmt(r.jerk)}</td><td>${fmt(r.rmsDelta, 4)}</td>
          <td>${fmt(r.supMean)} / ${fmt(r.supMin)}</td>
          <td>${r.perturbations ? `${r.perturbations.survived}/${r.perturbations.total}` : 'n/a'}</td>
          <td>${r.fell ? `<span class="err">yes @ ${fmt(r.fellTime, 1)}s</span>` : 'no'}</td>
        </tr>`).join('')
      + '</tbody></table>';

    const errorNotes = failed.map((r) => `<div class="warn"><b>${esc(labelFor(r.policyId))}</b>: ${esc(r.error)}</div>`).join('');

    // Actual velocity per policy; the commanded profile is charted once, in the
    // test-input section above, rather than repeated under every axis.
    const trackingCharts = AXES.map((axis) => lineChart({
      title: `${axis.label} — actual per policy`,
      xLabel: 't (s)',
      yLabel: axis.unit,
      yBounds: limitsOf(test.sequence, axis.key),
      series: ok.map((r) => ({
        label: labelFor(r.policyId),
        color: colorFor(r.policyId),
        points: xySeries(r.metrics.series.time, r.metrics.series.actual?.[axis.key]),
      })),
    })).join('');

    const errorCharts = AXES.map((axis) => lineChart({
      title: `${axis.label} — tracking error (actual − command)`,
      xLabel: 't (s)',
      yLabel: axis.unit,
      series: ok.map((r) => ({
        label: labelFor(r.policyId),
        color: colorFor(r.policyId),
        points: xySeries(r.metrics.series.time, r.metrics.series.error?.[axis.key]),
      })),
    })).join('');

    const driftChart = lineChart({
      title: 'Position drift over time',
      note: 'Distance between the actual root position and the position implied by integrating the commanded velocity.',
      xLabel: 't (s)',
      yLabel: 'm',
      series: ok.map((r) => ({
        label: labelFor(r.policyId),
        color: colorFor(r.policyId),
        points: xySeries(r.metrics.series.time, r.metrics.series.drift),
      })),
    });

    // Top-down: one panel per policy, each against its own canonical path.
    const topDown = '<h3>Top-down trajectory — one panel per policy</h3>'
      + '<p class="explain">Floor-plan view (x versus y). The dashed grey line is the canonical path implied by the commands; the coloured line is what the policy actually walked. Dots mark the start.</p>'
      + '<div class="grid">'
      + ok.map((r) => pathChart({
        title: labelFor(r.policyId),
        series: [
          { label: 'canonical', color: CANONICAL_COLOR, dashed: true, points: r.metrics.topDown?.expected || [] },
          { label: 'actual', color: colorFor(r.policyId), points: r.metrics.topDown?.actual || [] },
        ],
      })).join('')
      + '</div>';

    const jointLabels = [...new Set(ok.flatMap((r) => r.pairs.map((p) => p.joint)))];
    const symmetryChart = jointLabels.length ? groupedBars({
      title: 'Gait symmetry — per-joint mirror RMSE',
      note: 'Left/right mirror error per joint pair over the whole test. Lower is more symmetric; a limp shows up as one or two tall bars.',
      categories: jointLabels,
      yLabel: 'rad',
      groups: ok.map((r) => ({
        label: labelFor(r.policyId),
        color: colorFor(r.policyId),
        values: jointLabels.map((joint) => r.pairs.find((p) => p.joint === joint)?.mirrorRmse ?? NaN),
      })),
    }) : '';

    const pushRows = ok.filter((r) => r.perturbations);
    const pushCell = (e) => {
      if (e.fallenBeforePush) return '<span class="err">already down</span>';
      if (e.score == null) return 'n/a';
      const label = e.recovered ? fmt(e.score, 2) : `<span class="err">fell</span>`;
      return `${label}<br><span class="text-caption">${e.alignClass}</span>`;
    };
    const pushTable = pushRows.length
      ? section('Push recovery', 'Each push is a real force (N) through the target body\'s own center of mass, held for a duration. Score (0-1) measures how well command tracking survived the push — not just whether the robot fell — accounting for whether the push went with or against the robot\'s own commanded motion; see the "align" row.',
        '<table><thead><tr><th>Policy</th><th>Survived</th><th>Mean score</th>'
        + (pushRows[0].perturbations.events || []).map((e) => `<th>t=${fmt(e.t, 1)}s<br>[${fmt(e.dir?.[0], 1)}, ${fmt(e.dir?.[1], 1)}] F=${fmt(e.force, 0)}N${e.targetBody ? ` @${esc(e.targetBody)}` : ''}</th>`).join('')
        + '</tr></thead><tbody>'
        + pushRows.map((r) => `<tr><td><span class="swatch" style="background:${colorFor(r.policyId)}"></span> ${esc(labelFor(r.policyId))}</td>`
          + `<td>${r.perturbations.survived}/${r.perturbations.total}</td>`
          + `<td>${fmt(r.perturbations.meanScore, 2)}</td>`
          + (r.perturbations.events || []).map((e) => `<td>${pushCell(e)}</td>`).join('')
          + '</tr>').join('')
        + '</tbody></table>')
      : '';

    // Outcome first: fell / upright / failed, plus any capture caveat.
    const outcomes = '<div class="outcomes">'
      + rows.map((r) => {
        const state = r.error ? 'bad' : r.fell ? 'bad' : 'good';
        const text = r.error
          ? 'failed to load'
          : r.fell ? `FELL at ${fmt(r.fellTime, 1)}s` : 'completed upright';
        return `<span class="outcome ${state}">`
          + `<span class="swatch" style="background:${colorFor(r.policyId)}"></span>`
          + `<b>${esc(text)}</b> <span class="outcome-policy">${esc(labelFor(r.policyId).split('/').pop())}</span>`
          + (r.warning ? `<span class="outcome-note">${esc(r.warning)}</span>` : '')
          + '</span>';
      }).join('')
      + '</div>';

    return `<div class="view" data-view="${viewId}" hidden>`
      + `<h2>${esc(test.name || test.file)}</h2>`
      + `<p class="muted">${esc(test.file)} · ${fmt(test.duration, 0)}s · ${ok.length} policy(ies) recorded</p>`
      + outcomes
      + errorNotes
      + '<h3>Test input — commanded trajectory</h3>'
      + (test.sequenceRecoveredFromDisk
        ? '<p class="explain">Recovered from the test file on disk — it was not stored with this run, so it may have been edited since.</p>'
        : '')
      + inputTrajectoryCharts(test.sequence)
      + kpiTable
      + trackingCharts
      + errorCharts
      + driftChart
      + topDown
      + symmetryChart
      + pushTable
      + '</div>';
  }).join('');

  // Tests are already sorted by file path (see listSequenceEntries), so a
  // folder's tests are already contiguous — this just adds a visible label
  // each time the category changes, rather than re-sorting or re-grouping.
  let lastTabCategory = null;
  const tabs = '<nav class="tabs">'
    + `<button type="button" class="tab active" data-view="agg">Aggregate</button>`
    + tests.map((t, index) => {
      const cat = categoryOf(t.file);
      const divider = cat !== lastTabCategory ? `<span class="tab-group-label">${esc(categoryLabel(cat))}</span>` : '';
      lastTabCategory = cat;
      return divider + `<button type="button" class="tab" data-view="t${index}">${esc(t.name || t.file)}</button>`;
    }).join('')
    + '</nav>';

  // Vanilla JS, no build step: show the view matching the clicked tab's
  // data-view, hide the rest. Runs once at the bottom of the document, after
  // every .view/.tab element already exists.
  const tabScript = `<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var views = document.querySelectorAll('.view');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-view');
      tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      views.forEach(function (v) { v.hidden = v.getAttribute('data-view') !== target; });
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    });
  });
})();
</script>`;

  // ---- manifest: exactly which policies and which test JSONs took part ----
  const policyTable = '<h3>Policies</h3>'
    + '<table><thead><tr><th>Policy</th><th>ONNX weights</th><th>Base config</th></tr></thead><tbody>'
    + policies.map((p) => `<tr>
        <td><span class="swatch" style="background:${colorFor(p.id)}"></span> ${esc(p.label)}</td>
        <td>${esc(p.onnxPath || 'from base config')}</td>
        <td>${esc(p.configPath || 'n/a')}</td>
      </tr>`).join('')
    + '</tbody></table>';
  const testTable = '<h3>Tests</h3>'
    + '<table><thead><tr><th>Test</th><th>File</th><th>Duration (s)</th><th>Keypoints</th><th>Push events</th><th>Command limits vx / vy / wz</th></tr></thead><tbody>'
    + tests.map((t) => `<tr>
        <td>${esc(t.name || t.file)}</td><td>${esc(t.file)}</td><td>${fmt(t.duration, 0)}</td>
        <td>${t.sequence?.commands?.length ?? 'n/a'}</td>
        <td>${t.sequence?.events?.length ?? 0}</td>
        <td>${['vx', 'vy', 'wz'].map((axis) => {
          const l = limitsOf(t.sequence, axis);
          return l ? `${fmt(l[0], 1)}…${fmt(l[1], 1)}` : 'n/a';
        }).join(' / ')}</td>
      </tr>`).join('')
    + '</tbody></table>';
  const manifest = policyTable + testTable;

  // Escaping `</` keeps the payload from terminating the <script> element early.
  const embedded = JSON.stringify(run).replace(/<\//g, '<\\/');

  const generated = run.generatedAt ? new Date(run.generatedAt).toLocaleString() : new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark report — ${esc(generated)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Humanoid policy benchmark</h1>
<p class="muted">${esc(generated)} · ${policies.length} policy(ies) × ${tests.length} test(s)</p>
${legend(policies.map((p) => ({ label: p.label, color: colorFor(p.id) })))}
<h2>What was run</h2>
${manifest}
${tabs}
<div class="view" data-view="agg">
<h2>Fall summary — did the robot stay upright?</h2>
${fallTable}
<h2>Aggregate across all tests</h2>
${aggregateTable}
<h2>Results by category</h2>
<p class="explain">Same metrics, grouped by each test's folder under benchmark/ — this is what shows whether a policy is uniformly robust or has a specific weak spot (e.g. fine standing, weak mid-walk; fine on rapid pushes, weak on friction).</p>
${categoryTable}
${pushEnvelopeTable ? `<h2>Push envelope by location</h2>
<p class="explain">One row per push test file — each file targets one location (groin/pelvis, chest, a specific shoulder axis, ...), so this is the actual per-location breakdown the category table above can't show (e.g. groin/pelvis reliably tolerating far more force than a shoulder push does). "Max force survived" is the highest force among that location's push events the policy actually recovered from.</p>
${pushEnvelopeTable}` : ''}
</div>
${testSections}
<h2>Raw data</h2>
<p class="explain">The complete run — every policy, every test JSON and every metric series drawn
above — is embedded in this file as JSON. Open this file in a text editor, or in a browser console run
<code>JSON.parse(document.getElementById('benchmark-run').textContent)</code> to get it back.</p>
<script type="application/json" id="benchmark-run">${embedded}</script>
${tabScript}
</body>
</html>
`;
}

/** Build the report and hand it to the browser as a download. */
export function downloadBenchmarkReport(run, filename = null) {
  const html = buildBenchmarkReportHtml(run);
  const stamp = (run?.generatedAt || new Date().toISOString()).slice(0, 19).replace(/[-:]/g, '');
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
