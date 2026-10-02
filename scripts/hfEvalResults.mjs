// Builds the files a benchmark run adds to a model repo on the Hub:
//
//   .eval_results/<dataset org>__<dataset name>.yaml
//       Hugging Face eval results (https://huggingface.co/docs/hub/eval-results):
//       one entry per suite task. These feed the model page and the benchmark
//       dataset's leaderboards.
//   eval_logs/<dataset name>/v<suite version>/run.json + report.html
//       the full run: every cell's metrics and the provenance; each entry's
//       source.url points here.
//
// Re-running replaces the entries for the same task ids and keeps the rest, so
// results for earlier suite versions (other _v<n> task ids) stay listed.

import { Scalar, parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function evalResultsPath(datasetId) {
  return `.eval_results/${datasetId.replace('/', '__')}.yaml`;
}

export function evalLogsDir(datasetId, suiteVersion) {
  return `eval_logs/${datasetId.split('/')[1]}/v${suiteVersion}`;
}

const short = (sha) => (sha ? sha.slice(0, 12) : 'unknown');

export function runNotes(run, model) {
  const suite = run.suite.raw;
  const parts = [
    `hpv@${short(run.provenance.hpv.commit)}`,
    `protocol=${run.provenance.hpv.protocol}`,
    `suite=${suite.suite} v${suite.version}`,
    `asimov-1@${short(run.provenance.asimov1.commit)}`,
    `model@${short(model.sha)}`,
  ];
  return parts.join(' ');
}

/**
 * The .eval_results entries for one model of a complete run. Tasks with nothing
 * to measure (value null) are left out.
 */
export function buildEvalResultEntries(run, modelKey, { sourceUrl, user = null }) {
  const model = run.models.find((m) => m.key === modelKey);
  const source = { url: sourceUrl, name: 'humanoid-policy-viewer run log' };
  if (user) source.user = user;
  return (run.tasks?.[modelKey] ?? [])
    .filter((task) => task.value !== null)
    .map((task) => ({
      dataset: { id: run.suite.id, task_id: task.taskId, revision: run.suite.sha },
      value: task.value,
      date: run.generatedAt,
      source,
      notes: runNotes(run, model),
    }));
}

/** Existing file content (YAML text or null) + new entries -> merged YAML text. */
export function mergeEvalResults(existingText, entries) {
  let existing = [];
  if (existingText && existingText.trim()) {
    const parsed = parseYaml(existingText);
    if (!Array.isArray(parsed)) throw new Error('the existing .eval_results file is not a YAML list; fix or remove it first');
    existing = parsed;
  }
  const replaced = new Set(entries.map((entry) => `${entry.dataset.id}|${entry.dataset.task_id}`));
  const kept = existing.filter((entry) => !replaced.has(`${entry?.dataset?.id}|${entry?.dataset?.task_id}`));
  const header = '# Benchmark results written by humanoid-policy-viewer (npm run benchmark).\n'
    + '# Format: https://huggingface.co/docs/hub/eval-results\n';
  // The spec wants `date` as a quoted string (unquoted, YAML 1.1 readers turn
  // it into a timestamp); no anchors/aliases for repeated values; no folded lines.
  const quoted = (value) => Object.assign(new Scalar(String(value)), { type: Scalar.QUOTE_DOUBLE });
  const out = [...kept, ...entries].map((entry) => (entry?.date ? { ...entry, date: quoted(entry.date) } : entry));
  return header + stringifyYaml(out, { aliasDuplicateObjects: false, lineWidth: 0 });
}
