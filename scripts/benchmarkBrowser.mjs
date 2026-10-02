// Runs benchmark jobs in headless Chromium: one Vite dev server, one browser,
// `concurrency` pages. Each page is its own renderer process (its own core) and
// hosts one MuJoCo demo; a page keeps its loaded policy, so the queue hands it
// jobs for the same model when it can (see takeNextJob).
//
// The first page is loaded alone so Vite compiles the app once; the others then
// load from its cache. Before, every shard started its own dev server, and four
// at once on an 8-core machine missed the page-ready deadline.

import { takeNextJob } from './benchmarkRun.mjs';

const PAGE_READY_TIMEOUT_MS = 180_000;

// Chromium slows timers in pages it thinks are in the background; a pool page
// is never in front, so turn that off or the sim crawls.
const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export async function startViewerServer({ appDir, libraryDir, libraryRoots }) {
  // vite.config.mjs reads these when it loads, so they must be set first.
  process.env.HPV_MODEL_LIBRARY_DIR = libraryDir;
  process.env.HPV_MODEL_ROOTS = libraryRoots;
  const { createServer } = await import('vite');
  const server = await createServer({
    root: appDir,
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/` };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param jobs        [{ modelKey, cell }] in queue order
 * @param policies    modelKey -> { onnxPath } as the page should load it
 * @param sequences   testId -> sequence object (rowToSequence)
 * @param onResult    called with (job, result) as each job finishes
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
        if (verbose || msg.type() === 'error') log(`[page ${id} ${msg.type()}] ${msg.text()}`);
      });
      page.on('pageerror', (error) => log(`[page ${id} pageerror] ${error.message}`));
      await page.goto(url, { waitUntil: 'load' });
      // waitForFunction(pageFunction, arg, options): arg is positional and
      // required, or the options are taken as the arg and the default 30 s applies.
      await page.waitForFunction(
        () => window.__humanoidViewerDemoComponent?.state === 1 && typeof window.__runBenchmarkCell === 'function',
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
      let lastModelKey = null;
      for (let job = takeNextJob(queue, lastModelKey); job; job = takeNextJob(queue, lastModelKey)) {
        const started = Date.now();
        const { cell } = job;
        let result;
        if (unloadable.has(job.modelKey)) {
          onResult(job, { error: unloadable.get(job.modelKey), metrics: null, wallMs: 0 });
          continue;
        }
        try {
          result = await withTimeout(
            page.evaluate(([policy, payload]) => window.__runBenchmarkCell(policy, payload), [
              policies[job.modelKey],
              {
                sequence: sequences[cell.testId],
                seed: cell.seed,
                randomize: cell.randomize,
                realtime,
                timeoutMs: cell.timeoutS * 1000,
              },
            ]),
            cell.timeoutS * 1000 + 120_000,
            `no answer from the page within ${cell.timeoutS + 120}s`,
          );
          lastModelKey = job.modelKey;
          if (result.policyLoadError) {
            unloadable.set(job.modelKey, result.error);
            lastModelKey = null;
          }
        } catch (error) {
          // Playwright prefixes "page.evaluate: " and appends the browser stack.
          const message = (error?.message || String(error)).split('\n')[0].replace(/^page\.evaluate: (Error: )?/, '');
          result = { error: message, metrics: null };
          // The page may be wedged or have lost its policy; start a fresh one.
          await page.close().catch(() => {});
          page = await openPage();
          lastModelKey = null;
        }
        onResult(job, { ...result, wallMs: Date.now() - started });
      }
      await page.close().catch(() => {});
    };

    const workers = Math.max(1, Math.min(concurrency, queue.length));
    const first = await openPage();
    const others = await Promise.all(Array.from({ length: workers - 1 }, () => openPage()));
    await Promise.all([first, ...others].map((page) => worker(page)));
    return { browserVersion };
  } finally {
    await browser.close();
  }
}
