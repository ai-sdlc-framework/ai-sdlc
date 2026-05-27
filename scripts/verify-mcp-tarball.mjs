#!/usr/bin/env node
/**
 * verify-mcp-tarball.mjs — Install-time verification of the
 * @ai-sdlc/plugin-mcp-server npm tarball DSSE attestation (AISDLC-439, DEC-0001).
 *
 * Reads the DSSE envelope written by sign-mcp-tarball.mjs, validates the
 * signature against the pubkey set in `.ai-sdlc/trusted-reviewers.yaml` (the
 * SAME trust root used by v6 review attestations — single trust anchor, no new
 * pubkey config per DEC-0001), computes the installed tarball's SHA-512, and
 * compares it to the envelope's signed hash.
 *
 * On failure: prints an operator-actionable error message explaining the
 * discrepancy (expected vs actual SHA, which trusted-reviewers entry to check,
 * recovery path) and exits with code 1.
 *
 * On success: exits with code 0, optionally prints a one-line confirmation.
 *
 * Usage (from check-plugin-version.js hook):
 *   node scripts/verify-mcp-tarball.mjs \
 *     --version <semver> \
 *     --tarball <path>   \
 *     --envelope <path>  \
 *     --trusted-reviewers <path>
 *
 * Usage (standalone):
 *   node scripts/verify-mcp-tarball.mjs \
 *     --version 0.9.2 \
 *     --tarball ~/.cache/ai-sdlc/mcp-server-0.9.2.tgz \
 *     --envelope .ai-sdlc/attestations/mcp-server-0.9.2.dsse.json \
 *     --trusted-reviewers .ai-sdlc/trusted-reviewers.yaml
 *
 * Exit codes:
 *   0 — signature valid + SHA matches
 *   1 — signature invalid, SHA mismatch, or envelope missing
 *   2 — envelope missing (distinct exit code for hook: allows soft-fail config)
 *
 * All output goes to stderr (human-readable errors) and stdout (machine-readable
 * status: `status=valid` or `status=invalid` on the last line).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TARBALL_PREDICATE_TYPE } from './sign-mcp-tarball.mjs';

/** Load and parse the hand-rolled YAML from trusted-reviewers.yaml. */
export function loadTrustedReviewers(yamlPath) {
  if (!existsSync(yamlPath)) {
    throw new Error(`trusted-reviewers.yaml not found at ${yamlPath}`);
  }
  const raw = readFileSync(yamlPath, 'utf-8');
  return parseTrustedReviewersYaml(raw);
}

/**
 * Hand-rolled YAML parser for trusted-reviewers.yaml.
 *
 * Matches the strict format documented in .ai-sdlc/trusted-reviewers.yaml:
 *   - scalar values single-quoted
 *   - pubkey is a `|` block scalar, each PEM line indented exactly 6 spaces
 *   - no tab characters
 *   - comments `#` only at column 0
 *
 * Returns an array of { identity, machine, pubkey } objects.
 * The pubkey is the raw PEM string (including header/footer lines).
 */
export function parseTrustedReviewersYaml(raw) {
  const lines = raw.split('\n');
  const entries = [];
  let current = null;
  let inPubkey = false;
  let pubkeyLines = [];

  for (const line of lines) {
    // Skip blank lines and top-level comments.
    if (!line.trim() || line.startsWith('#')) {
      if (inPubkey && current) {
        // blank line terminates pubkey block
        if (pubkeyLines.length > 0) {
          current.pubkey = pubkeyLines.join('\n');
        }
        inPubkey = false;
        pubkeyLines = [];
      }
      continue;
    }

    // New entry: "  - identity: '...'"
    const entryMatch = line.match(/^\s+-\s+identity:\s+'([^']+)'/);
    if (entryMatch) {
      if (current && inPubkey && pubkeyLines.length > 0) {
        current.pubkey = pubkeyLines.join('\n');
      }
      inPubkey = false;
      pubkeyLines = [];
      if (current) entries.push(current);
      current = { identity: entryMatch[1] };
      continue;
    }

    if (!current) continue;

    // machine:
    const machineMatch = line.match(/^\s+machine:\s+'([^']+)'/);
    if (machineMatch) {
      current.machine = machineMatch[1];
      continue;
    }

    // pubkey: |
    if (/^\s+pubkey:\s*\|/.test(line)) {
      inPubkey = true;
      pubkeyLines = [];
      continue;
    }

    // Lines inside pubkey block (indented by 6 spaces per spec).
    if (inPubkey) {
      // Any line with more leading spaces than the 4-space list indent is pubkey.
      if (/^\s{6}/.test(line) || /^\s{4}/.test(line)) {
        pubkeyLines.push(line.trim());
        continue;
      } else {
        // Block ended.
        if (pubkeyLines.length > 0) {
          current.pubkey = pubkeyLines.join('\n');
        }
        inPubkey = false;
        pubkeyLines = [];
      }
    }
  }

  // Flush last entry.
  if (current) {
    if (inPubkey && pubkeyLines.length > 0) {
      current.pubkey = pubkeyLines.join('\n');
    }
    entries.push(current);
  }

  return entries.filter((e) => e.identity && e.pubkey);
}

