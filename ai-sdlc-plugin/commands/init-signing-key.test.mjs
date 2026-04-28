/**
 * Tests for the /ai-sdlc init-signing-key slash command + helper script
 * (AISDLC-74).
 *
 * Verifies the command frontmatter contract AND the helper script's behavior
 * (key generation, refuse-without-force, mode 0600, PEM-shape, onboarding
 * instructions printed). Helper runs in a sandboxed HOME pointed at a
 * temp directory so we never touch the developer's real ~/.ai-sdlc/.
 *
 * Run with: node --test ai-sdlc-plugin/commands/init-signing-key.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'init-signing-key.md');
const helperPath = join(__dirname, '..', 'scripts', 'init-signing-key.mjs');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(cmdFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in init-signing-key.md');
  frontmatter = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  body = match[2];
});

describe('/ai-sdlc init-signing-key frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'init-signing-key');
  });

  it('argument-hint mentions --force (the only meaningful flag)', () => {
    assert.match(frontmatter['argument-hint'], /--force/);
  });

  it('only allows Bash + Read (no Task, no MCP — pure local key generation)', () => {
    assert.equal(frontmatter['allowed-tools'], 'Bash, Read');
  });

  it('inherits the model from the orchestrating session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });
});

describe('/ai-sdlc init-signing-key body contract', () => {
  it('writes the private key under ~/.ai-sdlc/ (user-level, not inside repo)', () => {
    assert.match(body, /\$HOME\/\.ai-sdlc\/signing-key\.pem/);
  });

  it('refuses to overwrite without --force', () => {
    assert.match(body, /already exists/);
    assert.match(body, /--force/);
  });

  it('explains the blast radius of overwrite', () => {
    assert.match(body, /invalidate/i);
  });

  it('points at the trusted-reviewers.yaml onboarding PR step', () => {
    assert.match(body, /trusted-reviewers\.yaml/);
  });

  it('uses Node built-in crypto via the plugin scripts helper (no extra deps)', () => {
    assert.match(body, /scripts\/init-signing-key\.mjs/);
  });

  it('forbids ever printing the private key to stdout', () => {
    assert.match(body, /Never print the private key/i);
  });
});

// ─── Helper script integration tests ────────────────────────────────
//
// These actually invoke the script with HOME pointed at a tempdir so we
// can assert the side effects (file existence, permissions, stdout shape).

describe('init-signing-key.mjs helper', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-key-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function runHelper(args = []) {
    return execFileSync('node', [helperPath, ...args], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf-8',
    });
  }

  it('first invocation creates the keypair and prints onboarding instructions', () => {
    const stdout = runHelper();
    const privPath = join(tmpHome, '.ai-sdlc', 'signing-key.pem');
    const pubPath = join(tmpHome, '.ai-sdlc', 'signing-key.pub.pem');
    assert.ok(existsSync(privPath), 'private key written');
    assert.ok(existsSync(pubPath), 'public key written');

    const priv = readFileSync(privPath, 'utf-8');
    const pub = readFileSync(pubPath, 'utf-8');
    assert.match(priv, /BEGIN PRIVATE KEY/);
    assert.match(pub, /BEGIN PUBLIC KEY/);

    // Stdout should NEVER contain the private key.
    assert.ok(!stdout.includes('BEGIN PRIVATE KEY'), 'private key not leaked to stdout');
    // Stdout should contain the onboarding YAML block.
    assert.match(stdout, /BEGIN PUBLIC KEY/);
    assert.match(stdout, /--- begin yaml entry ---/);
    assert.match(stdout, /identity:/);
    assert.match(stdout, /machine:/);
    assert.match(stdout, /addedAt:/);
    assert.match(stdout, /addedBy: 'REPLACE_WITH_YOUR_GITHUB_HANDLE'/);
    assert.match(stdout, /pubkey: \|/);
  });

  it('private key has mode 0600 (owner-only readable)', () => {
    runHelper();
    const privPath = join(tmpHome, '.ai-sdlc', 'signing-key.pem');
    const mode = statSync(privPath).mode & 0o777;
    // On non-POSIX FS this may not be exactly 0o600 — but on macOS/Linux it must be.
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    }
  });

  it('refuses to overwrite an existing key without --force', () => {
    runHelper();
    let error;
    try {
      execFileSync('node', [helperPath], {
        env: { ...process.env, HOME: tmpHome },
        encoding: 'utf-8',
      });
    } catch (err) {
      error = err;
    }
    assert.ok(error, 'second invocation should fail');
    assert.match(error.stderr, /already exists/);
    assert.match(error.stderr, /--force/);
  });

  it('overwrites with --force', () => {
    const first = runHelper();
    const firstPub = readFileSync(join(tmpHome, '.ai-sdlc', 'signing-key.pub.pem'), 'utf-8');
    const second = runHelper(['--force']);
    const secondPub = readFileSync(join(tmpHome, '.ai-sdlc', 'signing-key.pub.pem'), 'utf-8');
    assert.notEqual(firstPub, secondPub, 'public key changes after --force');
    // Both runs print onboarding instructions.
    assert.match(first, /--- begin yaml entry ---/);
    assert.match(second, /--- begin yaml entry ---/);
  });

  it('handles a pre-existing ~/.ai-sdlc/ directory gracefully', () => {
    mkdirSync(join(tmpHome, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmpHome, '.ai-sdlc', 'unrelated-file.txt'), 'preserve me\n');
    runHelper();
    assert.ok(
      existsSync(join(tmpHome, '.ai-sdlc', 'unrelated-file.txt')),
      'unrelated file preserved',
    );
    assert.ok(existsSync(join(tmpHome, '.ai-sdlc', 'signing-key.pem')));
  });
});
