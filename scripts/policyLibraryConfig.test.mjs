import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPolicyLibrary } from './policyLibraryConfig.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

test('with no variables the library is policies/ next to package.json', () => {
  assert.deepEqual(getPolicyLibrary({}), { baseDir: appDir, roots: ['policies'] });
});

test('the variables override the directory and the roots independently', () => {
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_LIBRARY_DIR: '/data', HPV_POLICY_ROOTS: 'a, b' }), { baseDir: resolve('/data'), roots: ['a', 'b'] });
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_LIBRARY_DIR: '/data' }), { baseDir: resolve('/data'), roots: ['policies'] });
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_ROOTS: 'mine' }), { baseDir: appDir, roots: ['mine'] });
});

test('an empty HPV_POLICY_ROOTS turns the library off', () => {
  assert.deepEqual(getPolicyLibrary({ HPV_POLICY_ROOTS: '' }).roots, []);
});
