import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { PolicyRunner } from './policyRunner.js';
import { policyIOErrorMessage, policyIOErrors } from './policyIO.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tensor = (name, shape) => ({ name, isTensor: true, type: 'float32', shape });
const io = (inShape, outShape) => ({
  inputMetadata: [tensor('obs', inShape)],
  outputMetadata: [tensor('actions', outShape)],
  inputName: 'obs',
  outputName: 'actions',
  numObs: 78,
  numActions: 23,
});

test('a policy with the expected sizes passes', () => {
  assert.deepEqual(policyIOErrors(io([1, 78], [1, 23])), []);
});

test('a different observation size is reported', () => {
  const errors = policyIOErrors(io([1, 80], [1, 23]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /takes 80 observation values.*builds 78/);
});

test('a different action size is reported against the motor count', () => {
  const errors = policyIOErrors(io([1, 78], [1, 25]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /outputs 25 actions.*robot has 23 motors/);
});

test('an input that is a whole number of recipe steps hints at an unrecorded history', () => {
  const errors = policyIOErrors({ ...io([1, 375], [1, 23]), numObs: 75 });
  assert.match(errors[0], /takes 375.*builds 75 \(375 is 5 steps of 75/);
});

test('a recipe the viewer cannot reproduce replaces the input size check', () => {
  const errors = policyIOErrors({ ...io([1, 81], [1, 23]), recipeError: 'foot_contact is not something the viewer computes' });
  assert.deepEqual(errors, ['foot_contact is not something the viewer computes']);
  const both = policyIOErrors({ ...io([1, 81], [1, 25]), recipeError: 'x' });
  assert.equal(both.length, 2);
  assert.match(both[0], /outputs 25 actions/);
});

test('symbolic or missing sizes are not checked', () => {
  assert.deepEqual(policyIOErrors(io(['batch', 'obs_dim'], [])), []);
  assert.deepEqual(policyIOErrors({ ...io([1, 80], [1, 25]), inputMetadata: undefined, outputMetadata: undefined }), []);
});

test('the error message points to the supported-policies docs', () => {
  assert.match(policyIOErrorMessage(['x']), /does not match the viewer: x\. See docs\/huggingface\.md#supported-policies/);
});

test('the bundled Asimov policy matches the reference observation recipe', async () => {
  const config = JSON.parse(readFileSync(resolve(appDir, 'public/examples/checkpoints/asimov/reference_policy_config.json'), 'utf8'));
  const runner = new PolicyRunner(config);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = resolve(appDir, 'node_modules/onnxruntime-web/dist') + '/';
  const onnxPath = resolve(appDir, 'public', config.onnx.path.replace(/^\.\//, ''));
  const session = await ort.InferenceSession.create(readFileSync(onnxPath));
  assert.deepEqual(policyIOErrors({
    inputMetadata: session.inputMetadata,
    outputMetadata: session.outputMetadata,
    inputName: session.inputNames[0],
    outputName: session.outputNames[0],
    numObs: runner.numObs,
    numActions: runner.numActions,
  }), []);
});