/**
 * Reconstruct PAE (Pre-Authentication Encoding) for DSSE.
 *
 * PAE = "DSSEv1" SP LEN(payloadType) SP payloadType SP LEN(payload) SP payload
 * Must match sign-mcp-tarball.mjs signTarballEnvelope() exactly.
 */
function computePAE(payloadType, payloadBuf) {
  return Buffer.concat([
    Buffer.from('DSSEv1 '),
    Buffer.from(String(payloadType.length) + ' '),
    Buffer.from(payloadType, 'utf-8'),
    Buffer.from(' '),
    Buffer.from(String(payloadBuf.length) + ' '),
    payloadBuf,
  ]);
}

/**
 * Verify a DSSE signature against a PEM public key.
 * Returns true if valid.
 */
export function verifyDsseSignature(envelope, pubkeyPem) {
  try {
    const payloadBuf = Buffer.from(envelope.payload, 'base64');
    const pae = computePAE(envelope.payloadType, payloadBuf);
    const pubKey = createPublicKey(pubkeyPem);

    for (const sig of envelope.signatures ?? []) {
      const sigBuf = Buffer.from(sig.sig, 'base64');
      if (cryptoVerify(null, pae, pubKey, sigBuf)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Compute SHA-512 of a Buffer, returned as lowercase hex.
 */
export function sha512Hex(buf) {
  return createHash('sha512').update(buf).digest('hex');
}

/**
 * Full tarball attestation verification.
 *
 * Returns { valid: boolean, reason: string } where reason is:
 *   'ok'                      — all checks passed
 *   'envelope-missing'        — envelope file does not exist
 *   'envelope-parse-error'    — envelope JSON is malformed
 *   'predicate-type-mismatch' — predicateType does not match expected URI
 *   'sha-mismatch'            — tarball SHA does not match signed SHA
 *   'signature-invalid'       — no trusted-reviewers key matches the signature
 *   'pubkey-not-trusted'      — signature valid but key not in trusted-reviewers
 */
export function verifyTarballAttestation({ envelopePath, tarballBuf, trustedReviewers }) {
  // 1. Load envelope.
  if (!existsSync(envelopePath)) {
    return { valid: false, reason: 'envelope-missing' };
  }

  let envelope;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, 'utf-8'));
  } catch {
    return { valid: false, reason: 'envelope-parse-error' };
  }

  // 2. Validate predicate type.
  if (envelope.payloadType !== TARBALL_PREDICATE_TYPE) {
    return {
      valid: false,
      reason: 'predicate-type-mismatch',
      expected: TARBALL_PREDICATE_TYPE,
      actual: envelope.payloadType,
    };
  }

  // 3. Decode predicate and validate SHA.
  let predicate;
  try {
    predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
  } catch {
    return { valid: false, reason: 'envelope-parse-error' };
  }

  const signedSha = predicate?.predicate?.sha512 ?? predicate?.subject?.[0]?.digest?.sha512;
  if (!signedSha) {
    return { valid: false, reason: 'envelope-parse-error' };
  }

  const actualSha = sha512Hex(tarballBuf);
  if (actualSha !== signedSha) {
    return {
      valid: false,
      reason: 'sha-mismatch',
      expected: signedSha,
      actual: actualSha,
    };
  }

  // 4. Verify signature against any-of-N trusted-reviewers pubkeys.
  const pemHeader = '-----BEGIN PUBLIC KEY-----';
  for (const reviewer of trustedReviewers) {
    const pem = reviewer.pubkey.includes(pemHeader)
      ? reviewer.pubkey
      : `${pemHeader}\n${reviewer.pubkey}\n-----END PUBLIC KEY-----`;
    if (verifyDsseSignature(envelope, pem)) {
      return { valid: true, reason: 'ok', signerIdentity: reviewer.identity };
    }
  }

  return { valid: false, reason: 'signature-invalid' };
}

/**
 * Format an operator-actionable error message for each failure reason.
 */
export function formatVerificationError({
  reason,
  version,
  envelopePath,
  expected,
  actual,
  trustedReviewersPath,
}) {
  switch (reason) {
    case 'envelope-missing':
      return (
        `MCP server tarball attestation MISSING for version ${version}.\n` +
        `  Expected envelope at: ${envelopePath}\n` +
        `  Recovery: the signed envelope should be committed to .ai-sdlc/attestations/.\n` +
        `  If this is a fresh install of a newly-released version, the envelope may\n` +
        `  not yet be present in the installed plugin's git tree. Re-run:\n` +
        `    git -C "$CLAUDE_PLUGIN_ROOT" pull --ff-only\n` +
        `  to refresh the attestation. If the envelope is still missing, open an\n` +
        `  issue at https://github.com/ai-sdlc-framework/ai-sdlc/issues.`
      );
    case 'envelope-parse-error':
      return (
        `MCP server tarball attestation is CORRUPT for version ${version}.\n` +
        `  Envelope: ${envelopePath}\n` +
        `  The file exists but is not valid JSON or is missing required fields.\n` +
        `  Recovery: delete ${envelopePath} and run\n` +
        `    git -C "$CLAUDE_PLUGIN_ROOT" checkout HEAD -- ${envelopePath}\n` +
        `  to restore the committed version.`
      );
    case 'predicate-type-mismatch':
      return (
        `MCP server tarball attestation has unexpected predicateType.\n` +
        `  Expected: ${expected}\n` +
        `  Actual:   ${actual}\n` +
        `  Envelope: ${envelopePath}\n` +
        `  Recovery: the envelope was likely written by an incompatible tool version.`
      );
    case 'sha-mismatch':
      return (
        `MCP server tarball SHA-512 MISMATCH for version ${version}.\n` +
        `  Signed SHA-512:   ${expected}\n` +
        `  Installed SHA-512: ${actual}\n` +
        `  This indicates the installed tarball differs from what was signed at\n` +
        `  release time. Possible causes:\n` +
        `    - The npm registry served a tampered tarball (critical: stop and investigate)\n` +
        `    - A local file was corrupted in transit\n` +
        `  Recovery:\n` +
        `    1. Re-install from a trusted source:\n` +
        `         npm install @ai-sdlc/plugin-mcp-server@${version} --registry https://registry.npmjs.org\n` +
        `    2. Verify the npm registry's own integrity record:\n` +
        `         npm view @ai-sdlc/plugin-mcp-server@${version} dist.integrity\n` +
        `    3. If the SHA still does not match the envelope, open a security issue\n` +
        `       at https://github.com/ai-sdlc-framework/ai-sdlc/security`
      );
    case 'signature-invalid':
      return (
        `MCP server tarball attestation SIGNATURE INVALID for version ${version}.\n` +
        `  Envelope: ${envelopePath}\n` +
        `  Checked against all pubkeys in: ${trustedReviewersPath}\n` +
        `  No trusted key matched the DSSE signature.\n` +
        `  Recovery:\n` +
        `    1. Confirm .ai-sdlc/trusted-reviewers.yaml is up to date:\n` +
        `         git -C "$CLAUDE_PLUGIN_ROOT" log --oneline -- .ai-sdlc/trusted-reviewers.yaml\n` +
        `    2. If the envelope was signed with a key recently rotated out, that\n` +
        `       envelope is legitimately invalid — re-install the plugin and fetch\n` +
        `       a freshly-signed envelope.\n` +
        `    3. If you believe this is a false positive, open an issue at\n` +
        `       https://github.com/ai-sdlc-framework/ai-sdlc/issues.`
      );
    default:
      return `MCP server tarball verification failed (reason: ${reason}).`;
  }
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

/**
 * Main entry point for CLI / hook invocation.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const version = args['version'];
  const tarballPath = args['tarball'];
  const envelopePath = args['envelope'];
  const trustedReviewersPath = args['trusted-reviewers'];

  if (!version) {
    process.stderr.write('ERROR: --version <semver> is required\n');
    process.exit(1);
  }
  if (!tarballPath) {
    process.stderr.write('ERROR: --tarball <path> is required\n');
    process.exit(1);
  }
  if (!envelopePath) {
    process.stderr.write('ERROR: --envelope <path> is required\n');
    process.exit(1);
  }
  if (!trustedReviewersPath) {
    process.stderr.write('ERROR: --trusted-reviewers <path> is required\n');
    process.exit(1);
  }

  // Load trusted reviewers.
  let trustedReviewers;
  try {
    trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  }

  // Load tarball.
  if (!existsSync(tarballPath)) {
    process.stderr.write(`ERROR: tarball not found at ${tarballPath}\n`);
    process.exit(1);
  }
  const tarballBuf = readFileSync(tarballPath);

  // Verify.
  const result = verifyTarballAttestation({ envelopePath, tarballBuf, trustedReviewers });

  if (result.valid) {
    process.stderr.write(
      `[verify-mcp-tarball] attestation VALID for ${version} (signer: ${result.signerIdentity})\n`,
    );
    process.stdout.write('status=valid\n');
    process.exit(0);
  }

  // Failed — print operator-actionable error.
  const msg = formatVerificationError({
    reason: result.reason,
    version,
    envelopePath,
    expected: result.expected,
    actual: result.actual,
    trustedReviewersPath,
  });
  process.stderr.write(`[verify-mcp-tarball] FAILED: ${msg}\n`);
  process.stdout.write('status=invalid\n');
  process.exit(result.reason === 'envelope-missing' ? 2 : 1);
}

// Run main only when invoked directly.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('verify-mcp-tarball.mjs') ||
    process.argv[1].endsWith('verify-mcp-tarball'));
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err.message ?? String(err)}\n`);
    process.exit(1);
  });
}
