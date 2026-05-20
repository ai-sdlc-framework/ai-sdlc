#!/usr/bin/env node
/**
 * Sign a reviewer verdict with the reviewer subagent's per-role private key.
 *
 * Part of AISDLC-380 — reviewer-side signed sub-attestations.
 *
 * This script is invoked by reviewer subagents (code-reviewer, test-reviewer,
 * security-reviewer, and their -codex variants) at the end of their review.
 * It reads the reviewer's private key from `~/.ai-sdlc/reviewer-keys/<name>.pem`,
 * signs the verdict JSON, and writes a sub-attestation envelope to stdout
 * (or to a file when --output is given).
 *
 * The developer subagent cannot read reviewer keys because the agent-role.yaml
 * `blockedActions` list denies Bash commands containing the key path pattern
 * (defense-in-depth against accidental access — see Implementation guidance in
 * AISDLC-380 for the residual-risk note).
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs \
 *     --reviewer-name code-reviewer \
 *     --task-id AISDLC-380 \
 *     --verdict-json '{"approved":true,"findings":[],"summary":"LGTM"}' \
 *     [--output /tmp/sub-attestation.json]
 *
 * Inputs:
 *   --reviewer-name   name of the reviewer subagent (must match agent filename stem)
 *   --task-id         task ID being reviewed (e.g. AISDLC-380)
 *   --verdict-json    JSON string with the reviewer verdict
 *   --output          optional output file path; if absent writes to stdout
 *   --key-path        override the default key path (tests only — requires AI_SDLC_TEST_MODE=1)
 *
 * Output (sub-attestation envelope JSON):
 *   {
 *     "reviewerName":  "code-reviewer",
 *     "taskId":        "AISDLC-380",
 *     "verdict":       { "approved": true, "findings": [], "summary": "..." },
 *     "contentHash":   "<sha256 of canonical verdict JSON>",
 *     "signature":     "<base64-encoded ed25519 sig>",
 *     "signedAt":      "<ISO 8601 timestamp>",
 *     "keyid":         "<reviewer-name>:<machine>"
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, sign } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[a.substring(2)] = true;
      } else {
        out[a.substring(2)] = next;
        i++;
      }
    }
  }
  return out;
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Recursively sort all object keys for canonical JSON serialization.
 * Must produce the same result as `sortKeysDeep` in verify-reviewer-sub-attestations.mjs.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

/**
 * Compute a canonical SHA-256 of the verdict object.
 * Uses deep key-sorting so nested objects are also canonicalized.
 * Must match `canonicalVerdictHash` in verify-reviewer-sub-attestations.mjs.
 */
function canonicalVerdictHash(verdict) {
  return sha256Hex(JSON.stringify(sortKeysDeep(verdict)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const reviewerName = args['reviewer-name'];
  const taskId = args['task-id'];
  const verdictJsonStr = args['verdict-json'];
  const outputPath = args['output'] ?? null;

  if (!reviewerName || typeof reviewerName !== 'string' || reviewerName.trim().length === 0) {
    fail('--reviewer-name <name> required');
  }
  if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
    fail('--task-id <id> required');
  }
  if (!verdictJsonStr || typeof verdictJsonStr !== 'string') {
    fail('--verdict-json <json> required');
  }

  // Parse and validate the verdict JSON.
  let verdict;
  try {
    verdict = JSON.parse(verdictJsonStr);
  } catch {
    fail(`--verdict-json is not valid JSON: ${String(verdictJsonStr).slice(0, 80)}`);
  }
  if (typeof verdict.approved !== 'boolean') {
    fail('verdict JSON must have a boolean "approved" field');
  }
  if (!Array.isArray(verdict.findings)) {
    fail('verdict JSON must have a "findings" array');
  }

  // Resolve the reviewer's private key path.
  // --key-path is for tests only — requires AI_SDLC_TEST_MODE=1 env var.
  // Refusing in production prevents a dev from passing their own key path
  // to sign on behalf of a reviewer without owning the legitimate reviewer key.
  const keyPathOverride = args['key-path'];
  if (keyPathOverride && process.env.AI_SDLC_TEST_MODE !== '1') {
    fail(
      '--key-path is only permitted in test mode (AI_SDLC_TEST_MODE=1).\n' +
        '       In production, the key is always read from\n' +
        `       ~/.ai-sdlc/reviewer-keys/<reviewer-name>.pem`,
    );
  }
  const keyPath =
    keyPathOverride ?? join(homedir(), '.ai-sdlc', 'reviewer-keys', `${reviewerName}.pem`);

  if (!existsSync(keyPath)) {
    fail(
      `No signing key for reviewer '${reviewerName}' at ${keyPath}.\n` +
        `       Run: node ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs --reviewer-name ${reviewerName}\n` +
        `       Then add the generated public key to .ai-sdlc/trusted-reviewers.yaml\n` +
        `       under a new entry with type: 'reviewer' and reviewer: '${reviewerName}'.`,
    );
  }

  const privateKeyPem = readFileSync(keyPath, 'utf-8');

  // Compute the content hash over the canonical verdict.
  const contentHash = canonicalVerdictHash(verdict);

  // Build the payload we sign: canonical JSON of { reviewerName, taskId, verdict, contentHash }.
  // Including taskId + contentHash in the signed payload binds the signature to
  // BOTH the specific review task AND the exact verdict content — forging a
  // sub-attestation for a different task or with a different verdict would
  // require a different signature.
  const signedPayload = JSON.stringify({
    reviewerName: reviewerName.trim(),
    taskId: taskId.trim().toUpperCase(),
    contentHash,
  });

  let signature;
  try {
    const sigBytes = sign(null, Buffer.from(signedPayload, 'utf-8'), privateKeyPem);
    signature = sigBytes.toString('base64');
  } catch (err) {
    fail(`signing failed: ${err.message ?? String(err)}`);
  }

  const machine = hostname();
  const keyid = `reviewer:${reviewerName.trim()}:${machine}`;

  const subAttestation = {
    reviewerName: reviewerName.trim(),
    taskId: taskId.trim().toUpperCase(),
    verdict,
    contentHash,
    signature,
    signedAt: new Date().toISOString(),
    keyid,
  };

  const output = JSON.stringify(subAttestation, null, 2) + '\n';

  if (outputPath) {
    const dir = dirname(outputPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, output);
    process.stderr.write(`[sign-reviewer-verdict] wrote sub-attestation to ${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }
}

main().catch((err) => fail(err.message ?? String(err)));
