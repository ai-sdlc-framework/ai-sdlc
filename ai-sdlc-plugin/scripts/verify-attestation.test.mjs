/**
 * e2e tests for `verify-attestation.mjs` — the consumer-runnable DSSE
 * attestation verifier (AISDLC-566).
 *
 * Mirrors `sign-attestation.test.mjs`'s "adopter runtime resolution" style:
 * spawn the script against a synthetic repo laid out the way an adopter's
 * actually is, and assert BOTH (a) which candidate wins resolution and
 * (b) that the actual verification result (valid/invalid) is correct — i.e.
 * this is not just a resolution smoke test, it is a real sign-then-verify
 * round trip.
 *
 * AISDLC-566 SECURITY FIX (post-review): the consumer verifier trusts a
 * runtime copy ONLY when it resolves from OUTSIDE `repoRoot` (the untrusted
 * PR checkout) — never from `<repoRoot>/orchestrator/dist/…` or
 * `<repoRoot>/node_modules/…`, unlike the signer (which runs on trusted
 * operator content and is safe to resolve repoRoot-first). Tests below
 * install the TRUSTED runtime copy for the *verify* step via
 * `$CLAUDE_PLUGIN_ROOT` (a location outside the checkout, matching the real
 * adopter CI recipe), while the *sign* step (unaffected by this fix; see
 * `sign-attestation.mjs`) may still use a repoRoot-installed copy. A
 * dedicated describe block at the bottom proves a hostile runtime planted
 * INSIDE `repoRoot` is never loaded, even when it would report `valid` on a
 * forged envelope.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/verify-attestation.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const signHelperPath = join(__dirname, 'sign-attestation.mjs');
const verifyHelperPath = join(__dirname, 'verify-attestation.mjs');
const repoRoot = join(__dirname, '..', '..');

before(() => {
  // Both helpers ultimately resolve to the compiled orchestrator runtime —
  // make sure it's built so the shim (which re-exports the real dist) works.
  // The v6 sign path additionally resolves @ai-sdlc/pipeline-cli's compiled
  // sign-v6 module.
  try {
    execFileSync('pnpm', ['--filter', '@ai-sdlc/orchestrator', 'build'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    execFileSync('pnpm', ['--filter', '@ai-sdlc/pipeline-cli', 'build'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(
      `failed to build orchestrator/pipeline-cli: ${err.stderr?.toString() ?? err.message}`,
    );
  }
});

function cleanEnv(extra = {}) {
  const inherited = { ...process.env };
  // AISDLC-554/566: strip the plugin env vars so tests control resolution
  // explicitly rather than leaking whatever ambient shell state is present.
  delete inherited.CLAUDE_PLUGIN_DIR;
  delete inherited.CLAUDE_PLUGIN_ROOT;
  const env = { ...inherited, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  if (env.AI_SDLC_V5_LEGACY === undefined) {
    env.AI_SDLC_V5_LEGACY = '1';
  }
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

/** Path an npm/pnpm install would place the runtime at, under `dir`. */
function installedRuntimePath(dir) {
  return join(
    dir,
    'node_modules',
    '@ai-sdlc',
    'orchestrator',
    'dist',
    'runtime',
    'attestations.js',
  );
}

const REAL_RUNTIME = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');
const REAL_SIGN_V6 = join(repoRoot, 'pipeline-cli', 'dist', 'attestation', 'sign-v6.js');

/** Write a shim that re-exports the real built runtime at an arbitrary path. */
function writeRuntimeShim(target, body) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body ?? `export * from '${REAL_RUNTIME.replace(/\\/g, '\\\\')}';\n`);
}

/** Path an npm/pnpm install would place the v6 signer at, under `dir`. */
function installedSignV6Path(dir) {
  return join(dir, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'dist', 'attestation', 'sign-v6.js');
}

/** Write a shim that re-exports the real built v6 signer at an arbitrary path. */
function writeSignV6Shim(target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `export * from '${REAL_SIGN_V6.replace(/\\/g, '\\\\')}';\n`);
}

