#!/usr/bin/env node
/**
 * Verify reviewer sub-attestation signatures in an aggregate verdict file.
 *
 * Part of AISDLC-380 — reviewer-side signed sub-attestations.
 *
 * Called by `check-attestation-sign.sh` BEFORE invoking `sign-attestation.mjs`.
 * If any sub-attestation fails signature verification, or if the verdict file
 * uses the legacy plain-JSON shape without AI_SDLC_LEGACY_VERDICTS=1, this
 * script exits non-zero and the hook refuses to sign.
 *
 * Usage:
 *   node scripts/verify-reviewer-sub-attestations.mjs \
 *     --verdict-file .ai-sdlc/verdicts/aisdlc-380.json \
 *     --task-id AISDLC-380 \
 *     --trusted-reviewers .ai-sdlc/trusted-reviewers.yaml
 *
 * Exit codes:
 *   0 — all sub-attestations verified OK (or legacy mode accepted)
 *   1 — verification failed (with human-readable stderr)
 *   2 — internal error (file not found, invalid JSON, etc.)
 *
 * Environment variables:
 *   AI_SDLC_LEGACY_VERDICTS=1  — accept plain-JSON verdicts with a warning
 *                                 (backward compat escape hatch for teams
 *                                  that haven't yet onboarded reviewer keys)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash, verify } from 'node:crypto';
import { join } from 'node:path';

function fail(msg, code = 2) {
  process.stderr.write(`[verify-sub-attestations] ERROR: ${msg}\n`);
  process.exit(code);
}

function warn(msg) {
  process.stderr.write(`[verify-sub-attestations] WARN: ${msg}\n`);
}

function info(msg) {
  process.stderr.write(`[verify-sub-attestations] ${msg}\n`);
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
 * Must produce the same result as `sortKeysDeep` in sign-reviewer-verdict.mjs.
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
 * Compute canonical content hash of a verdict object.
 * Must match `canonicalVerdictHash` in sign-reviewer-verdict.mjs.
 * Uses deep key-sorting so nested objects are also canonicalized.
 */
function canonicalVerdictHash(verdict) {
  return sha256Hex(JSON.stringify(sortKeysDeep(verdict)));
}

/**
 * Tiny YAML loader for `.ai-sdlc/trusted-reviewers.yaml`.
 * Parses entries with an optional `type: 'reviewer'` field and
 * `reviewer:` field (new fields added by AISDLC-380).
 *
 * Returns an array of reviewer registry entries.
 */
function parseTrustedReviewers(text) {
  const reviewers = [];
  let cur = null;
  let pemAccum = null;

  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('#')) continue;
    if (rawLine.trim() === '') continue;
    if (rawLine.startsWith('reviewers:')) continue;

    // New entry — `  - identity: '…'` OR `  - type: 'reviewer'`
    const itemMatch = rawLine.match(/^ {2}- (\w+):\s*'?([^']*)'?\s*$/);
    if (itemMatch) {
      if (cur) {
        if (pemAccum !== null) cur.pubkey = pemAccum.replace(/\s+$/, '') + '\n';
        reviewers.push(cur);
      }
      cur = {};
      pemAccum = null;
      cur[itemMatch[1]] = itemMatch[2];
      continue;
    }

    // `    pubkey: |` opens a PEM block scalar
    if (/^ {4}pubkey:\s*\|\s*$/.test(rawLine)) {
      pemAccum = '';
      continue;
    }

    // PEM continuation lines (indented 6+ spaces)
    if (pemAccum !== null && rawLine.startsWith('      ')) {
      pemAccum += rawLine.substring(6) + '\n';
      continue;
    }

    // Other scalar fields on an existing entry: `    machine: 'laptop'`
    const kvMatch = rawLine.match(/^ {4}(\w+):\s*'?([^']*)'?\s*$/);
    if (kvMatch && cur) {
      cur[kvMatch[1]] = kvMatch[2];
      continue;
    }
  }

  if (cur) {
    if (pemAccum !== null) cur.pubkey = pemAccum.replace(/\s+$/, '') + '\n';
    reviewers.push(cur);
  }

  return reviewers;
}

/**
 * Detect if a verdict file is the legacy plain-JSON shape.
 * Legacy = array of plain objects without a `signature` field,
 * OR an object with a `verdicts` array where entries lack `signature`.
 *
 * Returns { isLegacy: boolean, verdicts: array }.
 */
