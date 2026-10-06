// Checks a policy's ONNX input and output sizes against what the viewer feeds
// it and expects back. The output must match the robot's motor count. The input
// must match the observation recipe built for this checkpoint, which comes from
// its env.yaml when that records one (so extra terms such as a gait clock, or a
// stacked history, are fine), and from the reference config otherwise. A policy
// that does not fit fails with a clear message, instead of an ONNX shape error
// or, when the sizes happen to match, a policy silently running on wrong inputs.

const SUPPORTED_POLICIES_DOC = 'docs/huggingface.md#supported-policies';

// Last dimension of a tensor's declared shape, or null when the model leaves it
// symbolic or the runtime does not report metadata.
function lastDim(metadata) {
  if (!metadata?.isTensor) return null;
  const dim = metadata.shape?.at(-1);
  return typeof dim === 'number' && dim > 0 ? dim : null;
}

/**
 * Returns a list of problems (empty when the policy fits). `inputMetadata` and
 * `outputMetadata` are an ONNX Runtime session's; sizes it cannot report are
 * not checked. `recipeError` is set when the checkpoint's env.yaml records
 * observations the viewer cannot compute; the input size is not compared then,
 * since the recipe it would be compared with is not the policy's.
 * `controlErrors` lists where env.yaml drove the robot differently than the
 * viewer does (policy rate, action order); see envPolicyConfig.js.
 */
export function policyIOErrors({ inputMetadata, outputMetadata, inputName, outputName, numObs, numActions, recipeError, controlErrors = [] }) {
  const errors = [...controlErrors];
  const outputSize = lastDim(outputMetadata?.find((m) => m.name === outputName));
  if (outputSize !== null && outputSize !== numActions) {
    errors.push(`it outputs ${outputSize} actions, but the robot has ${numActions} motors`);
  }
  if (recipeError) {
    errors.push(recipeError);
    return errors;
  }
  const inputSize = lastDim(inputMetadata?.find((m) => m.name === inputName));
  if (inputSize !== null && inputSize !== numObs) {
    let error = `it takes ${inputSize} observation values, but the viewer's observation recipe for it builds ${numObs}`;
    if (inputSize > numObs && inputSize % numObs === 0) {
      error += ` (${inputSize} is ${inputSize / numObs} steps of ${numObs}: a stacked history that env.yaml does not record as history_length?)`;
    }
    errors.push(error);
  }
  return errors;
}

export function policyIOErrorMessage(errors) {
  return `This policy does not match the viewer: ${errors.join('; ')}. See ${SUPPORTED_POLICIES_DOC}.`;
}
