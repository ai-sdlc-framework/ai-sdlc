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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const signHelperPath = join(__dirname, 'sign-attestation.mjs');
const verifyHelperPath = join(__dirname, 'verify-attestation.mjs');
const repoRoot = join(__dirname, '..', '..');

function requireDist(pkg, file) {
  const p = join(repoRoot, pkg, 'dist', file);
  if (!existsSync(p)) {
    throw new Error(
      `precondition: ${pkg}/dist is not built (missing ${pkg}/dist/${file}); ` +
        `run \`pnpm --filter @ai-sdlc/${pkg} build\` first. Tests never build it (AISDLC-862).`,
    );
  }
}

before(() => {
  // AISDLC-862: reuse the built dist; never build inside a test.
  requireDist('orchestrator', 'runtime/attestations.js');
  requireDist('pipeline-cli', 'attestation/patch-id.js');
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

/**
 * AISDLC-575: the shared verify-core module now lives inside
 * `@ai-sdlc/pipeline-cli` (not this plugin), at
 * `attestation-core/verify-core.mjs` (uncompiled — no `dist/` prefix).
 */
const REAL_VERIFY_CORE = join(repoRoot, 'pipeline-cli', 'attestation-core', 'verify-core.mjs');

/** Path an npm/pnpm install would place the verify-core module at, under `dir`. */
function installedVerifyCorePath(dir) {
  return join(
    dir,
    'node_modules',
    '@ai-sdlc',
    'pipeline-cli',
    'attestation-core',
    'verify-core.mjs',
  );
}

/** Write a shim that re-exports the real verify-core module at an arbitrary path. */
function writeVerifyCoreShim(target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `export * from '${REAL_VERIFY_CORE.replace(/\\/g, '\\\\')}';\n`);
}

/**
 * Install BOTH trusted dependencies `verify-attestation.mjs` now needs
 * (AISDLC-575) at `dir` — the orchestrator runtime AND the pipeline-cli
 * verify-core module — matching the shape a real `CLAUDE_PLUGIN_ROOT`
 * install would have. `runtimeBody` is forwarded to `writeRuntimeShim` for
 * tests that need to plant a hostile/stale runtime while keeping a healthy
 * verify-core module alongside it.
 */
function installTrustedVerifyDeps(dir, runtimeBody) {
  writeRuntimeShim(installedRuntimePath(dir), runtimeBody);
  writeVerifyCoreShim(installedVerifyCorePath(dir));
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
    // AISDLC-972: v5 signing needs the fixture seam; the verifier then rejects
    // the envelope as v5-after-cutover.
    env: cleanEnv({ ...extraEnv }),
    encoding: 'utf-8',
  });
}

// AISDLC-862: run a COPY of the verifier from a temp dir so the script-relative
// node_modules walk-up cannot reach ambient installs in the real checkout or its
// parent directories (hermetic: only what each test lays out is resolvable).
let isolatedVerifyPath;
function isolatedVerify() {
  if (!isolatedVerifyPath) {
    const dir = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-isolated-'));
    isolatedVerifyPath = join(dir, 'scripts', 'verify-attestation.mjs');
    mkdirSync(dirname(isolatedVerifyPath), { recursive: true });
    writeFileSync(isolatedVerifyPath, readFileSync(verifyHelperPath));
  }
  return isolatedVerifyPath;
}

