import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLimits, setActiveCommandLimits, COMMAND_LIMITS } from './commandSequencer.js';

test('resolveLimits falls back to the active checkpoint command range, not the hardcoded default', () => {
  try {
    setActiveCommandLimits({ vx: [-0.6, 0.8], vy: [-0.5, 0.5], wz: [-0.8, 0.8] });
    assert.deepEqual(resolveLimits({}).vx, [-0.6, 0.8]);
    setActiveCommandLimits(null);
    assert.deepEqual(resolveLimits({}).vx, COMMAND_LIMITS.vx);
  } finally {
    setActiveCommandLimits(null);
  }
});
