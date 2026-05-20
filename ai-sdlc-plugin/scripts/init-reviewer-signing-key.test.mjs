#!/usr/bin/env node
/**
 * CLI-level tests for `ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs`.
 *
 * Part of AISDLC-380 Bug #6 — the 138-line public CLI had zero coverage.
 *
 * Covers:
 *   - Valid reviewer name → key pair generated at expected paths
 *   - Invalid reviewer name → reject with list of valid names
 *   - Existing key + no --force → refuse with helpful message
 *   - --force → overwrite existing key
 *   - Mode 0700 on directory + 0600 on private key (POSIX-only check)
 *   - YAML block printed to stdout matches expected schema
 *
 * Run with: node --test ai-sdlc-plugin/scripts/init-reviewer-signing-key.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'init-reviewer-signing-key.mjs');

function run(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('init-reviewer-signing-key.mjs (AISDLC-380 Bug #6)', () => {
  let tmpDir;
  let fakeHome;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-init-key-'));
    fakeHome = tmpDir; // Use temp dir as HOME so keys land there, not in real ~/.ai-sdlc
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Missing --reviewer-name ────────────────────────────────────────────────

  it('missing --reviewer-name → exits 1 with error', () => {
    const r = run([], { HOME: fakeHome });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /reviewer-name.*required/i,
      `stderr must mention missing arg: ${r.stderr}`,
    );
  });

  // ── Invalid reviewer name ─────────────────────────────────────────────────

  it('invalid reviewer name → exits 1 listing valid names', () => {
    const r = run(['--reviewer-name', 'nonexistent-reviewer'], { HOME: fakeHome });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Unknown reviewer name/i, `stderr must say Unknown: ${r.stderr}`);
    // Must list the valid names.
    assert.match(r.stderr, /code-reviewer/i, `stderr must list valid names: ${r.stderr}`);
  });

  // ── Valid key generation ──────────────────────────────────────────────────

  it('valid reviewer name → generates private + public key files', () => {
    const r = run(['--reviewer-name', 'code-reviewer'], { HOME: fakeHome });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);

    const keyDir = join(fakeHome, '.ai-sdlc', 'reviewer-keys');
    const privPath = join(keyDir, 'code-reviewer.pem');
    const pubPath = join(keyDir, 'code-reviewer.pub.pem');

    assert.equal(existsSync(privPath), true, 'private key file must exist');
    assert.equal(existsSync(pubPath), true, 'public key file must exist');

    // Confirm PEM format.
    const priv = readFileSync(privPath, 'utf-8');
    const pub = readFileSync(pubPath, 'utf-8');
    assert.match(
      priv,
      /-----BEGIN PRIVATE KEY-----|-----BEGIN EC PRIVATE KEY-----/,
      'private key must be PEM format',
    );
    assert.match(pub, /-----BEGIN PUBLIC KEY-----/, 'public key must be PEM format');
  });

  it('valid reviewer name → stdout contains YAML block with required fields', () => {
    const r = run(['--reviewer-name', 'test-reviewer'], { HOME: fakeHome });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

    // stdout must include the YAML block.
    assert.match(r.stdout, /type: 'reviewer'/i, `stdout must have type: 'reviewer': ${r.stdout}`);
    assert.match(
      r.stdout,
      /reviewer: 'test-reviewer'/i,
      `stdout must have reviewer name: ${r.stdout}`,
    );
    assert.match(r.stdout, /pubkey:/, `stdout must have pubkey field: ${r.stdout}`);
    assert.match(
      r.stdout,
      /-----BEGIN PUBLIC KEY-----/,
      `stdout must include public key PEM: ${r.stdout}`,
    );
    assert.match(r.stdout, /addedAt:/, `stdout must have addedAt field: ${r.stdout}`);
    assert.match(
      r.stdout,
      /REPLACE_WITH_YOUR_GITHUB_HANDLE/,
      `stdout must prompt for github handle: ${r.stdout}`,
    );
  });

  it('valid reviewer name → YAML block is under begin/end markers', () => {
    const r = run(['--reviewer-name', 'code-reviewer'], { HOME: fakeHome });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stdout,
      /--- begin yaml entry ---/,
      `stdout must have begin marker: ${r.stdout}`,
    );
    assert.match(r.stdout, /--- end yaml entry ---/, `stdout must have end marker: ${r.stdout}`);
  });

  // ── Existing key + no --force ─────────────────────────────────────────────

  it('existing key + no --force → exits 1 refusing to overwrite', () => {
    // Generate once.
    const r1 = run(['--reviewer-name', 'code-reviewer'], { HOME: fakeHome });
    assert.equal(r1.status, 0, `first generation failed: ${r1.stderr}`);

    // Try again without --force.
    const r2 = run(['--reviewer-name', 'code-reviewer'], { HOME: fakeHome });
    assert.equal(r2.status, 1, `expected exit 1 (no --force), got ${r2.status}: ${r2.stderr}`);
    assert.match(r2.stderr, /already exists|--force/i, `stderr must mention --force: ${r2.stderr}`);
  });

  // ── --force overwrites ────────────────────────────────────────────────────

  it('--force → overwrites existing key', () => {
    // Generate once.
    const r1 = run(['--reviewer-name', 'code-reviewer'], { HOME: fakeHome });
    assert.equal(r1.status, 0, `first generation failed: ${r1.stderr}`);

    const keyDir = join(fakeHome, '.ai-sdlc', 'reviewer-keys');
    const privPath = join(keyDir, 'code-reviewer.pem');
    const originalKey = readFileSync(privPath, 'utf-8');

    // Generate again with --force.
    const r2 = run(['--reviewer-name', 'code-reviewer', '--force'], { HOME: fakeHome });
    assert.equal(r2.status, 0, `--force generation failed: ${r2.stderr}`);

    const newKey = readFileSync(privPath, 'utf-8');
    // The new key must be different (probabilistic — extremely unlikely to be same for ed25519).
    assert.notEqual(newKey, originalKey, 'key must be regenerated when --force is passed');
  });

  // ── File permissions (POSIX only) ─────────────────────────────────────────

  it('private key has mode 0600 and key dir has mode 0700 (POSIX)', () => {
    if (platform() === 'win32') {
      // chmod is not meaningful on Windows — skip.
      return;
    }

    const r = run(['--reviewer-name', 'security-reviewer'], { HOME: fakeHome });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

    const keyDir = join(fakeHome, '.ai-sdlc', 'reviewer-keys');
    const privPath = join(keyDir, 'security-reviewer.pem');

    const dirStat = statSync(keyDir);
    // Check that the directory permission bits are 0700 (owner rwx only).
    // eslint-disable-next-line no-bitwise
    const dirMode = dirStat.mode & 0o777;
    assert.equal(dirMode, 0o700, `key dir mode must be 0700, got ${dirMode.toString(8)}`);

    const privStat = statSync(privPath);
    // eslint-disable-next-line no-bitwise
    const privMode = privStat.mode & 0o777;
    assert.equal(privMode, 0o600, `private key mode must be 0600, got ${privMode.toString(8)}`);
  });

  // ── All valid reviewer names ──────────────────────────────────────────────

  for (const name of [
    'code-reviewer',
    'code-reviewer-codex',
    'test-reviewer',
    'test-reviewer-codex',
    'security-reviewer',
  ]) {
    it(`accepted name: ${name}`, () => {
      // Use a unique subdirectory per name to avoid cross-test key conflicts.
      const nameHome = join(tmpDir, name.replace(/-/g, '_'));
      mkdirSync(nameHome, { recursive: true });
      const r = run(['--reviewer-name', name], { HOME: nameHome });
      assert.equal(r.status, 0, `expected exit 0 for ${name}, got ${r.status}: ${r.stderr}`);
    });
  }
});