function runVerify(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [isolatedVerify(), ...args], {
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
    installTrustedVerifyDeps(pluginDir);

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

    const isoDir = join(base, 'iso', 'plugin', 'scripts');
    mkdirSync(isoDir, { recursive: true });
    const isoCopy = join(isoDir, 'verify-attestation.mjs');
    writeFileSync(isoCopy, readFileSync(verifyHelperPath, 'utf-8'));
    const verifyRes = spawnSync(
      process.execPath,
      [isoCopy, '--head', fixture.headSha, '--base', fixture.baseSha],
      {
        cwd: fixture.root,
        env: cleanEnv({ HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir }),
        encoding: 'utf-8',
      },
    );
    assert.equal(verifyRes.status, 2);
    assert.match(verifyRes.stderr, /Rejected as too old/);
  });

  it('AISDLC-575: fails closed when the orchestrator runtime resolves but the pipeline-cli verify-core module does not', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    const pluginDir = join(base, 'plugin');
    // Orchestrator runtime IS present and trusted...
    writeRuntimeShim(installedRuntimePath(pluginDir));
    // ...but the verify-core module (now hosted in @ai-sdlc/pipeline-cli) is
    // NOT installed anywhere trusted. This must fail closed, not silently
    // fall back to some other resolution or crash uninformatively.
    const verifyRes = runVerify(
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginDir },
    );
    assert.equal(verifyRes.status, 2, `stdout: ${verifyRes.stdout}\nstderr: ${verifyRes.stderr}`);
    assert.doesNotMatch(verifyRes.stdout, /status=valid/);
    assert.match(verifyRes.stderr, /TRUSTED/);
    assert.match(verifyRes.stderr, /verify-core module/);
    assert.match(verifyRes.stderr, /node_modules[/\\]@ai-sdlc[/\\]pipeline-cli/);
  });
});

/**
 * AISDLC-575 test-reviewer MAJOR-2 finding: every scenario in the describe
 * block above resolves the trusted runtime + verify-core via
 * `$CLAUDE_PLUGIN_ROOT`. This describe block proves the "consumer with no
 * Claude Code plugin session at all" path also works end-to-end: a bare
 * `node_modules` walk-up from the SCRIPT's own on-disk location, with
 * NEITHER `CLAUDE_PLUGIN_DIR` nor `CLAUDE_PLUGIN_ROOT` set.
 *
 * `nodeModulesWalkUp`'s starting point is
 * `dirname(fileURLToPath(import.meta.url))` — wherever THIS SCRIPT FILE
 * physically lives when node loads it, not a value fixed at authoring time.
 * Spawning the REAL `ai-sdlc-plugin/scripts/verify-attestation.mjs` in place
 * would always walk up from this monorepo checkout's own `ai-sdlc-plugin/scripts/`
 * directory — uncontrollable and non-hermetic (it would depend on whatever
 * happens to live in this checkout's ancestor directories on the machine
 * running the test). Instead, these tests COPY the script (verified
 * self-contained — only `node:*` imports, see the "module surface" describe
 * block below) into a synthetic install tree inside a fresh `mkdtemp`
 * directory and spawn `node` directly on that copy — no real ancestor
 * directory of this checkout is ever read or written.
 */
describe('verify-attestation.mjs — bare node_modules walk-up, no plugin session env var (AISDLC-575 AC4)', () => {
  let tmpHome;
  let base;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-walkup-home-'));
    base = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-walkup-adopter-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Copies `verify-attestation.mjs` to
   * `<installRoot>/some/nested/scripts/verify-attestation.mjs` and
   * returns the copy's path. `node_modules` laid out under `installRoot/some/`
   * (two ancestor levels above the copy) is therefore reachable by the walk-up,
   * matching the real script's own `ai-sdlc-plugin/scripts/` depth relative to
   * a hypothetical plugin install root.
   */
  function installScriptCopy(installRoot) {
    const nestedDir = join(installRoot, 'some', 'nested', 'scripts');
    mkdirSync(nestedDir, { recursive: true });
    // AISDLC-575: keep the filename identical to the real script — the
    // driver's own `invokedDirectly` guard (`process.argv[1]?.endsWith('verify-attestation.mjs')`)
    // requires it.
    const copyPath = join(nestedDir, 'verify-attestation.mjs');
    writeFileSync(copyPath, readFileSync(verifyHelperPath, 'utf-8'));
    return copyPath;
  }

  function runVerifyCopy(scriptCopyPath, cwd, args, extraEnv = {}) {
    return spawnSync(process.execPath, [scriptCopyPath, ...args], {
      cwd,
      env: cleanEnv(extraEnv),
      encoding: 'utf-8',
    });
  }

  it('fails closed (exit 2) when the walk-up layout has no trusted runtime installed anywhere', () => {
    const root = join(base, 'app');
    const fixture = setupAdopterRepo(root);
    // No runtime shim written in the fixture, and no trusted deps installed
    // under the synthetic install tree either.
    const installRoot = mkdtempSync(join(base, 'install-'));
    const scriptCopyPath = installScriptCopy(installRoot);

    const verifyRes = runVerifyCopy(
      scriptCopyPath,
      fixture.root,
      ['--head', fixture.headSha, '--base', fixture.baseSha],
      { HOME: tmpHome },
    );
    assert.equal(verifyRes.status, 2, `stdout: ${verifyRes.stdout}\nstderr: ${verifyRes.stderr}`);
    assert.match(verifyRes.stderr, /TRUSTED/);
    assert.match(verifyRes.stderr, /node_modules[/\\]@ai-sdlc[/\\]orchestrator/);
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
    installTrustedVerifyDeps(pluginDir);

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
      /pipeline-cli\/attestation-core\/verify-core\.mjs/,
      'scripts/verify-attestation.mjs must import the single-sourced core (AISDLC-575: now ' +
        'hosted in @ai-sdlc/pipeline-cli) so all drivers stay behaviourally identical (AISDLC-566)',
    );
  });

  it('this driver resolves the verify-core module from @ai-sdlc/pipeline-cli, not a local copy (AISDLC-575)', () => {
    const source = readFileSync(verifyHelperPath, 'utf-8');
    assert.doesNotMatch(
      source,
      /from ['"]\.\/verify-attestation-core\.mjs['"]/,
      'ai-sdlc-plugin/scripts/verify-attestation.mjs must not statically import a local ' +
        './verify-attestation-core.mjs copy — the canonical implementation now lives in ' +
        '@ai-sdlc/pipeline-cli, single-sourced (AISDLC-575)',
    );
    assert.match(
      source,
      /@ai-sdlc\/pipeline-cli/,
      'the consumer verifier must resolve the verify-core module from @ai-sdlc/pipeline-cli (AISDLC-575)',
    );
  });
});