function classifyVerdictFile(raw) {
  if (Array.isArray(raw)) {
    // Could be flat array of either shape.
    const hasSubAttestation = raw.some(
      (v) => v && typeof v === 'object' && 'signature' in v && 'contentHash' in v,
    );
    if (hasSubAttestation) {
      return { isLegacy: false, subAttestations: raw };
    }
    return { isLegacy: true, legacyVerdicts: raw };
  }

  if (raw !== null && typeof raw === 'object') {
    // Nested object shape { taskId, subAttestations: [...] } (new shape)
    if (Array.isArray(raw.subAttestations)) {
      return { isLegacy: false, subAttestations: raw.subAttestations };
    }
    // Nested object shape { taskId, decision, counts, verdicts: [...] } (legacy nested)
    if (Array.isArray(raw.verdicts)) {
      const hasSubAttestation = raw.verdicts.some(
        (v) => v && typeof v === 'object' && 'signature' in v,
      );
      if (hasSubAttestation) {
        return { isLegacy: false, subAttestations: raw.verdicts };
      }
      return { isLegacy: true, legacyVerdicts: raw.verdicts };
    }
  }

  return { isLegacy: true, legacyVerdicts: [] };
}

/**
 * Verify a single sub-attestation against the trusted reviewers registry.
 * Returns null on success, or an error message string on failure.
 */
