import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { ONNXModule } from './onnxHelper.js';
import { recurrentStatePlan } from './policyState.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const tensor = (name, shape, type = 'float32') => ({ name, isTensor: true, type, shape });
const obs = tensor('obs', [1, 78]);
const actions = tensor('actions', [1, 23]);

test('an observation-only policy has no state', () => {
  assert.deepEqual(recurrentStatePlan({ inputs: [obs], outputs: [actions] }), { states: [], resetFlag: null, errors: [] });
  // Without metadata, as long as there is nothing besides the observation.
  assert.deepEqual(recurrentStatePlan({ inputs: [{ name: 'obs' }], outputs: [{ name: 'actions' }] }).errors, []);
});

test('an rsl_rl LSTM export carries h and c from h_out and c_out', () => {
  const plan = recurrentStatePlan({
    inputs: [obs, tensor('h_in', [1, 1, 256]), tensor('c_in', [1, 1, 256])],
    outputs: [actions, tensor('h_out', [1, 1, 256]), tensor('c_out', [1, 1, 256])],
  });
  assert.deepEqual(plan, {
    states: [
      { input: 'h_in', output: 'h_out', shape: [1, 1, 256] },
      { input: 'c_in', output: 'c_out', shape: [1, 1, 256] },
    ],
    resetFlag: null,
    errors: [],
  });
});

test('an rsl_rl GRU export with several layers carries h', () => {
  const plan = recurrentStatePlan({
    inputs: [obs, tensor('h_in', [2, 1, 64])],
    outputs: [actions, tensor('h_out', [2, 1, 64])],
  });
  assert.deepEqual(plan.states, [{ input: 'h_in', output: 'h_out', shape: [2, 1, 64] }]);
  assert.deepEqual(plan.errors, []);
});

test('an adapt_hx carry with is_init is sized from its output when the input leaves it symbolic', () => {
  const plan = recurrentStatePlan({
    inputs: [obs, tensor('is_init', [1], 'bool'), tensor('adapt_hx', [1, 'carry'])],
    outputs: [actions, tensor('next_adapt_hx', [1, 512])],
  });
  assert.deepEqual(plan, { states: [{ input: 'adapt_hx', output: 'next_adapt_hx', shape: [1, 512] }], resetFlag: 'is_init', errors: [] });
  const gentle = recurrentStatePlan({
    inputs: [obs, tensor('is_init', [1], 'bool'), tensor('adapt_hx', [1, 128])],
    outputs: [actions, tensor('next,adapt_hx', [1, 128])],
  });
  assert.deepEqual(gentle.states, [{ input: 'adapt_hx', output: 'next,adapt_hx', shape: [1, 128] }]);
});

test('an input that is neither state nor is_init is reported, e.g. a CNN height map', () => {
  const plan = recurrentStatePlan({ inputs: [obs, tensor('height_scan', [1, 1, 32, 32])], outputs: [actions] });
  assert.deepEqual(plan.states, []);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /takes an input height_scan \[1, 1, 32, 32\] besides the observation, which the viewer cannot feed \(it is not recurrent state: no output is named next_height_scan or next,height_scan\)/);
  const stray = recurrentStatePlan({ inputs: [obs, tensor('h_in', [1, 1, 8])], outputs: [actions, tensor('h_next', [1, 1, 8])] });
  assert.match(stray.errors[0], /no output is named h_out or next_h_in or next,h_in/);
});

test('a bool input other than is_init is reported', () => {
  const plan = recurrentStatePlan({ inputs: [obs, tensor('done', [1], 'bool')], outputs: [actions] });
  assert.match(plan.errors[0], /bool input done.*only flag the viewer sets is is_init/);
});

test('state without a fixed size, of another type, or fed from a differently shaped output is reported', () => {
  const unsized = recurrentStatePlan({ inputs: [obs, tensor('h_in', [1, 1, 'h'])], outputs: [actions, tensor('h_out', [1, 1, 'h'])] });
  assert.match(unsized.errors[0], /recurrent state h_in \[1, 1, h\] has no fixed size \(nor does h_out \[1, 1, h\]\)/);
  const typed = recurrentStatePlan({ inputs: [obs, tensor('h_in', [1, 1, 8], 'float16')], outputs: [actions, tensor('h_out', [1, 1, 8], 'float16')] });
  assert.match(typed.errors[0], /h_in is float16, but the viewer carries float32 state only/);
  const mismatched = recurrentStatePlan({ inputs: [obs, tensor('adapt_hx', [1, 128])], outputs: [actions, tensor('next_adapt_hx', [1, 512])] });
  assert.match(mismatched.errors[0], /adapt_hx is \[1, 128\], but next_adapt_hx, which feeds it, is \[1, 512\]/);
  assert.deepEqual([unsized, typed, mismatched].map((plan) => plan.states), [[], [], []]);
});