// ─── AISDLC-584 — self-location agent-dir probe with fixture guard ──────────
describe('agentDirCandidates (AISDLC-584)', () => {
  it('adds <plugin root>/agents when the script lives under node_modules (plain-CI install)', async () => {
    const { agentDirCandidates } = await import(pathToFileURL(verifyHelperPath).href);
    const saved = { d: process.env.CLAUDE_PLUGIN_DIR, r: process.env.CLAUDE_PLUGIN_ROOT };
    delete process.env.CLAUDE_PLUGIN_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const script = join(
        '/ci',
        'node_modules',
        'ai-sdlc-plugin',
        'scripts',
        'verify-attestation.mjs',
      );
      assert.deepEqual(agentDirCandidates(script), [
        join('/ci', 'node_modules', 'ai-sdlc-plugin', 'agents'),
      ]);
    } finally {
      if (saved.d !== undefined) process.env.CLAUDE_PLUGIN_DIR = saved.d;
      if (saved.r !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saved.r;
    }
  });

  it('fixture guard: skips self-location when the script runs in place outside node_modules (monorepo)', async () => {
    const { agentDirCandidates } = await import(pathToFileURL(verifyHelperPath).href);
    const saved = { d: process.env.CLAUDE_PLUGIN_DIR, r: process.env.CLAUDE_PLUGIN_ROOT };
    delete process.env.CLAUDE_PLUGIN_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      assert.deepEqual(agentDirCandidates(verifyHelperPath), []);
    } finally {
      if (saved.d !== undefined) process.env.CLAUDE_PLUGIN_DIR = saved.d;
      if (saved.r !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saved.r;
    }
  });

  it('resolvePluginAgentDir returns the installed dir and rejects one inside repoRoot', async () => {
    const { resolvePluginAgentDir } = await import(pathToFileURL(verifyHelperPath).href);
    const base = mkdtempSync(join(tmpdir(), 'agentdir-selfloc-'));
    try {
      const pluginRoot = join(base, 'node_modules', 'ai-sdlc-plugin');
      mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      const script = join(pluginRoot, 'scripts', 'verify-attestation.mjs');
      const outsideRepo = join(base, 'elsewhere');
      mkdirSync(outsideRepo, { recursive: true });
      assert.equal(resolvePluginAgentDir(outsideRepo, script), join(pluginRoot, 'agents'));
      // repoRoot containing the install (e.g. checkout with committed node_modules) is rejected.
      assert.equal(resolvePluginAgentDir(base, script), null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
