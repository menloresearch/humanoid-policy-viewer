// Runs benchmark jobs in headless Chromium: one Vite dev server, one browser,
// `concurrency` pages. Each page is its own renderer process (its own core) and
// hosts one MuJoCo demo; a page keeps its loaded policy, so the queue hands it
// jobs for the same policy when it can (see takeNextJob). A job is one test's
// repeats (up to MAX_ROBOTS), run at once as that many robots in the scene.
//
// The first page is loaded alone so Vite compiles the app once; the others then
// load from its cache. Before, every shard started its own dev server, and four
// at once on an 8-core machine missed the page-ready deadline.

import { takeNextJob } from '../src/benchmark/run.js';

const PAGE_READY_TIMEOUT_MS = 180_000;
const LIVENESS_MS = 5_000;
const OPTIONAL_POLICY_FILES = /\/policy-library\/.*\/(tracking_policy\.json|env\.yaml)$/;

// Chromium slows timers in pages it thinks are in the background; a pool page
// is never in front, so turn that off or the sim crawls.
const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// A page takes tens of seconds to load and prints nothing meanwhile; say that it is still going.
async function withLiveness(task, message, log, everyMs = LIVENESS_MS) {
  const started = Date.now();
  const timer = setInterval(() => log(`${message}... ${Math.round((Date.now() - started) / 1000)}s`), everyMs);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

/**
 * @param jobs        [{ policyKey, cells }] in queue order (buildJobs)
 * @param policies    policyKey -> { onnxPath } as the page should load it
 * @param sequences   testId -> sequence object (rowToSequence)
 * @param onResult    called with (job, cell, result) for each cell as its job finishes
 */
export async function runJobs({
  url,
  jobs,
  policies,
  sequences,
  concurrency = 1,
  headless = true,
  realtime = false,
  verbose = false,
  onResult,
  log = console.log,
}) {
  const { chromium } = await import('@playwright/test');
  const queue = jobs.slice();
  const browser = await chromium.launch({ headless, args: CHROMIUM_ARGS });
  const browserVersion = browser.version();
  try {
    let pageCount = 0;
    const openPage = async () => {
      const id = ++pageCount;
      const page = await browser.newPage();
      page.on('console', (msg) => {
        if (!verbose && msg.type() !== 'error') return;
        // Chromium's "Failed to load resource" lines do not say which resource; the location does.
        const failed = msg.text().startsWith('Failed to load resource');
        const url = failed ? msg.location().url : '';
        // The policy loader looks for these in params/ and then at the policy root, so one 404 is expected.
        if (failed && !verbose && OPTIONAL_POLICY_FILES.test(url) && msg.text().includes('404')) return;
        log(`[page ${id} ${msg.type()}] ${msg.text()}${url ? ` (${url})` : ''}`);
      });
      page.on('pageerror', (error) => log(`[page ${id} pageerror] ${error.message}`));
      await page.goto(url, { waitUntil: 'load' });
      // waitForFunction(pageFunction, arg, options): arg is positional and
      // required, or the options are taken as the arg and the default 30 s applies.
      await page.waitForFunction(
        () => window.__humanoidViewerDemoComponent?.state === 1 && typeof window.__runBenchmarkGroup === 'function',
        undefined,
        { timeout: PAGE_READY_TIMEOUT_MS, polling: 250 },
      );
      return page;
    };

    // A policy that cannot be loaded fails all its cells at once, instead of
    // each one waiting for a load that will fail the same way.
    const unloadable = new Map();

    const worker = async (firstPage) => {
      let page = firstPage;
      let lastPolicyKey = null;
      for (let job = takeNextJob(queue, lastPolicyKey); job; job = takeNextJob(queue, lastPolicyKey)) {
        const started = Date.now();
        const { cells } = job;
        const finish = (perCell) => cells.forEach((cell, i) => onResult(job, cell, perCell(i)));
        if (unloadable.has(job.policyKey)) {
          finish(() => ({ error: unloadable.get(job.policyKey), metrics: null, wallMs: 0 }));
          continue;
        }
        // The robots of a group step one after another, so its budget grows with them.
        const timeoutS = Math.max(...cells.map((cell) => cell.timeoutS)) * cells.length;
        let outcome;
        try {
          outcome = await withTimeout(
            page.evaluate(([policy, payload]) => window.__runBenchmarkGroup(policy, payload), [
              policies[job.policyKey],
              {
                sequence: sequences[cells[0].testId],
                cells: cells.map((cell) => ({ seed: cell.seed, randomize: cell.randomize })),
                realtime,
                timeoutMs: timeoutS * 1000,
              },
            ]),
            timeoutS * 1000 + 120_000,
            `no answer from the page within ${timeoutS + 120}s`,
          );
          lastPolicyKey = job.policyKey;
          if (outcome.policyLoadError) {
            unloadable.set(job.policyKey, outcome.error);
            lastPolicyKey = null;
          }
        } catch (error) {
          // Playwright prefixes "page.evaluate: " and appends the browser stack.
          const message = (error?.message || String(error)).split('\n')[0].replace(/^page\.evaluate: (Error: )?/, '');
          outcome = { error: message, metrics: null };
          // The page may be wedged or have lost its policy; start a fresh one.
          await page.close().catch(() => {});
          page = await withLiveness(openPage, 'Reopening a page', log);
          lastPolicyKey = null;
        }
        // A group shares its wall time; each cell is charged its share.
        const wallMs = Math.round((Date.now() - started) / cells.length);
        finish((i) => ({ ...(outcome.results ? outcome.results[i] : outcome), wallMs }));
      }
      await page.close().catch(() => {});
    };

    const workers = Math.max(1, Math.min(concurrency, queue.length));
    const pages = await withLiveness(async () => {
      const first = await openPage();
      const others = await Promise.all(Array.from({ length: workers - 1 }, () => openPage()));
      return [first, ...others];
    }, 'Loading the viewer', log);
    await Promise.all(pages.map((page) => worker(page)));
    return { browserVersion };
  } finally {
    await browser.close();
  }
}
