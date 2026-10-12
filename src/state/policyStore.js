// Client for the /api/policies dev endpoint (served by humanoidDevPlugin in
// vite.config.mjs): ONNX policies discovered in the policy library
// (see docs/policy-library.md), used to build the policy catalog.
//
// In static mode (vite build --mode static, VITE_VIEWER_MODE=static), the
// endpoint is unavailable; instead, /static-data/policies.json is fetched.

import { STATIC } from './viewerMode.js';

const POLICIES_API = STATIC ? '/static-data/policies.json' : '/api/policies';

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function listPolicies() {
  const response = await fetch(POLICIES_API);
  if (!response.ok) throw new Error(await parseError(response));
  const body = await response.json();
  return Array.isArray(body.policies) ? body.policies : [];
}
