#!/usr/bin/env node
/**
 * Verify the DSSE review attestation for the current PR against the committed
 * `.ai-sdlc/trusted-reviewers.yaml` and the current PR state (AISDLC-74).
 *
 * Used by `.github/workflows/verify-attestation.yml`. Extracted from the
 * workflow YAML so it can be unit-tested + run locally.
 *
 * AISDLC-566: this file is now a THIN DRIVER. All verification logic
 * (Merkle primitives, head-binding relaxations, content-hash matching,
 * `runVerifier`, etc.) lives in the shared, monorepo-independent core
 * module, which this file imports via a monorepo-relative path (unchanged
 * behaviour — this script is only ever run inside this checkout) and binds
 * to the compiled `orchestrator/dist/runtime/attestations.js` runtime,
 * exactly as before AISDLC-566.
 *
 * AISDLC-575: the core module moved from
 * `ai-sdlc-plugin/scripts/verify-attestation-core.mjs` to
 * `pipeline-cli/attestation-core/verify-core.mjs` — INSIDE the published
 * `@ai-sdlc/pipeline-cli` package — so a consumer's CI can run the full
 * verifier via `cli-attestation verify` with NO Claude Code plugin
 * installed at all (`pipeline-cli/src/cli/attestation.ts`'s `verify`
 * subcommand imports the SAME file directly, colocated in its own
 * package). The plugin-installed consumer counterpart,
 * `ai-sdlc-plugin/scripts/verify-attestation.mjs`, imports the SAME core
 * module too, resolved from BOTH `@ai-sdlc/orchestrator` (runtime) and
 * `@ai-sdlc/pipeline-cli` (core) via the signer's trusted candidate-walk
 * pattern instead of this static path — three drivers, one implementation.
 *
 * `export *` re-exports every named export of the core module so existing
 * consumers (`scripts/verify-attestation.test.mjs`, other scripts that
 * import individual helpers from this file) keep working unchanged.
 */

import { appendFileSync } from 'node:fs';

import * as core from '../pipeline-cli/attestation-core/verify-core.mjs';
import * as attestationRuntime from '../orchestrator/dist/runtime/attestations.js';

core.bindRuntime(attestationRuntime);

export * from '../pipeline-cli/attestation-core/verify-core.mjs';

const invokedDirectly = process.argv[1]?.endsWith('verify-attestation.mjs');
if (invokedDirectly) {
  const headSha = process.env.PR_HEAD_SHA;
  const baseSha = process.env.PR_BASE_SHA;
  if (!headSha || !baseSha) {
    process.stderr.write('ERROR: PR_HEAD_SHA and PR_BASE_SHA must be set\n');
    process.exit(2);
  }
  const out = core.runVerifier({ headSha, baseSha });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, core.buildGithubOutputLines(out.status, out.reason));
  }
  // AISDLC-568: surface the independence trust class (v6 envelopes only).
  let output = `status=${out.status}\nreason=${out.reason}\n`;
  if (out.overallVerdictClass) {
    output += `verdictClass=${out.overallVerdictClass}\n`;
  }
  process.stdout.write(output);
}
