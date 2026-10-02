// What this checkout of the viewer can run as a benchmark, and which version of
// the scoring it implements. A benchmark suite (suite.yaml in a Hugging Face
// dataset) names the protocol it was validated against; the runner refuses to
// produce shareable results for a different one.
//
// Bump BENCHMARK_PROTOCOL in the same commit as any change that can move a
// benchmark number: metric or fall-criterion code, the scene or the asimov-1
// pin, how env.yaml gains/limits/delays are applied, the tick loop, or what a
// randomisation key does. Docs, UI and refactors that leave every number
// unchanged do not bump it. `npm run benchmark:golden` catches an accidental
// change: it compares a smoke run with test/fixtures/smoke-suite/golden.json.

export const BENCHMARK_PROTOCOL = 1;

// Shape of one test row in a benchmark dataset (see testRow.js).
export const TEST_SCHEMA_VERSION = 1;

// Test kinds the runner knows how to play.
export const TEST_KINDS = ['velocity-sequence'];

// How a policy is driven: velocity-command = the 78-in / 23-out Asimov
// locomotion interface checked by src/simulation/policyIO.js.
export const POLICY_INTERFACES = ['velocity-command'];

export const ROBOTS = ['asimov-1'];

// Randomisation a suite may switch on for its repeats; each value lists what
// the key accepts. Applied by MuJoCoDemo.setBenchmarkRandomization().
export const RANDOMIZERS = {
  action_delay: ['midpoint', 'env_range'],
  initial_joint_noise_rad: 'non-negative number',
};
