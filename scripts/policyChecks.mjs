// Sanity checks for a downloaded policy before it is run or benchmarked: a
// policy must ship an env.yaml the viewer can read (with explicit gains and torque limits)
// and an agent.yaml. Without them the viewer silently falls back to the bundled
// reference gains and unclamped torque, so every policy would be benchmarked
// with the same gains.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyFileCandidates, parseEnvPolicySettings } from '../src/simulation/envPolicyConfig.js';

export const EXPECTED_LIBRARY_NAME = 'asimov';

// agent.yaml is never read by the viewer, so only confirm it is a real YAML file.
export function basicYamlSanityCheck(text) {
  if (!text.trim()) return 'file is empty';
  if (text.includes('\t')) return 'contains a literal tab character (invalid YAML indentation)';
  const hasTopLevelKey = text.split(/\r?\n/).some((line) => /^[^\s#][^:]*:/.test(line));
  if (!hasTopLevelKey) return 'has no top-level "key:" entries';
  return null;
}

// envYaml / agentYaml are the file contents, or null when the file is absent.
// The run must not start (an error) when env.yaml is missing (the policy's
// gains, action scale and torque limits would be guessed) or when the viewer
// would refuse the policy at load (env.yaml cannot be read, or records
// observations or control the viewer cannot reproduce); otherwise every cell
// would fail. Everything else is a warning.
export function policyProblems({ envYaml, agentYaml, jointNames }) {
  const errors = [];
  const warnings = [];

  if (envYaml === null) {
    errors.push('missing env.yaml (checked params/env.yaml and env.yaml), which supplies the policy\'s gains, action scale and torque limits');
  } else {
    try {
      const settings = parseEnvPolicySettings(envYaml, jointNames);
      if (!settings.torque_limit) {
        warnings.push('env.yaml declares no numeric effort_limit for the actuators, so torque would be unclamped');
      }
      if (settings.obs_config_error) {
        errors.push(`${settings.obs_config_error}, so the viewer will refuse the policy`);
      }
      if (settings.control_errors) {
        errors.push(`env.yaml drove the robot differently than the viewer does: ${settings.control_errors.join('; ')}, so the viewer will refuse the policy`);
      }
    } catch (error) {
      errors.push(`env.yaml is incomplete: ${error.message}, so the viewer will refuse the policy`);
    }
  }

  if (agentYaml === null) {
    warnings.push('missing agent.yaml (checked params/agent.yaml and agent.yaml)');
  } else {
    const issue = basicYamlSanityCheck(agentYaml);
    if (issue) warnings.push(`agent.yaml ${issue}`);
  }

  return { errors, warnings };
}

export function readPolicyFile(dir, name) {
  for (const candidate of policyFileCandidates(name)) {
    const path = join(dir, candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

export function checkPolicyDir(dir, jointNames) {
  return policyProblems({
    envYaml: readPolicyFile(dir, 'env.yaml'),
    agentYaml: readPolicyFile(dir, 'agent.yaml'),
    jointNames,
  });
}

// Returns a warning when the repo's model-card metadata does not say it is an Asimov policy.
export function libraryNameWarning(libraryName) {
  if (String(libraryName ?? '').toLowerCase() === EXPECTED_LIBRARY_NAME) return null;
  const found = libraryName ? `library_name: ${libraryName}` : 'no library_name';
  return `the model card is not tagged "library_name: ${EXPECTED_LIBRARY_NAME}" (found ${found}), so this may not be an Asimov policy`;
}

export function readReferenceJointNames(appDir) {
  const path = join(appDir, 'public/examples/checkpoints/asimov/reference_policy_config.json');
  return JSON.parse(readFileSync(path, 'utf8')).policy_joint_names;
}
