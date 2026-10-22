// Creates a new benchmark folder (scripts/benchmarkDir.mjs) as a copy of the
// tracked ./benchmarks/default: `npm run benchmark init` and the viewer's "New
// benchmark" button. Kept apart from run-benchmark.mjs because the dev
// server's vite.config.mjs imports it, and Vite bundles that config.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProvenance } from './benchmarkProvenance.mjs';
import { BENCHMARK_FILE, DATA_DIR, defaultBenchmarkDir, loadBenchmarkDir, readYamlFile } from './benchmarkDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLANK_DESCRIPTION = 'Describe what this benchmark measures.';

/**
 * Creates a new benchmark folder from ./benchmarks/default: its benchmark.yaml
 * (as text, to keep the comments) under a new name and title, its README and
 * its example tests, or no tests at all with `exampleTest: false` (the
 * viewer's "New benchmark", where tests are added next).
 */
export function initBenchmark(dir, { log = console.log, title = null, exampleTest = true } = {}) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const source = defaultBenchmarkDir(appDir);
  const from = readYamlFile(join(source, BENCHMARK_FILE));
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-benchmark';
  const description = exampleTest ? from.description : BLANK_DESCRIPTION;
  const commit = collectProvenance(appDir).hpv.commit;

  mkdirSync(join(dir, DATA_DIR), { recursive: true });
  // Functions, not strings, as replacements: a "$" in a title is just a "$".
  const yaml = readFileSync(join(source, BENCHMARK_FILE), 'utf8')
    .replace(/^name: .*$/m, () => `name: ${name}`)
    .replace(/^title: .*$/m, () => `title: ${title ? JSON.stringify(title) : name}`)
    .replace(/^description: .*$/m, () => `description: ${description}`)
    .replace(/^(\s*tested_commit:) .*$/m, (_, key) => `${key} ${commit ?? 'null'}`);
  writeFileSync(join(dir, BENCHMARK_FILE), yaml);
  const readme = readFileSync(join(source, 'README.md'), 'utf8')
    .replace(/^# .*$/m, () => `# ${title ?? name}`)
    .replace(from.description, () => description);
  writeFileSync(join(dir, 'README.md'), readme);
  if (exampleTest) cpSync(join(source, DATA_DIR), join(dir, DATA_DIR), { recursive: true });

  const { rows } = loadBenchmarkDir(dir);
  log(`Created benchmark ${name} in ${dir}${exampleTest ? ` with ${rows.length} example tests` : ''}.`);
  log(`Edit it with: npm run dev benchmark=${dir}`);
}
