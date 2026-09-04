/**
 * e2e tests for `verify-attestation.mjs` — the consumer-runnable DSSE
 * attestation verifier (AISDLC-566).
 *
 * Mirrors `sign-attestation.test.mjs`'s "adopter runtime resolution" style:
 * spawn the script against a synthetic repo laid out the way an adopter's
 * actually is (no `orchestrator/` source tree — only an installed
 * `@ai-sdlc/orchestrator` copy), and assert BOTH (a) which candidate wins
 * resolution and (b) that the actual verification result (valid/invalid) is
 * correct — i.e. this is not just a resolution smoke test, it is a real
 * sign-then-verify round trip run entirely against a `node_modules`-style
 * install layout, never against this monorepo's `orchestrator/dist/`.
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
import { fileURLToPath } from 'node:url';

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

  it('signs (v5) and verifies successfully in a node_modules-style adopter layout with no monorepo dir', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    // Adopter repo: no orchestrator/ source tree at all.
    writeRuntimeShim(installedRuntimePath(fixture.root));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeSigningKey(tmpHome, privateKeyPem);
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);

    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(
      verdictsPath,
      JSON.stringify([
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
      ]),
    );
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

    // Now verify — same adopter layout, no orchestrator/ source tree,
    // resolution MUST come from node_modules.
    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );
    assert.equal(
      verifyRes.status,
      0,
      `expected status=valid (exit 0); stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`,
    );
    assert.match(verifyRes.stdout, /status=valid/);
    assert.match(verifyRes.stdout, /reason=ok/);
    // Assert WHICH candidate resolved — the installed copy, not a monorepo path.
    assert.ok(
      verifyRes.stderr.includes(installedRuntimePath(fixture.root)),
      `expected the repo-installed copy to resolve; stderr: ${verifyRes.stderr}`,
    );
  });

  it('signs a v6 (Merkle-transcript) envelope and verifies it, in the same node_modules-style layout', () => {
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

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );
    assert.equal(
      verifyRes.status,
      0,
      `expected status=valid (exit 0); stderr: ${verifyRes.stderr}\nstdout: ${verifyRes.stdout}`,
    );
    assert.match(verifyRes.stdout, /status=valid/);
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
    writeFileSync(
      verdictsPath,
      JSON.stringify([
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
      ]),
    );
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

    const verifyRes = runVerify(
      fixture.root,
      ['--head', tamperedHeadSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
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
    writeFileSync(
      verdictsPath,
      JSON.stringify([
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
      ]),
    );
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
    writeFileSync(
      verdictsPath,
      JSON.stringify([
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
      ]),
    );
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

    // No --head/--base, no PR_HEAD_SHA/PR_BASE_SHA — the script must default
    // to `git rev-parse HEAD` and `git merge-base origin/main HEAD`.
    const verifyRes = runVerify(fixture.root, [], { HOME: tmpHome });
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
    assert.match(verifyRes.stderr, /pnpm add -D @ai-sdlc\/orchestrator/);
    assert.match(verifyRes.stderr, /install-runtime-deps\.sh/);
    assert.match(verifyRes.stderr, /node_modules[/\\]@ai-sdlc[/\\]orchestrator/);
  });

  it('rejects an installed runtime copy older than the declared minimum', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    writeRuntimeShim(
      installedRuntimePath(fixture.root),
      "throw new Error('stale copy must not be loaded');\n",
    );
    writeFileSync(
      join(fixture.root, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.13.9' }),
    );

    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );
    assert.equal(verifyRes.status, 2);
    assert.match(verifyRes.stderr, /Rejected as too old/);
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
