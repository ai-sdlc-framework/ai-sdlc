#!/usr/bin/env node
/**
 * Generate an ed25519 signing keypair for a reviewer subagent (AISDLC-380).
 *
 * Reviewer keys live at `~/.ai-sdlc/reviewer-keys/<reviewer-name>.pem`
 * (private) and `<reviewer-name>.pub.pem` (public). They are intentionally
 * SEPARATE from the operator's `~/.ai-sdlc/signing-key.pem` so the
 * trust chain is:
 *
 *   reviewer key → sub-attestation   (reviewer signed the verdict)
 *   operator key → DSSE envelope     (operator signed the aggregate)
 *
 * The developer subagent's blockedActions deny Bash access to the
 * `~/.ai-sdlc/reviewer-keys/` directory, raising the bar for accidental
 * or deliberate key theft from "trivial" to "deliberate workaround requiring
 * custom scripting".
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs \
 *     --reviewer-name code-reviewer \
 *     [--force]
 *
 * Options:
 *   --reviewer-name  name of the reviewer agent (e.g. code-reviewer, test-reviewer)
 *   --force          overwrite existing key without prompting
 *
 * After running:
 *   1. Add the printed YAML block to `.ai-sdlc/trusted-reviewers.yaml`.
 *   2. Open a PR with that change — a maintainer reviews + merges.
 *   3. After merge, reviewer subagents producing sub-attestations will be
 *      verified by `check-attestation-sign.sh` and CI.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const VALID_REVIEWER_NAMES = new Set([
  'code-reviewer',
  'code-reviewer-codex',
  'test-reviewer',
  'test-reviewer-codex',
  'security-reviewer',
]);

function fail(message, exitCode = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(exitCode);
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

const args = parseArgs(process.argv.slice(2));
const reviewerName = args['reviewer-name'];
const force = Boolean(args['force']);

if (!reviewerName || typeof reviewerName !== 'string') {
  fail('--reviewer-name <name> required');
}
if (!VALID_REVIEWER_NAMES.has(reviewerName)) {
  fail(
    `Unknown reviewer name '${reviewerName}'.\n` +
      `       Valid names: ${[...VALID_REVIEWER_NAMES].join(', ')}`,
  );
}

const HOME = homedir();
const KEY_DIR = join(HOME, '.ai-sdlc', 'reviewer-keys');
const PRIVATE_KEY_PATH = join(KEY_DIR, `${reviewerName}.pem`);
const PUBLIC_KEY_PATH = join(KEY_DIR, `${reviewerName}.pub.pem`);

if (existsSync(PRIVATE_KEY_PATH) && !force) {
  fail(
    `${PRIVATE_KEY_PATH} already exists.\n` +
      `       Pass --force to overwrite (this will INVALIDATE every prior sub-attestation\n` +
      `       signed by this reviewer key — update .ai-sdlc/trusted-reviewers.yaml accordingly).`,
  );
}

// Ensure the parent directory exists with restrictive perms BEFORE writing.
mkdirSync(KEY_DIR, { recursive: true });
try {
  chmodSync(KEY_DIR, 0o700);
} catch {
  // Non-POSIX FS (Windows) — chmod is best-effort.
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

// Write private FIRST with 0600, public second with 0644.
writeFileSync(PRIVATE_KEY_PATH, privateKeyPem, { mode: 0o600 });
writeFileSync(PUBLIC_KEY_PATH, publicKeyPem, { mode: 0o644 });
try {
  chmodSync(PRIVATE_KEY_PATH, 0o600);
} catch {
  // best-effort on non-POSIX
}

const machine = hostname();
const today = new Date().toISOString().slice(0, 10);

process.stdout.write(`Wrote ${PRIVATE_KEY_PATH} (mode 0600)\n`);
process.stdout.write(`Wrote ${PUBLIC_KEY_PATH} (mode 0644)\n`);
process.stdout.write(`\nNext: open a PR adding this entry to .ai-sdlc/trusted-reviewers.yaml\n\n`);
process.stdout.write('--- begin yaml entry ---\n');
process.stdout.write(`  - type: 'reviewer'\n`);
process.stdout.write(`    reviewer: '${reviewerName}'\n`);
process.stdout.write(`    machine: '${machine}'\n`);
process.stdout.write(`    addedAt: '${today}'\n`);
process.stdout.write(`    addedBy: 'REPLACE_WITH_YOUR_GITHUB_HANDLE'\n`);
process.stdout.write(`    pubkey: |\n`);
for (const line of publicKeyPem.trimEnd().split('\n')) {
  process.stdout.write(`      ${line}\n`);
}
process.stdout.write('--- end yaml entry ---\n');
process.stdout.write(
  `\nUntil that PR merges, check-attestation-sign.sh will warn about missing\n` +
    `reviewer registry entries but will still sign in legacy mode (pass\n` +
    `AI_SDLC_LEGACY_VERDICTS=1 to suppress the warning during the transition).\n`,
);
