// npm run test:browser
// What the viewer is left in after an in-app benchmark Run: the viewer runs in
// headless Chromium on test/fixtures/viewer-run-benchmark, with the bundled
// checkpoint copied into a temporary policy library so the live policy is a
// library (lib:) one, which has no scene of its own to reload.
// Not part of `npm test`. Skipped when the asimov-1 scene, Playwright or its
// Chromium is not installed.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sceneIsInstalled } from '../../scripts/setup.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BENCHMARK = join(appDir, 'test/fixtures/viewer-run-benchmark');
const CHECKPOINT = join(appDir, 'public/examples/checkpoints/asimov/model_aug_18_1');
const POLICY = 'lib:policies/asimov/policy.onnx';
const TIMEOUT_MS = 300_000;
// As scripts/benchmarkBrowser.mjs: a headless page counts as in the background, and its timers would crawl.
const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

async function skipReason() {
  if (!sceneIsInstalled(appDir)) return 'asimov-1 submodule is not checked out (run scripts/init-asimov-1.sh)';
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    return 'Playwright is not installed (npm ci)';
  }
  if (!existsSync(chromium.executablePath())) return 'Chromium for Playwright is not installed (npx playwright install chromium)';
  return false;
}

const skip = await skipReason();
let tmp;
let server;
let browser;
let page;

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'hpv-browser-test-'));
  const policyDir = join(tmp, 'library/policies/asimov');
  mkdirSync(policyDir, { recursive: true });
  copyFileSync(join(CHECKPOINT, 'policy_isaaclab_new.onnx'), join(policyDir, 'policy.onnx'));
  copyFileSync(join(CHECKPOINT, 'env.yaml'), join(policyDir, 'env.yaml'));

  const { startViewer } = await import('../../scripts/startViewer.mjs');
  const { chromium } = await import('@playwright/test');
  // This checkout's own settings only, whatever HPV_* variables are set.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HPV_')));
  let url;
  ({ server, url } = await startViewer({
    benchmark: BENCHMARK,
    policyLibrary: { dir: join(tmp, 'library'), roots: ['policies'] },
    resultsDir: join(tmp, 'results'),
    port: 0,
    logLevel: 'silent',
    env,
    log: () => {},
  }));
  browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  page = await browser.newPage();
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.log(`[page error] ${msg.text()}`);
  });
  // The page never draws, as a headless benchmark page (benchmarkBrowser.mjs): Chromium draws in software here,
  // nothing these tests check is drawn, and drawing makes start-up several times slower.
  await page.addInitScript(() => { globalThis.__hpvNoDraw = true; });
  await page.goto(`${url}?policy=${encodeURIComponent(POLICY)}`, { waitUntil: 'load' });
  await page.waitForFunction((want) => {
    const component = window.__humanoidViewerDemoComponent;
    return component?.state === 1 && component.currentPolicy === want && !component.isPolicyLoading
      && !!window.__humanoidViewerDemo?.policyRunner;
  }, POLICY, { timeout: 180_000, polling: 250 });
  assert.equal(await page.evaluate(() => window.__humanoidViewerDemoComponent.policyLoadError), '');
  // Nor while a Run plays, though an in-app Run draws: drawing made each Run here take most of a minute, not seconds.
  await page.evaluate(() => { window.__humanoidViewerDemo.startRenderLoop = () => {}; });
}, { timeout: TIMEOUT_MS });

after(async () => {
  await browser?.close();
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Checks `testId` and runs it as the Run Benchmark button and its confirm dialog do; resolves once the Run has ended. */
async function runInViewer(testId) {
  const planned = await page.evaluate(async (file) => {
    const { appState } = await import('/src/state/appState.js');
    appState.benchmarkSelection = [file];
    const component = window.__humanoidViewerDemoComponent;
    await component.requestBenchmark();
    return { error: component.benchmark.error, cells: component.pendingRun?.cells.length ?? 0 };
  }, testId);
  assert.deepEqual(planned, { error: '', cells: 1 });
  const ran = await page.evaluate(async () => {
    const { appState, closeResults } = await import('/src/state/appState.js');
    const component = window.__humanoidViewerDemoComponent;
    await component.startBenchmark();
    const cells = appState.benchmarkResults?.cells ?? [];
    // The Run opens its results; go back to the viewer, as the user would.
    closeResults();
    return { running: component.benchmark.running, error: component.benchmark.error, cellErrors: cells.map((cell) => cell.error ?? null) };
  });
  assert.deepEqual(ran, { running: false, error: '', cellErrors: [null] });
}

/**
 * The viewer's live state, with its sim clock now and once it has moved on, or
 * after `waitMs` if it does not.
 */
function viewerState(waitMs) {
  return page.evaluate(async (waitMs) => {
    const demo = window.__humanoidViewerDemo;
    const before = demo.data.time;
    const deadline = performance.now() + waitMs;
    while (demo.data.time === before && performance.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    return {
      policy: window.__humanoidViewerDemoComponent.currentPolicy,
      loopRunning: !!demo._loopPromise,
      alive: demo.alive,
      paused: demo.params.paused,
      timeBefore: before,
      timeAfter: demo.data.time,
      scene: demo.currentScenePath,
      defaultScene: demo.defaultScenePath,
      terrain: !!demo.terrain,
    };
  }, waitMs);
}

test('a Run of a terrain test leaves a library policy running live on the default scene', { skip, timeout: TIMEOUT_MS }, async () => {
  const live = await viewerState(5000);
  assert.ok(live.loopRunning && live.timeAfter > live.timeBefore, `not live before the Run: ${JSON.stringify(live)}`);

  await runInViewer('terrain/stairs_short');

  const state = await viewerState(5000);
  const where = JSON.stringify(state);
  assert.equal(state.policy, POLICY, where);
  assert.ok(state.loopRunning, `the real-time loop is not running: ${where}`);
  assert.equal(state.alive, true, where);
  assert.equal(state.paused, false, where);
  assert.ok(state.timeAfter > state.timeBefore, `the sim clock did not advance: ${where}`);
  assert.equal(state.scene, state.defaultScene, `the test's course is still loaded: ${where}`);
  assert.equal(state.terrain, false, where);
});

test('a Run leaves a paused viewer paused', { skip, timeout: TIMEOUT_MS }, async () => {
  await page.evaluate(() => { window.__humanoidViewerDemo.params.paused = true; });

  await runInViewer('flat/stand_short');

  const state = await viewerState(3000);
  const where = JSON.stringify(state);
  assert.equal(state.paused, true, `the Run unpaused the viewer: ${where}`);
  assert.ok(state.loopRunning, `the real-time loop is not running: ${where}`);
  assert.equal(state.alive, true, where);
  assert.equal(state.timeAfter, state.timeBefore, `the sim clock advanced while paused: ${where}`);
  assert.equal(state.scene, state.defaultScene, where);
});