function writeTrustedReviewersYaml(root, pubkeyPem) {
  const yaml =
    [
      '# trusted reviewers test fixture',
      'reviewers:',
      "  - identity: 'dev@example.com'",
      "    machine: 'laptop'",
      "    addedAt: '2026-04-27'",
      "    addedBy: 'maintainer'",
      '    pubkey: |',
      ...pubkeyPem
        .trimEnd()
        .split('\n')
        .map((l) => `      ${l}`),
    ].join('\n') + '\n';
  writeFileSync(join(root, '.ai-sdlc', 'trusted-reviewers.yaml'), yaml);
}

/**
 * Build a fixture repo shaped like a CONSUMER/adopter repo: no
 * `orchestrator/` source tree at all, only whatever gets installed via
 * `writeRuntimeShim`. Every file `sign-attestation.mjs` / `verify-attestation.mjs`
 * need is present.
 */
function setupAdopterRepo(root) {
  mkdirSync(root, { recursive: true });
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', 'agents'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'review-policy.md'), '# review policy v1\n');
  for (const agentId of [
    'code-reviewer',
    'code-reviewer-codex',
    'test-reviewer',
    'test-reviewer-codex',
    'security-reviewer',
  ]) {
    writeFileSync(
      join(root, 'ai-sdlc-plugin', 'agents', `${agentId}.md`),
      `---\nname: ${agentId}\n---\nbody\n`,
    );
  }
  writeFileSync(join(root, 'ai-sdlc-plugin', 'plugin.json'), JSON.stringify({ version: '0.7.0' }));
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  const baseSha = git(['rev-parse', 'HEAD'], root).trim();
  git(['branch', '-f', 'origin/main', 'HEAD'], root);
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], root);
  git(['commit', '-q', '-m', 'feature'], root);
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', baseSha], {
    cwd: root,
    env: cleanEnv(),
  });
  return { root, headSha, baseSha };
}

function writeSigningKey(tmpHome, privateKeyPem) {
  mkdirSync(join(tmpHome, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(tmpHome, '.ai-sdlc', 'signing-key.pem'), privateKeyPem);
}

function runSign(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [signHelperPath, ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf-8',
  });
}

function runVerify(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [verifyHelperPath, ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf-8',
  });
}

const STANDARD_VERDICTS = JSON.stringify([
  {
    agentId: 'code-reviewer',
    harness: 'codex',
    approved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  },
  {
    agentId: 'test-reviewer',
    harness: 'codex',
    approved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  },
  {
    agentId: 'security-reviewer',
    harness: 'codex',
    approved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  },
]);

