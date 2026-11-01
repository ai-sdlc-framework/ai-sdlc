/**
 * e2e tests for `sign-attestation.mjs` — the helper backing `/ai-sdlc execute`
 * Step 10 (AISDLC-74). Mirrors the `init-signing-key.test.mjs` style: spawn
 * the script under a tmpdir HOME + tmpdir cwd, assert behavior on file
 * existence, error messages, and arg parsing.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/sign-attestation.test.mjs
 */

import { describe, it, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = join(__dirname, 'sign-attestation.mjs');
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
  // AISDLC-862: reuse the built dist; never build inside a test (a concurrent
  // `pnpm build` races the tsc output dir).
  requireDist('orchestrator', 'runtime/attestations.js');
  requireDist('pipeline-cli', 'attestation/patch-id.js');
});

// Mirrors .prettierrc (printWidth 100); the fixture repos live outside the checkout.
const PRETTIER_ARGS = [
  '--no-config',
  '--print-width',
  '100',
  '--single-quote',
  '--trailing-comma',
  'all',
];

function cleanEnv(extra = {}) {
  const inherited = { ...process.env };
  // AISDLC-554: these steer the signer's runtime resolution (candidates 3-4),
  // and Claude Code sets them in exactly the plugin-hook context where tests
  // may run. Leaking them from the ambient shell silently flips the negative
  // resolution tests into false passes — the runtime IS found, so
  // "fails when absent everywhere" stops testing anything. Strip them from the
  // inherited env, but let a test opt back in explicitly via `extra`.
  delete inherited.CLAUDE_PLUGIN_DIR;
  delete inherited.CLAUDE_PLUGIN_ROOT;
  const env = { ...inherited, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo(tmpHome, rootOverride) {
  const root = rootOverride ?? mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-test-'));
  mkdirSync(root, { recursive: true });
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Required files for sign-attestation.mjs to read.
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', 'agents'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'review-policy.md'), '# review policy v1\n');
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'code-reviewer.md'),
    '---\nname: code-reviewer\n---\nbody\n',
  );
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'test-reviewer.md'),
    '---\nname: test-reviewer\n---\nbody\n',
  );
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'security-reviewer.md'),
    '---\nname: security-reviewer\n---\nbody\n',
  );
  writeFileSync(join(root, 'ai-sdlc-plugin', 'plugin.json'), JSON.stringify({ version: '0.7.0' }));
  // AISDLC-610: stub pipeline-cli's compiled patch-id module the same way,
  // for the same reason — `sign-attestation.mjs` now resolves the SAME
  // `computePatchId` module `emit-leaf` / `sign-v6` use (no re-implemented
  // copy). This is best-effort/optional (see `tryLoadPipelineCliPatchId`),
  // so its absence would silently degrade tests to the legacy per-SHA
  // filename rather than fail loud — stub it so the content-addressed
  // (patch-id) filename tests below exercise the real path.
  mkdirSync(join(root, 'pipeline-cli', 'dist', 'attestation'), { recursive: true });
  const patchIdDist = join(repoRoot, 'pipeline-cli', 'dist', 'attestation', 'patch-id.js');
  writeFileSync(
    join(root, 'pipeline-cli', 'dist', 'attestation', 'patch-id.js'),
    `export * from '${patchIdDist.replace(/\\/g, '\\\\')}';\n`,
  );
  // Symlink/copy the orchestrator dist (the helper does an absolute path
  // import from `process.cwd()`, so we need the dist available there).
  mkdirSync(join(root, 'orchestrator', 'dist', 'runtime'), { recursive: true });
  // Just copy by re-exporting — easier than symlink across platforms.
  const orchDist = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');
  writeFileSync(
    join(root, 'orchestrator', 'dist', 'runtime', 'attestations.js'),
    `export * from '${orchDist.replace(/\\/g, '\\\\')}';\n`,
  );
  // Initial commit, then HEAD commit.
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Create an `origin/main` ref so `git diff origin/main...HEAD` works.
  git(['branch', '-f', 'origin/main', 'HEAD'], root);
  // Add a feature commit.
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], root);
  git(['commit', '-q', '-m', 'feature'], root);
  // Manually point a refs/remotes/origin/main ref so `origin/main` resolves.
  // Easier: configure a fake refspec via update-ref.
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  const baseSha = git(['rev-parse', 'HEAD~1'], root).trim();
  // refs/remotes/origin/main must point at baseSha for the diff to be
  // exactly the feature commit.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', baseSha], {
    cwd: root,
    env: cleanEnv(),
  });
  return { root, headSha, baseSha };
}