// A session whose outputs are the state inputs plus one, so a step shows which
// state it was fed.
function fakeSession(inputs, outputs) {
  const session = {
    inputNames: inputs.map((m) => m.name),
    outputNames: outputs.map((m) => m.name),
    inputMetadata: inputs,
    outputMetadata: outputs,
    feeds: [],
    async run(feeds) {
      session.feeds.push(feeds);
      const result = { actions: new ort.Tensor('float32', new Float32Array(23), [1, 23]) };
      for (const [input, output] of [['h_in', 'h_out'], ['c_in', 'c_out'], ['adapt_hx', 'next_adapt_hx']]) {
        if (feeds[input]) result[output] = new ort.Tensor('float32', feeds[input].data.map((v) => v + 1), feeds[input].dims);
      }
      return result;
    },
  };
  return session;
}

const observation = () => new ort.Tensor('float32', new Float32Array(78), [1, 78]);

test('ONNXModule starts the state at zero, feeds each step the previous step\'s state, and restarts it on reset', async () => {
  const module = new ONNXModule({ path: 'unused.onnx', meta: { in_keys: ['policy'], out_keys: ['action'] } });
  const session = fakeSession(
    [obs, tensor('h_in', [1, 1, 4]), tensor('c_in', [1, 1, 4])],
    [actions, tensor('h_out', [1, 1, 4]), tensor('c_out', [1, 1, 4])],
  );
  module.useSession(session);
  assert.equal(module.isRecurrent, true);
  assert.deepEqual(module.statePlan.errors, []);

  let input = module.initInput();
  assert.deepEqual(input.h_in.dims, [1, 1, 4]);
  for (let step = 0; step < 3; step++) {
    const [result, carry] = await module.runInference({ ...input, policy: observation() });
    assert.equal(result.action.dims[1], 23);
    input = { ...input, ...carry };
  }
  assert.deepEqual(session.feeds.map((feeds) => Object.keys(feeds).sort()), Array(3).fill(['c_in', 'h_in', 'obs']));
  assert.deepEqual(session.feeds.map((feeds) => feeds.h_in.data[0]), [0, 1, 2]);
  assert.deepEqual(input.h_in.data[0], 3);

  input = module.initInput();
  await module.runInference({ ...input, policy: observation() });
  assert.equal(session.feeds.at(-1).h_in.data[0], 0);
});

test('ONNXModule sets is_init only on the first step after a reset', async () => {
  const module = new ONNXModule({ path: 'unused.onnx', meta: { in_keys: ['policy', 'is_init', 'adapt_hx'], out_keys: ['action', 'next,adapt_hx'] } });
  const session = fakeSession(
    [obs, tensor('is_init', [1], 'bool'), tensor('adapt_hx', [1, 'carry'])],
    [actions, tensor('next_adapt_hx', [1, 512])],
  );
  module.useSession(session);
  let input = module.initInput();
  assert.deepEqual(input.adapt_hx.dims, [1, 512]);
  for (let step = 0; step < 2; step++) {
    const [, carry] = await module.runInference({ ...input, policy: observation() });
    input = { ...input, ...carry };
  }
  assert.deepEqual(session.feeds.map((feeds) => Boolean(feeds.is_init.data[0])), [true, false]);
  assert.deepEqual(session.feeds.map((feeds) => feeds.adapt_hx.data[0]), [0, 1]);
});

test('ONNXModule reports an input it cannot feed instead of running without it', () => {
  const module = new ONNXModule({ path: 'unused.onnx', meta: { in_keys: ['policy'], out_keys: ['action'] } });
  module.useSession(fakeSession([obs, tensor('height_scan', [1, 1, 32, 32])], [actions]));
  assert.equal(module.isRecurrent, false);
  assert.equal(module.statePlan.errors.length, 1);
});

test('the bundled observation-only policies carry no state', async () => {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = resolve(appDir, 'node_modules/onnxruntime-web/dist') + '/';
  for (const onnx of ['examples/checkpoints/asimov/model_aug_18_1/policy_isaaclab_new.onnx', 'examples/checkpoints/g1/policy_latest.onnx']) {
    const module = new ONNXModule({ path: onnx, meta: { in_keys: ['policy'], out_keys: ['action'] } });
    module.useSession(await ort.InferenceSession.create(readFileSync(resolve(appDir, 'public', onnx))));
    assert.deepEqual(module.statePlan, { states: [], resetFlag: null, errors: [] }, onnx);
  }
});
