// Builds the file `npm run hf submit` adds to a model repo on the Hub:
//
//   .eval_results/<dataset org>__<dataset name>.yaml
//       Hugging Face eval results (https://huggingface.co/docs/hub/eval-results):
//       one entry per benchmark task. These feed the model page and the benchmark
//       dataset's leaderboards. The full run (result.json, report.html) stays in
//       the local result dir.
//
// Re-running replaces the entries for the same task ids and keeps the rest, so
// results for earlier benchmark versions (other _v<n> task ids) stay listed.

import { Scalar, parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function evalResultsPath(datasetId) {
  return `.eval_results/${datasetId.replace('/', '__')}.yaml`;
}

const short = (sha) => (sha ? sha.slice(0, 12) : 'unknown');

export function runNotes(run, policy) {
  const benchmark = run.benchmark.raw;
  const parts = [
    `hpv@${short(run.provenance.hpv.commit)}`,
    `protocol=${run.provenance.hpv.protocol}`,
    `benchmark=${benchmark.name} v${benchmark.version}`,
    `asimov-1@${short(run.provenance.asimov1.commit)}`,
    `policy@${short(policy.sha)}`,
  ];
  return parts.join(' ');
}

/** What the number is and how sure it is; the Hub schema has no field for an interval. */
export function taskNotes(task) {
  const interval = task.ci95 ? ` 95%CI=[${task.ci95[0]}, ${task.ci95[1]}]` : '';
  return `metric=${task.metric}${interval} tests=${task.tests} runs=${task.cells}`;
}

/**
 * The .eval_results entries for one policy of a complete run. Tasks with nothing
 * to measure (value null) are left out.
 */
export function buildEvalResultEntries(run, policyKey) {
  const policy = run.policies.find((p) => p.key === policyKey);
  return (run.tasks?.[policyKey] ?? [])
    .filter((task) => task.value !== null)
    .map((task) => ({
      dataset: { id: run.benchmark.id, task_id: task.taskId, revision: run.benchmark.sha },
      value: task.value,
      date: run.generatedAt,
      notes: `${taskNotes(task)} ${runNotes(run, policy)}`,
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
  const header = '# Benchmark results written by humanoid-policy-viewer (npm run hf submit).\n'
    + '# Format: https://huggingface.co/docs/hub/eval-results\n';
  // The spec wants `date` as a quoted string (unquoted, YAML 1.1 readers turn
  // it into a timestamp); no anchors/aliases for repeated values; no folded lines.
  const quoted = (value) => Object.assign(new Scalar(String(value)), { type: Scalar.QUOTE_DOUBLE });
  const out = [...kept, ...entries].map((entry) => (entry?.date ? { ...entry, date: quoted(entry.date) } : entry));
  return header + stringifyYaml(out, { aliasDuplicateObjects: false, lineWidth: 0 });
}
