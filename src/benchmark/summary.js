// Turns per-cell results (one per policy x test x repeat) into
//   1. per-test summaries: repeats combined by the suite's pass_rule/aggregate
//   2. leaderboard task values: one number per suite task, which is what goes
//      into a model repo's .eval_results/ file.
// The raw per-cell metrics stay in run.json; nothing here is lossy for them.
//
// A cell that errored counts as a failure (not upright, no push recovered),
// never as missing data, so a crashing policy cannot score well by crashing.

const round = (value, digits = 4) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Combines one number per repeat; "worst" means the max for lower-is-better values. */
function combine(values, aggregate, { lowerIsBetter = true } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  if (aggregate === 'median') return median(finite);
  if (aggregate === 'worst') return lowerIsBetter ? Math.max(...finite) : Math.min(...finite);
  return mean(finite);
}

/** Pass value of a yes/no outcome over repeats: 0/1 for all_repeats, the pass fraction otherwise. */
function passValue(passes, n, passRule) {
  if (!n) return 0;
  return passRule === 'fraction' ? passes / n : passes === n ? 1 : 0;
}

function trackingRmse(metrics) {
  const overall = metrics?.commandTracking?.overall;
  const axes = ['vx', 'vy', 'wz'].map((axis) => overall?.[axis]).filter(Number.isFinite);
  return axes.length ? mean(axes) : null;
}

/**
 * @param cells    cell results for ONE policy (any order)
 * @param selected selectTests() output: [{ row, settings }]
 */
export function summarizeTests(cells, selected) {
  return selected.map(({ row, settings }) => {
    const mine = cells.filter((cell) => cell.testId === row.id).sort((a, b) => a.repeat - b.repeat);
    const n = mine.length;
    const ok = mine.filter((cell) => !cell.error && cell.metrics);
    const uprightPasses = ok.filter((cell) => !cell.metrics.fell?.fell).length;

    const pushes = row.events.filter((event) => event.type === 'push');
    const events = pushes.map((event, index) => {
      const recovered = ok.filter((cell) => cell.metrics.perturbations?.events?.[index]?.recovered === true).length;
      const value = passValue(recovered, n, settings.pass_rule);
      return {
        index,
        t: event.t,
        force: event.force,
        tier: event.tier ?? null,
        targetBody: event.targetBody ?? null,
        recovered,
        n,
        value: round(value),
        passed: settings.pass_rule === 'fraction' ? value >= 0.5 : value === 1,
      };
    });

    return {
      testId: row.id,
      config: row.config,
      repeats: n,
      errors: n - ok.length,
      upright: { passes: uprightPasses, n, value: round(passValue(uprightPasses, n, settings.pass_rule)) },
      fellAt: mine.map((cell) => (cell.error ? null : cell.metrics?.fell?.time ?? null)),
      trackingRmse: round(combine(ok.map((cell) => trackingRmse(cell.metrics)), settings.aggregate)),
      finalDriftM: round(combine(ok.map((cell) => cell.metrics.drift?.final_m), settings.aggregate)),
      events,
    };
  });
}

const inList = (value, wanted) => wanted === undefined || (Array.isArray(wanted) ? wanted.includes(value) : value === wanted);

function scopedTests(perTest, scope) {
  return perTest.filter((test) => inList(test.config, scope.config) && inList(test.testId, scope.id));
}

function scopedEvents(perTest, scope) {
  return scopedTests(perTest, scope).flatMap((test) => test.events).filter((event) => inList(event.tier, scope.tier));
}

// Every metric a suite task may name. `value` returns null when the scope has
// nothing to measure (no such tests/events), and the task is then left out.
export const METRICS = {
  upright_rate: {
    higherIsBetter: true,
    description: 'Fraction of tests finished without falling',
    value: (perTest, scope) => mean(scopedTests(perTest, scope).map((test) => test.upright.value)),
  },
  push_pass_rate: {
    higherIsBetter: true,
    description: 'Fraction of push events the robot recovered from',
    value: (perTest, scope) => mean(scopedEvents(perTest, scope).map((event) => event.value)),
  },
  max_force_survived_n: {
    higherIsBetter: true,
    description: 'Largest push force (N) the robot recovered from',
    value: (perTest, scope) => {
      const events = scopedEvents(perTest, scope);
      if (!events.length) return null;
      return Math.max(0, ...events.filter((event) => event.passed).map((event) => event.force));
    },
  },
  tracking_rmse: {
    higherIsBetter: false,
    description: 'Mean velocity-command tracking RMSE (vx, vy, wz averaged)',
    value: (perTest, scope) => mean(scopedTests(perTest, scope).map((test) => test.trackingRmse).filter(Number.isFinite)),
  },
  tracking_score: {
    higherIsBetter: true,
    description: '1 / (1 + tracking_rmse), so higher is better',
    value: (perTest, scope) => {
      const rmse = METRICS.tracking_rmse.value(perTest, scope);
      return rmse === null ? null : 1 / (1 + rmse);
    },
  },
  drift_final_m: {
    higherIsBetter: false,
    description: 'Mean final distance (m) from the commanded path',
    value: (perTest, scope) => mean(scopedTests(perTest, scope).map((test) => test.finalDriftM).filter(Number.isFinite)),
  },
  drift_score: {
    higherIsBetter: true,
    description: '1 / (1 + drift_final_m), so higher is better',
    value: (perTest, scope) => {
      const drift = METRICS.drift_final_m.value(perTest, scope);
      return drift === null ? null : 1 / (1 + drift);
    },
  },
};

/** One value per suite task for one policy; tasks with nothing to measure get value null. */
export function computeTasks(suite, perTest) {
  return suite.tasks.map((task) => {
    const metric = METRICS[task.metric];
    return {
      taskId: `${task.id}_v${suite.version}`,
      metric: task.metric,
      higherIsBetter: metric.higherIsBetter,
      value: round(metric.value(perTest, task.scope)),
    };
  });
}
