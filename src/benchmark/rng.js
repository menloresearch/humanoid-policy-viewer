// Seeded randomness for benchmark repeats. A cell's seed comes only from the
// suite seed, the test id and the repeat index, never from run order, so the
// same cell gives the same numbers on any page, machine or shard.

/** 32-bit FNV-1a hash of the given parts. */
export function hashSeed(...parts) {
  let hash = 0x811c9dc5;
  const text = parts.map(String).join('\u0000');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function cellSeed(suiteSeed, testId, repeat) {
  return hashSeed(suiteSeed, testId, repeat);
}

/** mulberry32: a small, fast generator returning floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
