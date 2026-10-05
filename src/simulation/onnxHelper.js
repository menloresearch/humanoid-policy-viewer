// CPU-only build: its runtime .wasm is 14 MB, while the default (WebGPU/JSEP)
// build's is 27.8 MB, over Cloudflare Pages' 25 MiB per-file limit.
import * as ort from 'onnxruntime-web/wasm';
import { recurrentStatePlan } from './policyState.js';

export class ONNXModule {
  constructor(config) {
    this.modelPath = config.path;
    this.metaData = config.meta;
    // No state until a session is loaded (see useSession).
    this.statePlan = { states: [], resetFlag: null, errors: [] };
    this.isRecurrent = false;
  }

  async init() {
    // Load the ONNX model
    const modelResponse = await fetch(this.modelPath);
    const modelArrayBuffer = await modelResponse.arrayBuffer();

    // Create session from the array buffer
    const session = await ort.InferenceSession.create(modelArrayBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    this.useSession(session);

    console.log('ONNX model loaded successfully');
    console.log("inKeys", this.inKeys);
    console.log("outKeys", this.outKeys);

    console.log("inputNames", this.session.inputNames);
    console.log("outputNames", this.session.outputNames);
    console.log("isRecurrent", this.isRecurrent, this.statePlan.states.map(({ input, output, shape }) => `${output} -> ${input} [${shape}]`));
  }

  // Maps the session's inputs: the observation is the first one (in_keys[0]);
  // the recurrent state and reset flag are found from the graph itself
  // (policyState.js). `statePlan.errors` lists inputs the viewer cannot feed.
  useSession(session) {
    this.session = session;
    this.inKeys = this.metaData["in_keys"];
    this.outKeys = this.metaData["out_keys"];
    const describe = (names, metadata) => names.map((name) => metadata?.find((m) => m.name === name) ?? { name });
    this.statePlan = recurrentStatePlan({
      inputs: describe(session.inputNames, session.inputMetadata),
      outputs: describe(session.outputNames, session.outputMetadata),
    });
    this.isRecurrent = this.statePlan.states.length > 0;
  }

  // Inputs for the first step after a reset: zero state, is_init true.
  initInput() {
    const input = {};
    for (const { input: name, shape } of this.statePlan.states) {
      input[name] = new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b, 1)), shape);
    }
    if (this.statePlan.resetFlag) {
      input[this.statePlan.resetFlag] = new ort.Tensor('bool', [true], [1]);
    }
    return input;
  }

  // `input` holds the observation under in_keys[0] and the state from
  // initInput() or the previous step's carry, keyed by ONNX input name.
  async runInference(input) {
    const onnxInput = { [this.session.inputNames[0]]: input[this.inKeys[0]] };
    for (const { input: name } of this.statePlan.states) {
      onnxInput[name] = input[name];
    }
    if (this.statePlan.resetFlag) {
      onnxInput[this.statePlan.resetFlag] = input[this.statePlan.resetFlag];
    }
    // run inference
    const onnxOutput = await this.session.run(onnxInput);
    // construct output
    let result = {};
    for (let i = 0; i < this.outKeys.length; i++) {
      result[this.outKeys[i]] = onnxOutput[this.session.outputNames[i]];
    }
    const carry = {};
    for (const { input: name, output } of this.statePlan.states) {
      carry[name] = onnxOutput[output];
    }
    if (this.statePlan.resetFlag) {
      carry[this.statePlan.resetFlag] = new ort.Tensor('bool', [false], [1]);
    }
    return [result, carry];
  }
}