describe('verify-attestation.mjs — consumer-runnable verifier (AISDLC-566)', () => {
  let tmpHome;
  let base;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-home-'));
    base = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-adopter-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('signs (v5) with a repoRoot copy, verifies via a TRUSTED $CLAUDE_PLUGIN_ROOT copy', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    // Sign-side runtime resolution is unaffected by AISDLC-566 (signer runs
    // on trusted operator content) — a repoRoot-installed copy is fine here.
    writeRuntimeShim(installedRuntimePath(fixture.root));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, STANDARD_VERDICTS);
    const signRes = runSign(
      fixture.root,
      [
        '--review-verdicts',
        verdictsPath,
        '--iteration-count',
        '1',
        '--harness-note',
        '',
        '--schema-version',
        'v5',
      ],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(signRes.status, 0, `sign stderr: ${signRes.stderr}\nstdout: ${signRes.stdout}`);

    // Verify-side runtime MUST come from OUTSIDE repoRoot (AISDLC-566) — the
    // real adopter CI recipe installs it into $CLAUDE_PLUGIN_ROOT, never
    // into the PR checkout itself.
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(
      verifyRes.status,
      0,
      `expected status=valid (exit 0); stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`,
    );
    assert.match(verifyRes.stdout, /status=valid/);
    assert.match(verifyRes.stdout, /reason=ok/);
    // Assert WHICH candidate resolved — the trusted plugin copy, never the
    // repoRoot-installed one used for signing.
    assert.ok(
      verifyRes.stderr.includes(installedRuntimePath(pluginDir)),
      `expected the trusted plugin copy to resolve; stderr: ${verifyRes.stderr}`,
    );
    assert.ok(
      !verifyRes.stderr.includes(installedRuntimePath(fixture.root)),
      `must NOT resolve the repoRoot-installed copy; stderr: ${verifyRes.stderr}`,
    );
  });

  it('signs a v6 (Merkle-transcript) envelope and verifies it via a TRUSTED $CLAUDE_PLUGIN_ROOT copy', () => {
    // AC#1: the consumer verifier must return a correct pass/fail on a v6
    // envelope specifically (v6 is the default schema per CLAUDE.md), not
    // just the legacy v5 path exercised above.
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    writeRuntimeShim(installedRuntimePath(fixture.root));
    writeSignV6Shim(installedSignV6Path(fixture.root));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    // Stage transcript leaves for this task in the legacy shared file — the
    // signer's shared-fallback path filters by taskId (AISDLC-421), so this
    // is a valid on-disk shape for a v6 sign.
    const taskId = 'AISDLC-566';
    const leaves = ['code-reviewer', 'test-reviewer', 'security-reviewer'].map(
      (reviewerName, leafIndex) => ({
        leafIndex,
        taskId,
        reviewerName,
        transcriptHash: String(leafIndex).repeat(64).slice(0, 64),
        nonce: 'b'.repeat(64),
        harness: 'claude-code',
        model: 'sonnet',
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        signedAt: '2026-09-04T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'transcript-leaves.jsonl'),
      leaves.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, JSON.stringify([]));
    const signRes = runSign(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--task-id', taskId, '--iteration-count', '1'],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com', AI_SDLC_V5_LEGACY: '' },
    );
    assert.equal(signRes.status, 0, `sign stderr: ${signRes.stderr}\nstdout: ${signRes.stdout}`);
    assert.ok(
      signRes.stdout.trim().endsWith('.v6.dsse.json'),
      `expected a v6 envelope path, got: ${signRes.stdout}`,
    );

    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(
      verifyRes.status,
      0,
      `expected status=valid (exit 0); stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`,
    );
    assert.match(verifyRes.stdout, /status=valid/);
    assert.ok(
      verifyRes.stderr.includes(installedRuntimePath(pluginDir)),
      `expected the trusted plugin copy to resolve; stderr: ${verifyRes.stderr}`,
    );
  });

  it('rejects (status=invalid, exit 1) when the source diff was tampered with after signing', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    writeRuntimeShim(installedRuntimePath(fixture.root));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, STANDARD_VERDICTS);
    const signRes = runSign(
      fixture.root,
      [
        '--review-verdicts',
        verdictsPath,
        '--iteration-count',
        '1',
        '--harness-note',
        '',
        '--schema-version',
        'v5',
      ],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(signRes.status, 0, `sign stderr: ${signRes.stderr}`);

    // Tamper: force-push-shaped edit — amend HEAD's file content after signing.
    writeFileSync(join(fixture.root, 'feature.txt'), 'tampered content\n');
    git(['add', 'feature.txt'], fixture.root);
    git(['commit', '-q', '--amend', '-m', 'feature (tampered)'], fixture.root);
    const tamperedHeadSha = git(['rev-parse', 'HEAD'], fixture.root).trim();

    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const verifyRes = runVerify(
      fixture.root,
      ['--head', tamperedHeadSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(verifyRes.status, 1, `expected exit 1; stdout: ${verifyRes.stdout}`);
    assert.match(verifyRes.stdout, /status=invalid/);
  });

  it('resolves via CLAUDE_PLUGIN_ROOT with nothing installed in the repo itself', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, STANDARD_VERDICTS);
    const signRes = runSign(
      fixture.root,
      [
        '--review-verdicts',
        verdictsPath,
        '--iteration-count',
        '1',
        '--harness-note',
        '',
        '--schema-version',
        'v5',
      ],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com', CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(signRes.status, 0, `sign stderr: ${signRes.stderr}`);

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(verifyRes.status, 0, `stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`);
    assert.match(verifyRes.stdout, /status=valid/);
    assert.ok(
      verifyRes.stderr.includes(installedRuntimePath(pluginDir)),
      `expected the plugin copy to resolve; stderr: ${verifyRes.stderr}`,
    );
  });

  it('defaults --head/--base from git when neither flags nor env vars are given', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    writeRuntimeShim(installedRuntimePath(fixture.root));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, STANDARD_VERDICTS);
    const signRes = runSign(
      fixture.root,
      [
        '--review-verdicts',
        verdictsPath,
        '--iteration-count',
        '1',
        '--harness-note',
        '',
        '--schema-version',
        'v5',
      ],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(signRes.status, 0, `sign stderr: ${signRes.stderr}`);

    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    // No --head/--base, no PR_HEAD_SHA/PR_BASE_SHA — the script must default
    // to `git rev-parse HEAD` and `git merge-base origin/main HEAD`.
    const verifyRes = runVerify(fixture.root, [], { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir });
    assert.equal(verifyRes.status, 0, `stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`);
    assert.match(verifyRes.stdout, /status=valid/);
  });

  it('fails loud with adopter-actionable guidance when the runtime is absent everywhere', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    // No runtime shim written anywhere.
    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );
    assert.equal(verifyRes.status, 2);
    assert.match(verifyRes.stderr, /TRUSTED/);
    assert.match(verifyRes.stderr, /install-runtime-deps\.sh/);
    assert.match(verifyRes.stderr, /node_modules[/\\]@ai-sdlc[/\\]orchestrator/);
  });

  it('rejects an installed runtime copy older than the declared minimum, even from a trusted location', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(
      installedRuntimePath(pluginDir),
      "throw new Error('stale copy must not be loaded');\n",
    );
    writeFileSync(
      join(pluginDir, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.13.9' }),
    );

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(verifyRes.status, 2);
    assert.match(verifyRes.stderr, /Rejected as too old/);
  });
});

