// npm run hf submit <result dir> [pr] [dry-run]
//
// Submits the results of a finished `npm run benchmark` run to each policy's
// model repo on the Hub (see hfEvalResults.mjs for the files): one commit per
// repo, straight to main when the token's owner owns the repo's namespace,
// otherwise (or with pr) as a pull request. Only results that can be reproduced
// are submitted; uploadBlockers decides from what result.json recorded at run
// time, so a result cannot be made submittable after the fact.
// It imports npm packages, so scripts/hf.mjs loads it after setup().

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildBenchmarkReportHtml } from '../src/simulation/benchmarkReport.js';
import { RESULT_SCHEMA, formatOutcomes, formatTasks, resultForPolicy, toReportRun, uploadBlockers } from './benchmarkRun.mjs';
import { commitFiles, readRepoText } from './hfCommit.mjs';
import { buildEvalResultEntries, evalLogsDir, evalResultsPath, mergeEvalResults } from './hfEvalResults.mjs';

/** The result.json of a result dir (or the file itself). */
export function readResult(path) {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'result.json') : path;
  if (!existsSync(file)) throw new Error(`${file} not found: give the out dir of \`npm run benchmark\``);
  const run = JSON.parse(readFileSync(file, 'utf8'));
  if (run.schema !== RESULT_SCHEMA) throw new Error(`${file} is not a ${RESULT_SCHEMA} file`);
  return run;
}

/** The files submitted to one policy's repo; `existing` is its current .eval_results file, if any. */
function policyFiles(run, policy, existing) {
  const logsDir = evalLogsDir(run.benchmark.id, run.benchmark.raw.version);
  const sourceUrl = `https://huggingface.co/${policy.repo}/blob/main/${logsDir}/report.html`;
  const entries = buildEvalResultEntries(run, policy.key, { sourceUrl });
  const policyResult = resultForPolicy(run, policy.key);
  return [
    { path: evalResultsPath(run.benchmark.id), content: mergeEvalResults(existing, entries) },
    { path: `${logsDir}/result.json`, content: JSON.stringify(policyResult) },
    { path: `${logsDir}/report.html`, content: buildBenchmarkReportHtml(toReportRun(policyResult)) },
  ];
}

export async function submit(dir, { pr = false, dryRun = false } = {}, io = {}) {
  const { env = process.env, hub = null, log = console.log } = io;
  const run = readResult(dir);
  const blocked = [];
  const results = [];
  for (const policy of run.policies) {
    log(`\n${policy.label}`);
    for (const line of formatTasks(run, policy.key)) log(`  ${line}`);
    const outcomes = formatOutcomes(run, policy.key);
    if (outcomes) log(`  ${outcomes}`);
    const blockers = uploadBlockers(run, policy.key);
    if (blockers.length) {
      log('  Not submitted:');
      for (const reason of blockers) log(`    - ${reason}`);
      blocked.push(policy.label);
      continue;
    }
    const repo = { type: 'model', name: policy.repo };
    const existing = await readRepoText({ repo, path: evalResultsPath(run.benchmark.id), revision: policy.sha, env, hub }).catch(() => null);
    const files = policyFiles(run, policy, existing);
    if (dryRun) {
      log(`  dry-run: would write to ${policy.repo} on top of ${policy.sha.slice(0, 7)}${pr ? ' as a pull request' : ' (direct commit if you own it, else a pull request)'}:`);
      for (const file of files) log(`    ${file.path} (${Buffer.byteLength(file.content)} bytes)`);
      log(`  --- ${files[0].path} ---\n${files[0].content}`);
      continue;
    }
    const result = await commitFiles({
      repo,
      files,
      title: `Add ${run.benchmark.raw.name} v${run.benchmark.raw.version} benchmark results`,
      description: `Results of \`npm run benchmark\` (humanoid-policy-viewer ${run.provenance.hpv.commit}, protocol ${run.provenance.hpv.protocol}) on datasets/${run.benchmark.id} at ${run.benchmark.sha}.`,
      parentCommit: policy.sha,
      forcePr: pr,
      env,
      hub,
      log: (line) => log(`  ${line}`),
    });
    log(`  Submitted (${result.mode === 'pr' ? 'pull request' : 'commit'}): ${result.url}`);
    results.push(result);
  }
  if (blocked.length) {
    throw new Error(`Not submitted: ${blocked.join(', ')} (see the reasons above)${results.length ? `; the other ${results.length} were` : ''}`);
  }
  return results;
}
