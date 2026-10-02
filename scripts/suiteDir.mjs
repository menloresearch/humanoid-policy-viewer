// Reads and writes a benchmark dataset laid out on disk the way it is on the
// Hugging Face Hub:
//
//   suite.yaml                 what runs and how it is scored (src/benchmark/suite.js)
//   data/<config>/test.jsonl   one test per line (src/benchmark/testRow.js)
//   eval.yaml                  generated from suite.yaml (buildEvalYaml)
//   README.md                  dataset card; its front matter is generated
//
// The same layout is used for a local working copy, a downloaded revision and
// the test fixture in test/fixtures/smoke-suite/.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildEvalYaml, parseSuite } from '../src/benchmark/suite.js';
import { validateTestRow } from '../src/benchmark/testRow.js';

export const SUITE_FILE = 'suite.yaml';
export const DATA_DIR = 'data';
export const ROWS_FILE = 'test.jsonl';

export function readYamlFile(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

/** Every row under data/, in config then file order, plus any problems found. */
export function readRows(dir) {
  const dataDir = join(dir, DATA_DIR);
  const rows = [];
  const problems = [];
  if (!existsSync(dataDir)) return { rows, problems: [`${DATA_DIR}/ is missing`] };
  for (const config of readdirSync(dataDir).sort()) {
    const configDir = join(dataDir, config);
    if (!statSync(configDir).isDirectory()) continue;
    const file = join(configDir, ROWS_FILE);
    if (!existsSync(file)) {
      problems.push(`${DATA_DIR}/${config}/ has no ${ROWS_FILE}`);
      continue;
    }
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${DATA_DIR}/${config}/${ROWS_FILE}:${i + 1}`;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        problems.push(`${where}: not valid JSON (${error.message})`);
        return;
      }
      for (const problem of validateTestRow(row)) problems.push(`${where}: ${problem}`);
      if (row.config !== config) problems.push(`${where}: row config "${row.config}" is in folder "${config}"`);
      rows.push(row);
    });
  }
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`test id ${row.id} appears twice`);
    seen.add(row.id);
  }
  return { rows, problems };
}

/** Loads suite.yaml + rows; throws if either is invalid. `suiteFile` picks another suite in the dataset. */
export function loadSuiteDir(dir, { suiteFile = SUITE_FILE } = {}) {
  const suitePath = join(dir, suiteFile);
  if (!existsSync(suitePath)) throw new Error(`${dir} has no ${suiteFile}; is it a benchmark dataset?`);
  const rawSuite = readYamlFile(suitePath);
  const suite = parseSuite(rawSuite);
  const { rows, problems } = readRows(dir);
  if (problems.length) throw new Error(`Invalid tests in ${dir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { dir, suiteFile, rawSuite, suite, rows };
}

/** Writes data/<config>/test.jsonl for every config in `rows`, plus `configs` (emptied if no rows). */
export function writeRows(dir, rows, { configs = [] } = {}) {
  const byConfig = new Map(configs.map((config) => [config, []]));
  for (const row of rows) {
    if (!byConfig.has(row.config)) byConfig.set(row.config, []);
    byConfig.get(row.config).push(row);
  }
  for (const [config, configRows] of byConfig) {
    mkdirSync(join(dir, DATA_DIR, config), { recursive: true });
    writeFileSync(join(dir, DATA_DIR, config, ROWS_FILE), configRows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  }
}

/** Dataset card front matter: one Hub config per test category, all in split "test". */
export function cardFrontMatter(rows, { license = 'bsd-3-clause', prettyName }) {
  const configs = [...new Set(rows.map((row) => row.config))].sort();
  return {
    license,
    pretty_name: prettyName,
    task_categories: ['robotics'],
    tags: ['benchmark', 'humanoid', 'locomotion', 'humanoid-policy-viewer'],
    configs: configs.map((config) => ({
      config_name: config,
      data_files: [{ split: 'test', path: `${DATA_DIR}/${config}/${ROWS_FILE}` }],
    })),
  };
}

/** Replaces (or adds) the README's YAML front matter, keeping its body. */
export function withFrontMatter(readme, frontMatter) {
  const body = readme.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return `---\n${stringifyYaml(frontMatter)}---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

/**
 * Keeps the task ids of earlier suite versions that the Hub's eval.yaml already
 * lists, so results uploaded for them keep resolving after a version bump.
 */
export function mergeEvalTasks(previous, generated) {
  const ids = new Set(generated.tasks.map((task) => task.id));
  const kept = (previous?.tasks ?? []).filter((task) => !ids.has(task.id));
  return { ...generated, tasks: [...generated.tasks, ...kept] };
}

/** Regenerates eval.yaml and the README front matter from suite.yaml and the rows. */
export function regenerateGeneratedFiles(dir, { suite, rows, rawSuite }) {
  const name = rawSuite.title ?? suite.suite;
  const description = (rawSuite.description ?? '').trim() || `Benchmark suite ${suite.suite}, run with humanoid-policy-viewer.`;
  const evalPath = join(dir, 'eval.yaml');
  const previous = existsSync(evalPath) ? readYamlFile(evalPath) : null;
  const evalYaml = mergeEvalTasks(previous, buildEvalYaml(suite, { name, description }));
  writeFileSync(evalPath, `# Generated from suite.yaml by \`npm run suite publish\`; do not edit by hand.\n${stringifyYaml(evalYaml)}`);
  const readmePath = join(dir, 'README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : `\n# ${name}\n`;
  writeFileSync(readmePath, withFrontMatter(readme, cardFrontMatter(rows, { prettyName: name })));
  return { evalYaml };
}