// ── AISDLC-566 security regression: hostile repoRoot runtime is never
// trusted, even when it would report every envelope as valid ──────────────
//
// Motivating finding (security review of PR #981): pre-fix, candidates #1
// (`<repoRoot>/orchestrator/dist/…`) and #2 (`<repoRoot>/node_modules/…`)
// were tried BEFORE the trusted `$CLAUDE_PLUGIN_ROOT` copy. Since `repoRoot`
// is the UNTRUSTED PR checkout in the adopter CI recipe, a malicious PR
// could commit its own forged runtime there and have this driver import
// (execute) and trust it — reporting a FORGED envelope `status=valid`, or
// worse, arbitrary code execution via `import()`.
//
// These tests forge a v6 envelope signed by an ATTACKER key (never present
// in `.ai-sdlc/trusted-reviewers.yaml`) and plant a HOSTILE runtime — one
// whose `validateTrustedReviewers()` claims the attacker's own key IS the
// legitimate `dev@example.com` reviewer's key — at both pre-fix repoRoot
// candidate locations. If the driver ever loaded that hostile module, the
// forged envelope would verify as `status=valid`. It must not.
describe('verify-attestation.mjs — hostile repoRoot runtime is never trusted (AISDLC-566)', () => {
  let tmpHome;
  let base;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-hostile-home-'));
    base = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-hostile-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Writes a runtime module that ALWAYS claims the attacker's own pubkey is
   * the trusted `dev@example.com` reviewer's key — the sharpest form of
   * trust-inversion a hostile runtime could attempt (not merely "always
   * valid", but "here is a substitute trusted key that WILL verify your
   * forged signature").
   */
  function writeHostileRuntimeShim(target, attackerPublicKeyPem) {
    mkdirSync(dirname(target), { recursive: true });
    const body = `
export const ACCEPTED_SCHEMA_VERSIONS = ['v3', 'v4', 'v5', 'v6'];
export function verifyAttestation() { return { valid: true, reason: 'ok' }; }
export function sha256Hex() { return '0'.repeat(64); }
export function computeContentHashV3() { return '0'.repeat(64); }
export function computeContentHashV4() { return '0'.repeat(64); }
export function computeContentHashV5() { return '0'.repeat(64); }
export function isAttestationEnvelopePath() { return false; }
export function isIgnoredForContentHash() { return false; }
export function validateTrustedReviewers() {
  // HOSTILE: substitutes the attacker's own key for the legitimate
  // dev@example.com reviewer's key, regardless of what
  // .ai-sdlc/trusted-reviewers.yaml on disk actually says.
  return [{
    identity: 'dev@example.com',
    machine: 'laptop',
    addedAt: '2026-04-27',
    addedBy: 'maintainer',
    pubkey: \`${attackerPublicKeyPem.trimEnd()}\n\`,
  }];
}
`;
    writeFileSync(target, body);
  }

  /** Forge a v6 envelope for `headSha` signed with the ATTACKER's own key. */
  async function forgeV6Envelope(headSha, attackerPrivateKeyPem) {
    const { buildV6Envelope } = await import(pathToFileURL(REAL_SIGN_V6).href);
    const leaf = {
      leafIndex: 0,
      taskId: 'AISDLC-566',
      reviewerName: 'attacker',
      transcriptHash: 'a'.repeat(64),
      nonce: 'b'.repeat(64),
      harness: 'claude-code',
      model: 'sonnet',
      verdictApproved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      signedAt: '2026-09-04T00:00:00.000Z',
    };
    return buildV6Envelope({
      headSha,
      prLeaves: [leaf],
      allLeaves: [leaf],
      nonce: 'c'.repeat(64),
      privateKeyPem: attackerPrivateKeyPem,
    });
  }

  it('CASE A — trusted plugin copy present: forged envelope is rejected, hostile repoRoot copy never resolves', async () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);

    // Legitimate operator key — the only one in trusted-reviewers.yaml.
    const operatorKeys = generateKeyPairSync('ed25519');
    const operatorPublicKeyPem = operatorKeys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    writeTrustedReviewersYaml(fixture.root, operatorPublicKeyPem);

    // Attacker key — used ONLY to forge the envelope; never trusted.
    const attackerKeys = generateKeyPairSync('ed25519');
    const attackerPrivateKeyPem = attackerKeys.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const attackerPublicKeyPem = attackerKeys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const forged = await forgeV6Envelope(fixture.headSha, attackerPrivateKeyPem);
    mkdirSync(join(fixture.root, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`),
      JSON.stringify(forged, null, 2),
    );

    // Plant the hostile runtime at BOTH pre-fix repoRoot candidate locations.
    const hostileMonorepoDevPath = join(
      fixture.root,
      'orchestrator',
      'dist',
      'runtime',
      'attestations.js',
    );
    writeHostileRuntimeShim(hostileMonorepoDevPath, attackerPublicKeyPem);
    writeHostileRuntimeShim(installedRuntimePath(fixture.root), attackerPublicKeyPem);

    // The TRUSTED runtime (real, honest) lives outside repoRoot.
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );

    // Must NEVER report the forged envelope as valid.
    assert.doesNotMatch(
      verifyRes.stdout,
      /status=valid/,
      `hostile runtime must not be trusted — forged envelope must not verify; ` +
        `stdout: ${verifyRes.stdout}\nstderr: ${verifyRes.stderr}`,
    );
    assert.equal(verifyRes.status, 1, `expected exit 1 (invalid); stdout: ${verifyRes.stdout}`);
    assert.match(verifyRes.stdout, /status=invalid/);
    // Confirm resolution: the TRUSTED plugin copy was used, never either
    // hostile repoRoot location.
    assert.ok(
      verifyRes.stderr.includes(installedRuntimePath(pluginDir)),
      `expected the trusted plugin copy to resolve; stderr: ${verifyRes.stderr}`,
    );
    assert.ok(
      !verifyRes.stderr.includes(hostileMonorepoDevPath) &&
        !verifyRes.stderr.includes(installedRuntimePath(fixture.root)),
      `must NOT resolve either hostile repoRoot candidate; stderr: ${verifyRes.stderr}`,
    );
  });

  it('CASE B — no trusted copy anywhere: fails closed, forged envelope never reported valid', async () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);

    const operatorKeys = generateKeyPairSync('ed25519');
    const operatorPublicKeyPem = operatorKeys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    writeTrustedReviewersYaml(fixture.root, operatorPublicKeyPem);

    const attackerKeys = generateKeyPairSync('ed25519');
    const attackerPrivateKeyPem = attackerKeys.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const attackerPublicKeyPem = attackerKeys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const forged = await forgeV6Envelope(fixture.headSha, attackerPrivateKeyPem);
    mkdirSync(join(fixture.root, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`),
      JSON.stringify(forged, null, 2),
    );

    // Hostile runtime at BOTH pre-fix repoRoot candidate locations — and
    // NOTHING trusted anywhere (no $CLAUDE_PLUGIN_ROOT/DIR, no script-
    // relative plugin install in this synthetic layout).
    const hostileMonorepoDevPath = join(
      fixture.root,
      'orchestrator',
      'dist',
      'runtime',
      'attestations.js',
    );
    writeHostileRuntimeShim(hostileMonorepoDevPath, attackerPublicKeyPem);
    writeHostileRuntimeShim(installedRuntimePath(fixture.root), attackerPublicKeyPem);

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );

    // Fail CLOSED: never status=valid, and the hostile copy is never cited
    // as the resolved runtime.
    assert.doesNotMatch(
      verifyRes.stdout,
      /status=valid/,
      `must fail closed, not silently trust the hostile repoRoot runtime; ` +
        `stdout: ${verifyRes.stdout}\nstderr: ${verifyRes.stderr}`,
    );
    assert.ok(
      !verifyRes.stderr.includes(`] attestation runtime: ${hostileMonorepoDevPath}`) &&
        !verifyRes.stderr.includes(`] attestation runtime: ${installedRuntimePath(fixture.root)}`),
      `must NOT resolve either hostile repoRoot candidate as the trusted runtime; stderr: ${verifyRes.stderr}`,
    );
  });
});

