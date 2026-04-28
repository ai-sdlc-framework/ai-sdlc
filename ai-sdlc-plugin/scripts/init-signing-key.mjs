#!/usr/bin/env node
/**
 * Generate this contributor's ed25519 signing keypair for review attestations
 * (AISDLC-74).
 *
 * Backs `/ai-sdlc init-signing-key` — the plugin command resolves the path to
 * this script via `${CLAUDE_PLUGIN_ROOT}/scripts/init-signing-key.mjs` and
 * invokes it. Self-contained Node script so the plugin doesn't need a
 * `pnpm install` to bootstrap.
 *
 * Behavior contract:
 *  - Default path: `~/.ai-sdlc/signing-key.pem` (private), `signing-key.pub.pem` (public)
 *  - Refuses to overwrite an existing private key without `--force`
 *  - Private key gets mode 0600; the parent dir gets mode 0700
 *  - Prints the public key + a copy-pasteable trusted-reviewers.yaml entry to stdout
 *  - NEVER prints the private key to stdout
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const KEY_DIR = join(HOME, '.ai-sdlc');
const PRIVATE_KEY_PATH = join(KEY_DIR, 'signing-key.pem');
const PUBLIC_KEY_PATH = join(KEY_DIR, 'signing-key.pub.pem');

const args = process.argv.slice(2);
const force = args.includes('--force');

function fail(message, exitCode = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(exitCode);
}

if (existsSync(PRIVATE_KEY_PATH) && !force) {
  fail(
    `${PRIVATE_KEY_PATH} already exists.\n` +
      `       Pass --force to overwrite (this will INVALIDATE every prior\n` +
      `       attestation signed by this machine — you'll need to update\n` +
      `       .ai-sdlc/trusted-reviewers.yaml accordingly).`,
  );
}

// Ensure the parent directory exists with restrictive perms BEFORE writing
// the private key — chmod after writeFile would briefly leave it 0644.
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

// Build a sensible default identity + machine label. Operator can edit
// before pasting if they prefer email vs GitHub handle, etc.
const identity =
  process.env.GIT_AUTHOR_EMAIL || process.env.EMAIL || `${userInfo().username}@local`;
const machine = hostname();
const today = new Date().toISOString().slice(0, 10);

process.stdout.write(`Wrote ${PRIVATE_KEY_PATH} (mode 0600)\n`);
process.stdout.write(`Wrote ${PUBLIC_KEY_PATH} (mode 0644)\n`);
process.stdout.write(`\nNext: open a PR adding this entry to .ai-sdlc/trusted-reviewers.yaml\n\n`);
process.stdout.write('--- begin yaml entry ---\n');
process.stdout.write(`  - identity: '${identity}'\n`);
process.stdout.write(`    machine: '${machine}'\n`);
process.stdout.write(`    addedAt: '${today}'\n`);
process.stdout.write(`    addedBy: 'REPLACE_WITH_YOUR_GITHUB_HANDLE'\n`);
process.stdout.write(`    pubkey: |\n`);
for (const line of publicKeyPem.trimEnd().split('\n')) {
  process.stdout.write(`      ${line}\n`);
}
process.stdout.write('--- end yaml entry ---\n');
process.stdout.write(
  `\nUntil that PR merges, /ai-sdlc execute can still sign attestations but CI will\n` +
    `mark them as 'invalid (signature did not match...)' and run its own review.\n`,
);
