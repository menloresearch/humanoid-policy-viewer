// Reads and writes a benchmark dataset laid out on disk the way it is on the
// Hugging Face Hub:
//
//   benchmark.yaml             what runs and how it is scored (src/benchmark/settings.js)
//   data/<config>/test.jsonl   one test per line (src/benchmark/testRow.js)
//   README.md                  optional notes; becomes the dataset card
//
// Running and editing a benchmark needs only these. The Hugging Face files
// (eval.yaml and the card's front matter) are built by hubFiles() when the
// benchmark is published, and are never written to a working copy.
//
// The same layout is used for a local working copy, a downloaded revision and
// the test fixture in test/fixtures/smoke-benchmark/.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildEvalYaml, parseBenchmark } from '../src/benchmark/settings.js';
import { ALL_CONFIG, rowFeaturesYaml, rowFromHub, rowToHub, validateTestRow } from '../src/benchmark/testRow.js';

export const BENCHMARK_FILE = 'benchmark.yaml';
export const DATA_DIR = 'data';
export const ROWS_FILE = 'test.jsonl';

// The files of a benchmark folder that are published as they are (each
// data/*/test.jsonl in its Hub form, see hubRowsText). eval.yaml and the dataset
// card's front matter are built when the benchmark is published.
export const BENCHMARK_FILES = [
  /^benchmark\.yaml$/, /^[A-Z_]+\.md$/, /^data\/[^/]+\/test\.jsonl$/, /^calibration\/[^/]+\.json$/,
  /^tools\/[^/]+\.(mjs|js|py)$/, // optional scripts that generate the tests, kept for reviewers
  /^(LICEN[CS]E|COPYING)(\.[A-Za-z0-9]+)?$/, // a license file benchmark.yaml's `license:` can point at
];

// Local benchmarks live in ./benchmarks: default/ (tracked; the one plain
// `npm run dev` opens and the one new benchmarks are copied from), and,
// gitignored, the ones "New benchmark" makes and Hub working copies.
export const defaultBenchmarkDir = (appDir) => join(appDir, 'benchmarks', 'default');

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
        row = rowFromHub(JSON.parse(line));
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