describe('verify-attestation.mjs — module surface', () => {
  it('re-exports the shared verification core cleanly (no monorepo-relative import)', () => {
    const source = readFileSync(verifyHelperPath, 'utf-8');
    assert.doesNotMatch(
      source,
      /from ['"]\.\.\/\.\.\/orchestrator\/dist/,
      'ai-sdlc-plugin/scripts/verify-attestation.mjs must not statically import ../../orchestrator/dist — ' +
        'that path only resolves inside this monorepo checkout (AISDLC-566)',
    );
  });

  it('never derives a runtime candidate from repoRoot (AISDLC-566 trust-boundary fix)', () => {
    const source = readFileSync(verifyHelperPath, 'utf-8');
    assert.doesNotMatch(
      source,
      /join\(repoRoot,\s*(workspaceDir|['"]orchestrator['"])/,
      'the consumer verifier must never build a candidate path from repoRoot — ' +
        'repoRoot is the UNTRUSTED PR checkout under verification (AISDLC-566)',
    );
    assert.doesNotMatch(
      source,
      /nodeModulesWalkUp\(repoRoot/,
      'the consumer verifier must never walk node_modules starting at repoRoot (AISDLC-566)',
    );
    assert.match(
      source,
      /isInsideRepoRoot/,
      'the consumer verifier must hard-reject any candidate that resolves inside repoRoot (AISDLC-566)',
    );
  });

  it('scripts/verify-attestation.mjs (repo-root CI verifier) still imports the shared core, not a copy', () => {
    const rootDriverPath = join(repoRoot, 'scripts', 'verify-attestation.mjs');
    const source = readFileSync(rootDriverPath, 'utf-8');
    assert.match(
      source,
      /verify-attestation-core\.mjs/,
      'scripts/verify-attestation.mjs must import the shared core so both drivers stay ' +
        'behaviourally identical (AISDLC-566)',
    );
  });
});
