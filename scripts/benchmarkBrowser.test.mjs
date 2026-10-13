import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJobs } from './benchmarkBrowser.mjs';

const job = (id) => ({ policyKey: 'p', cells: [{ cellId: id, testId: id, seed: 1, randomize: false, timeoutS: 5 }] });

// A browser whose pages answer with `evaluate(pageNumber)`; opening page number n fails if `failOpen(n)`.
function fakeBrowser({ evaluate, failOpen = () => false }) {
  let opened = 0;
  return {
    launch: async () => ({
      version: () => 'fake',
      close: async () => {},
      newPage: async () => {
        const n = ++opened;
        if (failOpen(n)) throw new Error(`cannot open page ${n}`);
        return {
          addInitScript: async () => {},
          on: () => {},
          goto: async () => {},
          waitForFunction: async () => {},
          evaluate: async () => evaluate(n),
          close: async () => {},
        };
      },
    }),
  };
}

async function run(browser, jobs, concurrency) {
  const seen = [];
  await runJobs({
    url: 'http://fake',
    jobs,
    policies: { p: { onnxPath: '/p.onnx' } },
    sequences: Object.fromEntries(jobs.map((j) => [j.cells[0].testId, {}])),
    concurrency,
    chromium: browser,
    log: () => {},
    onResult: (j, cell, result) => seen.push({ cell: cell.cellId, error: result.error ?? null }),
  });
  return seen.sort((a, b) => a.cell.localeCompare(b.cell));
}

test('a page that dies and cannot be reopened hands its jobs to the other pages', async () => {
  // Page 1 fails every job; reopening (the third page) fails too. Page 2 runs the rest.
  const browser = fakeBrowser({
    evaluate: (page) => {
      if (page === 1) throw new Error('page.evaluate: Error: Target crashed\n    at stack');
      return { results: [{ metrics: {} }] };
    },
    failOpen: (page) => page === 3,
  });
  const seen = await run(browser, [job('a'), job('b'), job('c')], 2);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.filter((s) => s.error).map((s) => s.error), ['Target crashed']);
});

test('when every page is lost the remaining cells are reported as errors, not dropped', async () => {
  const browser = fakeBrowser({
    evaluate: () => { throw new Error('page.evaluate: Error: Target crashed'); },
    failOpen: (page) => page > 1,
  });
  const seen = await run(browser, [job('a'), job('b')], 1);
  assert.deepEqual(seen, [
    { cell: 'a', error: 'Target crashed' },
    { cell: 'b', error: 'could not reopen a page: cannot open page 2' },
  ]);
});
