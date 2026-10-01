import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getModelLibrary } from './modelLibraryConfig.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

test('with no variables the library is models/ next to package.json', () => {
  assert.deepEqual(getModelLibrary({}), { baseDir: appDir, roots: ['models'] });
});

test('the variables override the directory and the roots independently', () => {
  assert.deepEqual(getModelLibrary({ HPV_MODEL_LIBRARY_DIR: '/data', HPV_MODEL_ROOTS: 'a, b' }), { baseDir: resolve('/data'), roots: ['a', 'b'] });
  assert.deepEqual(getModelLibrary({ HPV_MODEL_LIBRARY_DIR: '/data' }), { baseDir: resolve('/data'), roots: ['models'] });
  assert.deepEqual(getModelLibrary({ HPV_MODEL_ROOTS: 'mine' }), { baseDir: appDir, roots: ['mine'] });
});

test('an empty HPV_MODEL_ROOTS turns the library off', () => {
  assert.deepEqual(getModelLibrary({ HPV_MODEL_ROOTS: '' }).roots, []);
});
