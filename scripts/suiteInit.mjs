// Creates a new benchmark dataset folder (scripts/suiteDir.mjs): `npm run suite
// init`, the first `npm run dev`, and the viewer's "New benchmark" button. Kept
// apart from suite.mjs (a CLI with a shebang and the Hub tooling) because the
// dev server's vite.config.mjs imports it, and Vite bundles that config.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_PROTOCOL } from '../src/benchmark/protocol.js';
import { collectProvenance } from './benchmarkProvenance.mjs';
import { loadSuiteDir, writeRows } from './suiteDir.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A new benchmark starts from this suite.yaml (written as text to keep its comments).
function starterSuiteYaml({ name, title, commit }) {
  return `# What runs and how it is scored. Tests live in data/<category>/test.jsonl, one per line.
# Reference: humanoid-policy-viewer docs/benchmark-datasets.md
suite: ${name}
title: ${title ? JSON.stringify(title) : name}
description: Describe what this benchmark measures.
version: 1                      # bump whenever a change can move a score
harness:
  repo: https://github.com/menloresearch/humanoid-policy-viewer
  protocol: ${BENCHMARK_PROTOCOL}
  tested_commit: ${commit ?? 'null'}
requires:
  robot: { name: asimov-1 }
  policy_interface: velocity-command
defaults:
  repeats: 5                    # each repeat draws its own seeded randomisation
  seed: 0
  randomize: { action_delay: env_range, initial_joint_noise_rad: 0.02 }
  timeout_s: 600
tests:                          # { all: true }, { config: <category> } or { id: <category>/<name> }
  - { all: true }
tasks:                          # leaderboard numbers; _v<version> is appended to each id
  - { id: survival_rate, metric: survival_rate@1 }    # scope: { config, id, tag } narrows a task
  - { id: survival_time, metric: survival_time@1 }
reference_models: []            # models \`npm run suite baseline\` compares
`;
}

const STARTER_ROW = {
  id: 'locomotion/forward_walk',
  config: 'locomotion',
  schema_version: 1,
  kind: 'velocity-sequence',
  name: 'forward walk',
  description: 'Stand, walk forward at 0.6 m/s for 11 s, stop.',
  tags: [],
  duration: 12,
  commands: [{ t: 0, vx: 0, vy: 0, wz: 0 }, { t: 0.3, vx: 0.6, vy: 0, wz: 0 }, { t: 11.5, vx: 0, vy: 0, wz: 0 }],
  events: [],
  limits: null,
  foot_friction: null,
  terrain: null,
  goal: null,
  metrics_opt_in: ['gait_symmetry'],
};

/**
 * Creates a new benchmark dataset folder with a starter suite.yaml and one
 * example test, or no tests at all with `exampleTest: false` (the viewer's
 * "New benchmark", where tests are added next).
 */
export function initSuite(dir, { log = console.log, title = null, exampleTest = true } = {}) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-benchmark';
  writeFileSync(join(dir, 'suite.yaml'), starterSuiteYaml({ name, title, commit: collectProvenance(appDir).hpv.commit }));
  if (exampleTest) writeRows(dir, [STARTER_ROW]);
  const loaded = loadSuiteDir(dir);
  writeFileSync(join(dir, 'README.md'), readmeBody(loaded.rawSuite));
  log(`Created benchmark ${name} in ${dir}${exampleTest ? ` with one example test (${STARTER_ROW.id})` : ''}.`);
  log(`Edit it with: npm run dev suite=${dir}`);
}

function readmeBody(rawSuite) {
  return `
# ${rawSuite.title}

${rawSuite.description}

This is a benchmark for [humanoid-policy-viewer](${rawSuite.harness.repo}). Each row of
\`data/<config>/test.jsonl\` is one test scenario: velocity commands over time, timed pushes and the floor
friction. \`suite.yaml\` says how often each test runs, how runs are randomised and scored, and which numbers
become leaderboard tasks.

## Run it

\`\`\`
git clone ${rawSuite.harness.repo} && cd humanoid-policy-viewer && npm ci
npm run benchmark <your-org>/<your-policy> datasets/<this dataset>
\`\`\`

Results go to the model repo's \`.eval_results/\` (directly if you own it, otherwise as a pull request) and
show up on this benchmark's leaderboards. Results are tied to the viewer commit and protocol that produced them;
task ids end in the suite version (\`_v${rawSuite.version}\`), so numbers from different suite versions never share a
leaderboard.

## Change it

\`\`\`
npm run suite pull datasets/<this dataset> ./bench && npm run dev suite=./bench    # edit
npm run suite baseline ./bench
npm run suite publish ./bench pr
\`\`\`
`;
}