function verifySubAttestation(subAtt, taskId, registryEntries) {
  const { reviewerName, taskId: attTaskId, verdict, contentHash, signature, keyid } = subAtt;

  // Basic shape validation.
  if (!reviewerName || typeof reviewerName !== 'string') {
    return 'sub-attestation missing reviewerName';
  }

  // ── AISDLC-380 Bug #8: security-reviewer unsigned-exempt path ─────────
  //
  // security-reviewer declares disallowedTools: [Bash] so it cannot invoke
  // the sign helper. The slash command body marks its verdict with
  // `unsigned: true, exemptReason: 'no-bash-tool'`. Accept ONLY for
  // 'security-reviewer' with both markers present.
  //
  // This gap is documented in ai-sdlc-plugin/agents/security-reviewer.md
  // and will be closed in AISDLC-380.2.
  if (subAtt.unsigned === true && subAtt.exemptReason === 'no-bash-tool') {
    if (reviewerName === 'security-reviewer') {
      if (!verdict || typeof verdict !== 'object') {
        return `unsigned-exempt entry for 'security-reviewer' is missing its verdict object`;
      }
      // Accepted — no signature to check.
      return null;
    }
    // Any other reviewer claiming unsigned-exempt is rejected.
    return (
      `sub-attestation for '${reviewerName}' claims unsigned-exempt (no-bash-tool) but only\n` +
      `       'security-reviewer' is permitted this exemption. All other reviewers MUST be signed.`
    );
  }

  if (!attTaskId || typeof attTaskId !== 'string') {
    return 'sub-attestation missing taskId';
  }
  if (!verdict || typeof verdict !== 'object') {
    return `sub-attestation for '${reviewerName}' missing verdict`;
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return `sub-attestation for '${reviewerName}' missing signature`;
  }
  if (typeof contentHash !== 'string' || contentHash.length === 0) {
    return `sub-attestation for '${reviewerName}' missing contentHash`;
  }

  // Verify taskId binding.
  const normalizedTaskId = taskId.trim().toUpperCase();
  const attNormalized = attTaskId.trim().toUpperCase();
  if (attNormalized !== normalizedTaskId) {
    return `sub-attestation for '${reviewerName}' binds to taskId '${attNormalized}' but current task is '${normalizedTaskId}'`;
  }

  // Verify content hash.
  const expectedHash = canonicalVerdictHash(verdict);
  if (contentHash !== expectedHash) {
    return `sub-attestation for '${reviewerName}' has contentHash mismatch (tampered verdict?)`;
  }

  // Find reviewer entry in registry.
  const reviewerEntries = registryEntries.filter(
    (e) =>
      e.type === 'reviewer' &&
      e.reviewer === reviewerName &&
      typeof e.pubkey === 'string' &&
      e.pubkey.length > 0,
  );

  if (reviewerEntries.length === 0) {
    return (
      `sub-attestation for '${reviewerName}' has no matching entry in .ai-sdlc/trusted-reviewers.yaml\n` +
      `       (expected an entry with type: 'reviewer' and reviewer: '${reviewerName}')\n` +
      `       Run: node ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs --reviewer-name ${reviewerName}\n` +
      `       Then add the generated public key to .ai-sdlc/trusted-reviewers.yaml`
    );
  }

  // Reconstruct the signed payload (must match sign-reviewer-verdict.mjs).
  const signedPayload = JSON.stringify({
    reviewerName: reviewerName.trim(),
    taskId: normalizedTaskId,
    contentHash,
  });

  let sigBytes;
  try {
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return `sub-attestation for '${reviewerName}' has invalid base64 signature`;
  }

  // Try each registry entry for this reviewer (any-of-N).
  for (const entry of reviewerEntries) {
    try {
      if (verify(null, Buffer.from(signedPayload, 'utf-8'), entry.pubkey, sigBytes)) {
        // Signature verified.
        return null;
      }
    } catch {
      // Bad pubkey PEM — try next.
    }
  }

  return (
    `sub-attestation for '${reviewerName}' signature does not match any trusted pubkey in registry\n` +
    `       (keyid: ${String(keyid ?? 'unknown')})`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const verdictFilePath = args['verdict-file'];
  const taskId = args['task-id'];
  const trustedReviewersPath = args['trusted-reviewers'];
  const legacyMode = process.env.AI_SDLC_LEGACY_VERDICTS === '1';

  if (!verdictFilePath) fail('--verdict-file <path> required');
  if (!taskId) fail('--task-id <id> required');
  if (!trustedReviewersPath) fail('--trusted-reviewers <path> required');

  if (!existsSync(verdictFilePath)) {
    fail(`verdict file not found: ${verdictFilePath}`);
  }
  if (!existsSync(trustedReviewersPath)) {
    fail(`trusted-reviewers.yaml not found: ${trustedReviewersPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(verdictFilePath, 'utf-8'));
  } catch {
    fail(`verdict file is not valid JSON: ${verdictFilePath}`);
  }

  let registryEntries;
  try {
    const yamlText = readFileSync(trustedReviewersPath, 'utf-8');
    registryEntries = parseTrustedReviewers(yamlText);
  } catch (err) {
    fail(`failed to parse trusted-reviewers.yaml: ${err.message ?? String(err)}`);
  }

  const { isLegacy, subAttestations, legacyVerdicts } = classifyVerdictFile(raw);

  // Count expected reviewers from the trusted-reviewers registry.
  const expectedReviewerEntries = registryEntries.filter(
    (e) => e.type === 'reviewer' && typeof e.reviewer === 'string' && e.reviewer.length > 0,
  );
  const expectedReviewerNames = expectedReviewerEntries.map((e) => e.reviewer);

  if (isLegacy) {
    if (legacyMode) {
      const count = (legacyVerdicts ?? []).length;
      warn(
        `verdict file at '${verdictFilePath}' uses legacy plain-JSON shape (${count} entries).\n` +
          `       AI_SDLC_LEGACY_VERDICTS=1 — proceeding with legacy mode (no sub-attestation verification).\n` +
          `       UPGRADE PATH: have reviewer subagents emit signed sub-attestations via\n` +
          `       sign-reviewer-verdict.mjs and remove AI_SDLC_LEGACY_VERDICTS=1.`,
      );
      process.exit(0);
    }

    // Determine which reviewers are missing sub-attestations for a helpful error.
    const legacyReviewers = (legacyVerdicts ?? [])
      .map((v) => (v && typeof v === 'object' ? (v.agentId ?? v.reviewerName) : null))
      .filter(Boolean);

    const missingNames =
      legacyReviewers.length > 0 ? legacyReviewers.join(', ') : '(none identified)';

    process.stderr.write(
      `[verify-sub-attestations] ERROR: verdict file at '${verdictFilePath}' uses legacy plain-JSON shape.\n` +
        `       Missing sub-attestations for: ${missingNames}\n` +
        `\n` +
        `       The 2026-05-20 incident showed dev subagents can forge plain-JSON verdicts.\n` +
        `       Reviewer subagents MUST now emit signed sub-attestations (AISDLC-380).\n` +
        `\n` +
        `       To resolve:\n` +
        `         1. Re-run the reviewer subagents — they will emit sub-attestations.\n` +
        `         2. The /ai-sdlc execute slash command body composes the aggregate file.\n` +
        `\n` +
        `       Emergency escape hatch (deprecated legacy flow ONLY):\n` +
        `         AI_SDLC_LEGACY_VERDICTS=1 git push\n`,
    );
    process.exit(1);
  }

  // ── Bug #1 fix: reject empty sub-attestations (AISDLC-380 regression) ──
  //
  // A verdict file of the form { taskId, subAttestations: [] } is classified
  // as non-legacy (it has the new shape) but iterates zero entries and exits 0.
  // This directly reproduces the forgery class from the 2026-05-20 incident.
  //
  // We require sub-attestations from EVERY reviewer registered in the trusted-
  // reviewers registry.  If no reviewers are configured at all (legitimate
  // "no reviewers yet" state), allow ONLY under AI_SDLC_LEGACY_VERDICTS=1.
  if (subAttestations.length === 0) {
    if (expectedReviewerNames.length === 0) {
      // No reviewers configured — treat as legacy only when the escape hatch is set.
      if (legacyMode) {
        warn(
          `verdict file at '${verdictFilePath}' has 0 sub-attestations and no reviewer entries in\n` +
            `       .ai-sdlc/trusted-reviewers.yaml (no reviewers configured yet).\n` +
            `       AI_SDLC_LEGACY_VERDICTS=1 — proceeding.`,
        );
        process.exit(0);
      }
      process.stderr.write(
        `[verify-sub-attestations] ERROR: verdict file at '${verdictFilePath}' has 0 sub-attestations\n` +
          `       and no reviewer entries exist in .ai-sdlc/trusted-reviewers.yaml.\n` +
          `       This prevents verifying that any reviewer actually ran.\n` +
          `       Emergency escape hatch: AI_SDLC_LEGACY_VERDICTS=1 git push\n`,
      );
      process.exit(1);
    }
    // Registry has reviewers — empty sub-attestations means ALL are missing.
    process.stderr.write(
      `[verify-sub-attestations] ERROR: verdict file at '${verdictFilePath}' has 0 sub-attestations\n` +
        `       but the registry requires sub-attestations from: ${expectedReviewerNames.join(', ')}\n` +
        `\n` +
        `       The 2026-05-20 incident: a dev wrote { subAttestations: [] } to bypass verification.\n` +
        `       Re-run reviewer subagents so they emit signed sub-attestations.\n` +
        `\n` +
        `       Emergency escape hatch (deprecated legacy flow ONLY):\n` +
        `         AI_SDLC_LEGACY_VERDICTS=1 git push\n`,
    );
    process.exit(1);
  }

  // ── Completeness check: every expected reviewer must have a sub-attestation ──
  //
  // Even with a non-empty subAttestations array, a dev could include only one
  // reviewer's sub-attestation and omit the others.  Verify by reviewerName.
  if (expectedReviewerNames.length > 0) {
    // AISDLC-380 iter-3: reject duplicate reviewerName entries. Without this
    // check, a dev could submit N copies of one valid sub-attestation to
    // satisfy a single-reviewer registry's completeness check without other
    // reviewers ever running. The Set-based foundNames dedupes silently, so
    // we compare counts directly. (code-reviewer iter-2 finding.)
    const reviewerNames = subAttestations
      .map((s) => (s && typeof s === 'object' ? s.reviewerName : null))
      .filter(Boolean);
    const foundNames = new Set(reviewerNames);
    if (foundNames.size !== reviewerNames.length) {
      const duplicates = reviewerNames.filter((name, i, arr) => arr.indexOf(name) !== i);
      process.stderr.write(
        `[verify-sub-attestations] ERROR: verdict file at '${verdictFilePath}' contains duplicate\n` +
          `       sub-attestations for reviewer(s): ${[...new Set(duplicates)].join(', ')}\n` +
          `       Each reviewer may appear at most once in the verdict file.\n`,
      );
      process.exit(1);
    }
    const missingReviewers = expectedReviewerNames.filter((name) => !foundNames.has(name));
    if (missingReviewers.length > 0) {
      process.stderr.write(
        `[verify-sub-attestations] ERROR: verdict file at '${verdictFilePath}' is missing sub-attestations\n` +
          `       from the following required reviewers: ${missingReviewers.join(', ')}\n` +
          `       (found: ${[...foundNames].join(', ') || '(none)'})\n` +
          `\n` +
          `       Re-run reviewer subagents so they emit signed sub-attestations.\n` +
          `\n` +
          `       Emergency escape hatch (deprecated legacy flow ONLY):\n` +
          `         AI_SDLC_LEGACY_VERDICTS=1 git push\n`,
      );
      process.exit(1);
    }
  }

  // Verify each sub-attestation.
  const errors = [];
  for (const subAtt of subAttestations) {
    const err = verifySubAttestation(subAtt, taskId, registryEntries);
    if (err !== null) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      `[verify-sub-attestations] ERROR: ${errors.length} sub-attestation(s) failed verification:\n`,
    );
    for (const err of errors) {
      process.stderr.write(`  - ${err}\n`);
    }
    process.stderr.write(
      `\n[verify-sub-attestations] The pre-push hook refuses to sign until all sub-attestations verify.\n`,
    );
    process.exit(1);
  }

  info(
    `verified ${subAttestations.length} sub-attestation(s) for task ${taskId.trim().toUpperCase()} — all OK`,
  );
  process.exit(0);
}

main().catch((err) => fail(err.message ?? String(err)));
