// Recurrent state a policy carries from one step to the next, read off its ONNX
// graph rather than declared in a config. The first input is the observation.
// Every other float input is recurrent state, fed on the next step from the
// output whose name pairs with it:
//
//   <name>_in  -> <name>_out                rsl_rl / Isaac Lab LSTM and GRU exports (h_in, c_in)
//   <name>     -> next_<name>, next,<name>  the adapt_hx carry of GentleHumanoid-style exports
//
// State starts at zero after a reset, shaped as the ONNX declares it (a size the
// input leaves symbolic is taken from its paired output). A bool input named
// is_init is true on the first step after a reset and false after it. Any other
// input is something the viewer cannot feed, and is reported, so a policy that
// needs one (e.g. a CNN's image or height-map input) is refused when it loads.

export const RESET_FLAG = 'is_init';

function shapeText(shape) {
  return shape?.length ? `[${shape.join(', ')}]` : '(no shape)';
}

function pairedOutputNames(inputName) {
  const names = [`next_${inputName}`, `next,${inputName}`];
  return inputName.endsWith('_in') ? [`${inputName.slice(0, -'_in'.length)}_out`, ...names] : names;
}

// The input's shape with symbolic sizes filled in from the output's, or null
// when a size stays unknown.
function stateShape(input, output) {
  const shape = input.shape ?? [];
  if (shape.length === 0) return null;
  const resolved = shape.map((dim, i) => (typeof dim === 'number' ? dim : output.shape?.[i]));
  return resolved.every((dim) => typeof dim === 'number' && dim > 0) ? resolved : null;
}

/**
 * Plans how to feed a policy's ONNX inputs. `inputs` and `outputs` are
 * `{ name, isTensor, type, shape }` in the session's order (ONNX Runtime's
 * input/output metadata; only `name` is needed for an observation-only policy).
 * Returns `{ states: [{ input, output, shape }], resetFlag, errors }`: the state
 * inputs and the outputs that feed them, the name of the is_init input (or
 * null), and a list of problems (empty when every input can be fed).
 */
export function recurrentStatePlan({ inputs, outputs }) {
  const states = [];
  const errors = [];
  let resetFlag = null;
  const outputNames = outputs.map((output) => output.name);

  for (const input of inputs.slice(1)) {
    if (input.type === 'bool') {
      if (input.name === RESET_FLAG) resetFlag = input.name;
      else errors.push(`it takes a bool input ${input.name}, but the only flag the viewer sets is ${RESET_FLAG} (true on the first step after a reset)`);
      continue;
    }
    const candidates = pairedOutputNames(input.name);
    const outputName = candidates.find((name) => outputNames.includes(name));
    if (!outputName) {
      errors.push(`it takes an input ${input.name} ${shapeText(input.shape)} besides the observation, which the viewer cannot feed (it is not recurrent state: no output is named ${candidates.join(' or ')})`);
      continue;
    }
    const output = outputs.find((candidate) => candidate.name === outputName);
    if (input.type && input.type !== 'float32') {
      errors.push(`its recurrent state ${input.name} is ${input.type}, but the viewer carries float32 state only`);
      continue;
    }
    const shape = stateShape(input, output);
    if (!shape) {
      errors.push(`its recurrent state ${input.name} ${shapeText(input.shape)} has no fixed size (nor does ${outputName} ${shapeText(output.shape)}), so the viewer cannot start it at zero`);
      continue;
    }
    const outputShape = output.shape ?? [];
    if (outputShape.length && (outputShape.length !== shape.length || outputShape.some((dim, i) => typeof dim === 'number' && dim !== shape[i]))) {
      errors.push(`its recurrent state ${input.name} is ${shapeText(shape)}, but ${outputName}, which feeds it, is ${shapeText(outputShape)}`);
      continue;
    }
    states.push({ input: input.name, output: outputName, shape });
  }
  return { states, resetFlag, errors };
}
