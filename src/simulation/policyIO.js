// Checks a policy's ONNX input and output sizes against what the viewer feeds
// it and expects back. A policy trained with a different observation recipe or
// joint set then fails with a clear message, instead of an ONNX shape error or,
// when the sizes happen to match, a policy silently running on wrong inputs.

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
 * not checked.
 */
export function policyIOErrors({ inputMetadata, outputMetadata, inputName, outputName, numObs, numActions }) {
  const errors = [];
  const inputSize = lastDim(inputMetadata?.find((m) => m.name === inputName));
  if (inputSize !== null && inputSize !== numObs) {
    errors.push(`it takes ${inputSize} observation values, but the viewer's observation recipe builds ${numObs}`);
  }
  const outputSize = lastDim(outputMetadata?.find((m) => m.name === outputName));
  if (outputSize !== null && outputSize !== numActions) {
    errors.push(`it outputs ${outputSize} actions, but the viewer drives ${numActions} joints`);
  }
  return errors;
}

export function policyIOErrorMessage(errors) {
  return `This policy does not match the viewer: ${errors.join('; ')}. See ${SUPPORTED_POLICIES_DOC}.`;
}