/** Loads benchmark.yaml + rows; throws if either is invalid. */
export function loadBenchmarkDir(dir) {
  const settingsPath = join(dir, BENCHMARK_FILE);
  if (!existsSync(settingsPath)) throw new Error(`${dir} has no ${BENCHMARK_FILE}; is it a benchmark?`);
  const rawBenchmark = readYamlFile(settingsPath);
  const benchmark = parseBenchmark(rawBenchmark);
  const { rows, problems } = readRows(dir);
  if (problems.length) throw new Error(`Invalid tests in ${dir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { dir, rawBenchmark, benchmark, rows };
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

/**
 * The card's license fields for benchmark.yaml's `license:`. Either a file in the
 * benchmark folder (the card says `license: other` and links it) or one of the
 * Hub's license ids (https://huggingface.co/docs/hub/repositories-licenses, which
 * the Hub checks when the card is committed). Unset or blank leaves the card without one.
 */
export function licenseFields(dir, license, benchmarkName) {
  if (!license) return {};
  if (!license.includes('/') && existsSync(join(dir, license)) && statSync(join(dir, license)).isFile()) {
    return { license: 'other', license_name: `${benchmarkName}-license`, license_link: license };
  }
  if (/^[a-z0-9][a-z0-9.+-]*$/.test(license)) return { license };
  throw new Error(`benchmark.yaml license "${license}" is neither a file in ${dir} nor a Hugging Face license id such as bsd-3-clause, apache-2.0, mit or cc-by-4.0`);
}

/** Dataset card front matter: one Hub config per test category, all in split "test". */
export function cardFrontMatter(rows, { license = {}, tags = [], prettyName }) {
  const configs = [...new Set(rows.map((row) => row.config))].sort();
  return {
    ...license,
    pretty_name: prettyName,
    task_categories: ['robotics'],
    tags: [...new Set(['humanoid-policy-viewer', ...tags])],
    // Declared column types for every config (see ROW_FEATURES).
    dataset_info: [ALL_CONFIG, ...configs].map((config) => ({ config_name: config, features: rowFeaturesYaml() })),
    // "all" (the default) holds every test; tasks spanning categories score it.
    configs: [
      { config_name: ALL_CONFIG, default: true, data_files: [{ split: 'test', path: `${DATA_DIR}/*/${ROWS_FILE}` }] },
      ...configs.map((config) => ({
        config_name: config,
        data_files: [{ split: 'test', path: `${DATA_DIR}/${config}/${ROWS_FILE}` }],
      })),
    ],
  };
}

/** Replaces (or adds) the README's YAML front matter, keeping its body. */
export function withFrontMatter(readme, frontMatter) {
  const body = readme.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return `---\n${stringifyYaml(frontMatter)}---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

/**
 * Keeps the task ids of earlier benchmark versions that the Hub's eval.yaml already
 * lists, so results uploaded for them keep resolving after a version bump.
 */
export function mergeEvalTasks(previous, generated) {
  const ids = new Set(generated.tasks.map((task) => task.id));
  const kept = (previous?.tasks ?? []).filter((task) => !ids.has(task.id));
  return { ...generated, tasks: [...generated.tasks, ...kept] };
}

/**
 * The Hugging Face files for publishing: eval.yaml built from benchmark.yaml, and
 * README.md with the dataset card front matter (configs, tags) put in front of
 * the working copy's README. `previousEvalYaml` is the eval.yaml already on the
 * Hub, whose task ids for earlier benchmark versions are kept. Nothing is written.
 */
export function hubFiles({ dir, benchmark, rows, rawBenchmark }, { previousEvalYaml = null } = {}) {
  const name = rawBenchmark.title ?? benchmark.name;
  const description = (rawBenchmark.description ?? '').trim() || `Benchmark ${benchmark.name}, run with humanoid-policy-viewer.`;
  const evalYaml = mergeEvalTasks(previousEvalYaml, buildEvalYaml(benchmark, { name, description }));
  const readmePath = join(dir, 'README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : `\n# ${name}\n`;
  return [
    { path: 'eval.yaml', content: `# Generated from benchmark.yaml by \`npm run hf publish\`; do not edit by hand.\n${stringifyYaml(evalYaml)}` },
    {
      path: 'README.md',
      content: withFrontMatter(readme, cardFrontMatter(rows, {
        license: licenseFields(dir, rawBenchmark.license, benchmark.name),
        tags: rawBenchmark.tags,
        prettyName: name,
      })),
    },
  ];
}

/**
 * Hash of everything that can change a score: the rows and benchmark.yaml without
 * its prose (title, description), its version and harness.tested_commit.
 */
export function scoredContentHash(rawBenchmark, rows) {
  const { title, description, version, reference_policies: referencePolicies, license, tags, ...rest } = rawBenchmark;
  const harness = { ...(rest.harness ?? {}) };
  delete harness.tested_commit;
  const canonical = (value) => (Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value);
  const text = JSON.stringify(canonical({ benchmark: { ...rest, harness }, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)) }));
  return createHash('sha256').update(text).digest('hex');
}

/** benchmark.yaml text with harness.tested_commit set to `commit`, its comments and layout kept. */
export function withTestedCommit(text, commit) {
  const doc = parseDocument(text);
  const node = doc.getIn(['harness', 'tested_commit'], true);
  if (node?.range && node.range[1] > node.range[0]) return text.slice(0, node.range[0]) + commit + text.slice(node.range[1]);
  doc.setIn(['harness', 'tested_commit'], commit);
  return doc.toString();
}

/** A test.jsonl's text with every row in its published form (rowToHub); rows without a start are left as written. */
export function hubRowsText(text) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const row = JSON.parse(line);
    return row.start && typeof row.start === 'object' ? JSON.stringify(rowToHub(row)) : line;
  }).join('\n');
}