function writeKey(tmpHome) {
  // Generate a real key into tmpHome via the orchestrator runtime so we
  // don't shell out to init-signing-key.mjs (which would also test env).
  // Easier: just use openssl... actually, easiest is to call generateKeyPairSync
  // via Node directly here in the test.
  mkdirSync(join(tmpHome, '.ai-sdlc'), { recursive: true });
  // Use Node inline to generate.
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const {generateKeyPairSync}=require('node:crypto');const {writeFileSync}=require('node:fs');const k=generateKeyPairSync('ed25519');writeFileSync(process.argv[1], k.privateKey.export({format:'pem',type:'pkcs8'}));`,
      join(tmpHome, '.ai-sdlc', 'signing-key.pem'),
    ],
    { encoding: 'utf-8' },
  );
  void out;
}

function runHelper(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf-8',
  });
}

// Hermetic copy of the signer under an isolated dir, so the node_modules
// walk-up from the script's own location cannot reach an ancestor checkout's
// hoisted @ai-sdlc install (e.g. a worktree nested inside the main checkout).
function isolatedHelperPath(base) {
  const dir = join(base, 'iso', 'plugin', 'scripts');
  mkdirSync(dir, { recursive: true });
  for (const f of ['sign-attestation.mjs', 'format-envelope-json.mjs']) {
    writeFileSync(join(dir, f), readFileSync(join(__dirname, f), 'utf-8'));
  }
  return join(dir, 'sign-attestation.mjs');
}

function runIsolatedHelper(base, cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [isolatedHelperPath(base), ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf-8',
  });
}

describe('sign-attestation.mjs', () => {
  let fixture;
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-home-'));
    fixture = setupRepo(tmpHome);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('DEC-0284: refuses to sign any schema other than v6 and names the decision', () => {
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, '[]');
    const base = ['--review-verdicts', verdictsPath, '--iteration-count', '1'];
    const cases = [
      [[...base, '--schema-version', 'v5'], {}],
      [[...base, '--schema-version', 'v3'], {}],
      [base, { AI_SDLC_V5_LEGACY: '1' }],
      [base, { AI_SDLC_V6_CUTOVER_ACTIVE: '0' }],
      [base, { AI_SDLC_SCHEMA_VERSION: 'v5' }],
    ];
    for (const [args, env] of cases) {
      const res = runHelper(fixture.root, args, { HOME: tmpHome, ...env });
      assert.notEqual(res.status, 0, JSON.stringify(env));
      assert.match(res.stderr, /v6 is the only schema signed or verified \(DEC-0284\)/);
    }
  });

  it('errors clearly when ~/.ai-sdlc/signing-key.pem is missing', () => {
    // No writeKey call — HOME has no signing-key.
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(
      verdictsPath,
      JSON.stringify([{ agentId: 'code-reviewer', harness: 'codex', approved: true }]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--task-id', 'AISDLC-1', '--iteration-count', '1'],
      { HOME: tmpHome },
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /No signing key at .*signing-key\.pem/);
    assert.match(res.stderr, /init-signing-key/);
  });

  // ── AISDLC-409: v6 default cutover (RFC-0042 Phase 3) ─────────────────
  //
  // Post-cutover, the signer defaults to schema v6 unless the operator opts
  // back to v5 via --schema-version v5, AI_SDLC_V5_LEGACY=1, or the legacy
  // AI_SDLC_V6_CUTOVER_ACTIVE=0.

  it('defaults to v6 schema post-AISDLC-409 cutover (fails without leaves)', () => {
    // v6 signing requires .ai-sdlc/transcript-leaves.jsonl with leaves for
    // the task. Without them, the signer errors with a v6-specific message —
    // which confirms the v6 code path was taken (not v5).
    writeKey(tmpHome);
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
      ]),
    );
    // Pass AI_SDLC_V5_LEGACY: '' to opt OUT of the cleanEnv default and let
    // the signer's true default (v6) take effect.
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--task-id', 'AISDLC-409', '--iteration-count', '1'],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com', AI_SDLC_V5_LEGACY: '' },
    );
    // Exit non-zero because v6 needs leaves and none are staged.
    assert.notEqual(res.status, 0);
    // Error message must reference v6 / leaves / merkle to confirm v6 path.
    const combined = `${res.stderr}\n${res.stdout}`;
    assert.match(
      combined,
      /v6|leaves|merkle/i,
      `expected v6-specific error, got stderr: ${res.stderr}\nstdout: ${res.stdout}`,
    );
  });

  // ── AISDLC-102: --print-content-hash oracle mode ──────────────────
  // Step 10.5 of the orchestrator calls this mode before and after a
  // pre-sign rebase to decide whether reviewers must re-run.

  it('--print-content-hash prints contentHash and exits 0 without writing files (AISDLC-102)', () => {
    // No --review-verdicts, no signing key required — pure read-only.
    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    // contentHash from AISDLC-94 is 64-hex-char sha256.
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/, 'should print sha256 hex');
    // No envelope must have been written.
    const attestationsDir = join(fixture.root, '.ai-sdlc', 'attestations');
    assert.ok(!existsSync(attestationsDir), 'must not write any attestations files');
  });

  it('--print-content-hash is deterministic across invocations on same content (AISDLC-102)', () => {
    // The AISDLC-94 contentHash binds to {path, blobSha} pairs sorted by
    // path — same files at same SHAs ⇒ same hash. This is the property
    // Step 10.5 relies on to decide "rebase didn't change anything."
    const res1 = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    const res2 = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res1.status, 0, `res1 stderr: ${res1.stderr}`);
    assert.equal(res2.status, 0, `res2 stderr: ${res2.stderr}`);
    assert.equal(
      res1.stdout.trim(),
      res2.stdout.trim(),
      'two consecutive invocations on identical content must produce identical hash',
    );
  });

  it('--print-content-hash detects content changes (AISDLC-102 re-review oracle)', () => {
    // The ORACLE: if contentHash changes after rebase, reviewers must
    // re-run. Simulate the file-content change case directly by mutating
    // the changed file and amending the commit, then re-hashing.
    const before = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(before.status, 0);
    const beforeHash = before.stdout.trim();

    // Mutate the changed file and amend the HEAD commit so origin/main...HEAD
    // diff now covers different content. fixture.headSha points at the prior
    // HEAD; the amend replaces it.
    writeFileSync(join(fixture.root, 'feature.txt'), 'feature MUTATED\n');
    git(['add', 'feature.txt'], fixture.root);
    git(['commit', '-q', '--amend', '--no-edit'], fixture.root);

    const after = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(after.status, 0);
    const afterHash = after.stdout.trim();
    assert.notEqual(
      beforeHash,
      afterHash,
      'mutating a changed file must change contentHash (re-review trigger)',
    );
  });

  // ── AISDLC-355 CRITICAL: findings array vs counts-object shape ───────────
  //
  // Three shapes must all produce correct per-severity counts in the predicate:
  //   1. Flat array with findings:[{severity,message},...] (new resume-from-draft shape)
  //   2. Nested {taskId, decision, verdicts:[{findings:[...]}]} (VerdictFilePayload)
  //   3. Legacy counts-object findings:{critical:N, major:N,...}

  // ── AISDLC-274: single-envelope-per-PR invariant ──────────────────────
});

// ── AISDLC-554: attestation runtime resolution in ADOPTER repos ──────
//
// The signer used to hardcode `<cwd>/orchestrator/dist/runtime/attestations.js`,
// a path that exists only inside the ai-sdlc monorepo. Every consumer repo got
// `not found. Run pnpm --filter @ai-sdlc/orchestrator build first` — advice
// that cannot succeed in a repo with no @ai-sdlc packages to build, so
// attestation was unreachable for adopters entirely.
//
// These tests drive the resolution order from a repo laid out the way an
// adopter's actually is. `--print-content-hash` is the probe because it
// exercises the same loader with no signing key required.

const REAL_RUNTIME = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');

/** Write a shim that re-exports the real built runtime at an arbitrary path. */
function writeRuntimeShim(target, body) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body ?? `export * from '${REAL_RUNTIME.replace(/\\/g, '\\\\')}';\n`);
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

describe('sign-attestation.mjs — adopter runtime resolution (AISDLC-554)', () => {
  let tmpHome;
  let base;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-home-'));
    // A private base dir, so the "hoisted node_modules" case can write a
    // parent-level node_modules without touching the shared tmpdir root.
    base = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-adopter-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('signs from a consumer repo with @ai-sdlc/orchestrator installed and NO monorepo dir', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    // An adopter repo has no orchestrator/ source tree — only the dependency.
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(installedRuntimePath(fixture.root));

    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    // Assert WHICH candidate won, not merely that some hash appeared — a
    // hash alone cannot distinguish "the intended copy resolved" from
    // "a different valid copy resolved".
    assert.ok(
      res.stderr.includes(installedRuntimePath(fixture.root)),
      `expected the repo-installed copy to resolve; stderr: ${res.stderr}`,
    );
  });

  it('resolves a node_modules hoisted ABOVE the repo root', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    // Installed one level up (workspace-root hoisting), not in the repo.
    writeRuntimeShim(installedRuntimePath(base));

    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.ok(
      res.stderr.includes(installedRuntimePath(base)),
      `expected the hoisted copy to resolve; stderr: ${res.stderr}`,
    );
  });

  it('prefers the monorepo build over an installed copy, so a stale build never hides behind a dependency', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    // setupRepo already wrote the monorepo-style runtime. Make the installed
    // copy detonate on import: reaching it at all is the failure being tested.
    writeRuntimeShim(
      installedRuntimePath(fixture.root),
      "throw new Error('installed copy must not win over the monorepo build');\n",
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
  });

  it('resolves the plugin runtimeDependency copy via CLAUDE_PLUGIN_ROOT, with nothing installed in the repo', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    // The adopter installs nothing: install-runtime-deps.sh put the runtime
    // in the plugin cache dir, which is what makes this zero-config.
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginDir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.ok(
      res.stderr.includes(installedRuntimePath(pluginDir)),
      `expected the plugin copy to resolve; stderr: ${res.stderr}`,
    );
  });

  it('prefers a repo-pinned copy over the plugin copy, so the repo controls the version', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(installedRuntimePath(fixture.root));
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(
      installedRuntimePath(pluginDir),
      "throw new Error('plugin copy must not win over the repo-pinned dependency');\n",
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginDir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
  });

  it('declares @ai-sdlc/orchestrator as a runtimeDependency so the plugin copy actually gets installed', () => {
    // The CLAUDE_PLUGIN_ROOT candidate above is only reachable because
    // install-runtime-deps.sh installs what plugin.json declares. Without this
    // entry the zero-config path silently degrades to the error case.
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'ai-sdlc-plugin', 'plugin.json'), 'utf-8'),
    );
    assert.ok(
      manifest.runtimeDependencies?.['@ai-sdlc/orchestrator'],
      'plugin.json must declare @ai-sdlc/orchestrator in runtimeDependencies',
    );
  });

  it('resolves via node_modules beside the script when no plugin env vars are set (git-hook context)', () => {
    // Git hooks do not inherit CLAUDE_PLUGIN_DIR/ROOT, and the pre-push
    // signing hook runs in exactly that context — so the script must find the
    // plugin's own install by walking up from its own location.
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    // Stage a copy of the signer inside a plugin-shaped directory.
    const fakePlugin = join(base, 'fakeplugin');
    mkdirSync(join(fakePlugin, 'scripts'), { recursive: true });
    const stagedHelper = join(fakePlugin, 'scripts', 'sign-attestation.mjs');
    writeFileSync(stagedHelper, readFileSync(helperPath, 'utf-8'));
    writeFileSync(
      join(fakePlugin, 'scripts', 'format-envelope-json.mjs'),
      readFileSync(join(__dirname, 'format-envelope-json.mjs'), 'utf-8'),
    );
    writeRuntimeShim(installedRuntimePath(fakePlugin));

    const res = spawnSync(process.execPath, [stagedHelper, '--print-content-hash'], {
      cwd: fixture.root,
      env: (() => {
        const env = cleanEnv({ HOME: tmpHome });
        delete env.CLAUDE_PLUGIN_DIR;
        delete env.CLAUDE_PLUGIN_ROOT;
        return env;
      })(),
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.match(res.stderr, /fakeplugin/);
  });

  it('rejects an installed copy older than the declared minimum instead of signing with it', () => {
    // A stale ancestor copy must not win by position alone: a
    // canonicalization-drifted signer produces envelopes CI rejects as if
    // tampered. The repo copy is stale; only the plugin copy is current.
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(
      installedRuntimePath(fixture.root),
      "throw new Error('stale copy must not be loaded');\n",
    );
    writeFileSync(
      join(fixture.root, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.13.9' }),
    );
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));
    writeFileSync(
      join(pluginDir, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.19.0' }),
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginDir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.match(res.stderr, /skipped stale @ai-sdlc\/orchestrator/);
  });

  it('rejects a copy in the AISDLC-574 regression window (0.16.0 passed the old [0,14,0] floor, must fail [0,19,0])', () => {
    // AISDLC-574: MIN_RUNTIME_VERSIONS was bumped from [0,14,0] to [0,19,0]
    // because 0.14.0-0.18.x predate the verdictClass/harnessTranscript
    // modules the plugin's producers depend on. 0.16.0 is the discriminating
    // case: it satisfied the OLD floor ([0,14,0]) but must be refused under
    // the NEW floor ([0,19,0]) — without this test, a future accidental
    // revert of MIN_RUNTIME_VERSIONS back to [0,14,0] would pass every other
    // boundary test in this file (which all use versions already below
    // 0.14.0) and go undetected.
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(
      installedRuntimePath(fixture.root),
      "throw new Error('0.16.0 copy must not be loaded under the 0.19.0 floor');\n",
    );
    writeFileSync(
      join(fixture.root, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.16.0' }),
    );
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));
    writeFileSync(
      join(pluginDir, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.19.0' }),
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginDir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.match(res.stderr, /skipped stale @ai-sdlc\/orchestrator.*0\.16\.0/);
  });

  it('accepts a copy exactly at the new 0.19.0 floor (positive side of the AISDLC-574 bump)', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(installedRuntimePath(fixture.root));
    writeFileSync(
      join(fixture.root, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.19.0' }),
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(res.stderr, /skipped stale @ai-sdlc\/orchestrator/);
  });

  it('treats a prerelease as below its release counterpart (0.19.0-beta.1 < 0.19.0)', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(
      installedRuntimePath(fixture.root),
      "throw new Error('prerelease copy must not satisfy the minimum');\n",
    );
    writeFileSync(
      join(fixture.root, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.19.0-beta.1' }),
    );
    const pluginDir = join(base, 'plugin');
    writeRuntimeShim(installedRuntimePath(pluginDir));
    writeFileSync(
      join(pluginDir, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/orchestrator', version: '0.19.0' }),
    );

    const res = runHelper(fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginDir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /skipped stale @ai-sdlc\/orchestrator.*0\.19\.0-beta\.1/);
  });

  it('says so when it accepts a copy whose version it could not verify', () => {
    // Fail-open is deliberate, but it must be distinguishable in the audit
    // trail from a copy that was checked and passed.
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });
    writeRuntimeShim(installedRuntimePath(fixture.root)); // no package.json alongside

    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /WITHOUT version verification/);
  });

  it('echoes which runtime copy signed, so resolution is auditable not silent', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /\[sign-attestation\] attestation runtime: .*attestations\.js/);
  });

  it('fails with adopter-actionable guidance when the runtime is absent everywhere', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });

    const res = runIsolatedHelper(base, fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.notEqual(res.status, 0);
    // The pre-AISDLC-554 message offered ONLY the monorepo build, which an
    // adopter cannot run. Both routes must be named.
    assert.match(res.stderr, /pnpm add -D @ai-sdlc\/orchestrator/);
    assert.match(res.stderr, /pnpm --filter @ai-sdlc\/orchestrator build/);
    // And it must show where it looked, so the gap is diagnosable without
    // reading the signer's source.
    assert.match(res.stderr, /node_modules[/\\]@ai-sdlc[/\\]orchestrator/);
  });

  it('never silently substitutes a re-implementation when the runtime is missing', () => {
    const root = join(base, 'app');
    const fixture = setupRepo(tmpHome, root);
    rmSync(join(fixture.root, 'orchestrator'), { recursive: true, force: true });

    const res = runIsolatedHelper(base, fixture.root, ['--print-content-hash'], {
      HOME: tmpHome,
    });
    // A fallback hash would verify as tampering downstream — the signer must
    // emit nothing at all rather than an envelope the real verifier rejects.
    assert.notEqual(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });
});

describe('format-envelope-json (AISDLC-732)', () => {
  it('matches prettier for the shapes envelopes contain (single-element arrays collapse)', async () => {
    const { formatEnvelopeJson } = await import('./format-envelope-json.mjs');
    const h = 'a'.repeat(64);
    const value = {
      single: [h],
      pair: [h, h],
      // Fits in 100 columns on its own but not once the key prefix is counted (AISDLC-820).
      triggeringPaths: [
        'scripts/check-attestation-sign.test.mjs',
        'scripts/squash-attestation-chores.sh',
      ],
      empty: [],
      obj: {},
      leaves: [{ leafIndex: 0, proof: [h] }],
      nested: [
        [1, 2],
        [3, 4],
      ],
    };
    const dir = mkdtempSync(join(repoRoot, '.fmt-732-'));
    try {
      const file = join(dir, 'x.json');
      writeFileSync(file, formatEnvelopeJson(value));
      const check = spawnSync(
        join(repoRoot, 'node_modules', '.bin', 'prettier'),
        PRETTIER_ARGS.concat(['--check', file]),
        { encoding: 'utf8' },
      );
      assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips envelopes signed before the change without altering their content', async () => {
    const { formatEnvelopeJson } = await import('./format-envelope-json.mjs');
    const dir = join(repoRoot, '.ai-sdlc', 'attestations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.dsse.json'))
      .slice(0, 25);
    assert.ok(files.length > 0, 'expected existing envelopes to test against');
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      // Verifiers JSON.parse the envelope and check the signed payload, never the
      // outer whitespace, so identical parsed content means identical verification.
      assert.deepEqual(JSON.parse(formatEnvelopeJson(JSON.parse(text))), JSON.parse(text));
    }
  });
});
