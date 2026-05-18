/**
 * Tests for `scripts/check-mcp-bundle-sync.sh` — AISDLC-357.
 *
 * The script is invoked from `.husky/pre-push` AFTER check-task-moved.sh and
 * BEFORE check-attestation-sign.sh. It detects when commits in the push range
 * touch `pipeline-cli/src/**`, rebuilds the mcp-server bundle, and auto-commits
 * the new bundle if it changed.
 *
 * The build command is overridable via AI_SDLC_MCP_BUILD_CMD so we stub it
 * with a tiny shell script that writes a fake dist/bin.js. This keeps the
 * tests hermetic — no real pnpm build required.
 *
 * Run with: node --test scripts/check-mcp-bundle-sync.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-mcp-bundle-sync.sh');

/** Project root (for reading .husky/pre-push in the order assertion test). */
const PROJECT_ROOT = join(__dirname, '..');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.AI_SDLC_SKIP_MCP_BUNDLE_SYNC;
  delete env.AI_SDLC_MCP_BUILD_CMD;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

/**
 * Set up a minimal git repo with the required directory structure.
 * Returns the repo root path.
 */
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-mcp-bundle-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  // Create the pipeline-cli/src directory structure.
  mkdirSync(join(root, 'pipeline-cli', 'src'), { recursive: true });

  // Create the mcp-server/dist directory.
  mkdirSync(join(root, 'ai-sdlc-plugin', 'mcp-server', 'dist'), { recursive: true });

  // Write the initial (stale) bundle.
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'mcp-server', 'dist', 'bin.js'),
    '#!/usr/bin/env node\n// stale bundle v1\n',
  );

  // Baseline commit so HEAD exists.
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Set up origin/main ref so the hook can compute merge-base.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/**
 * Install a fake build command that overwrites dist/bin.js with new content.
 * Returns the command string for AI_SDLC_MCP_BUILD_CMD.
 *
 * @param {string} root        worktree root
 * @param {object} opts
 * @param {boolean} [opts.fail=false]    exits non-zero (simulates build failure)
 * @param {boolean} [opts.noop=false]    exits 0 but does NOT change bin.js
 *   (simulates rebuild with identical output — bundle was already current)
 * @param {string} [opts.newContent]     content to write into dist/bin.js
 */
function installFakeBuild(root, { fail = false, noop = false, newContent } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'build.log');
  const shimPath = join(binDir, 'fake-build.sh');
  const distBin = join(root, 'ai-sdlc-plugin', 'mcp-server', 'dist', 'bin.js');

  const content = newContent ?? '#!/usr/bin/env node\n// rebuilt bundle v2\n';

  const failBlock = fail ? 'exit 7' : '';
  const writeBlock = noop
    ? '# noop mode: do not change the file'
    : `printf '%s' "${content}" > "${distBin}"`;

  const shim = `#!/usr/bin/env bash
echo "fake-build $*" >> "${logPath}"
${failBlock}
${writeBlock}
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { cmd: `bash ${shimPath}`, logPath };
}

/**
 * Run the hook script. Provides stdin with push info as husky would.
 */
function runHook(cwd, { localSha, remoteSha, env = {} } = {}) {
  const NULL_SHA = '0000000000000000000000000000000000000000';
  const resolvedLocalSha =
    localSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
  const resolvedRemoteSha = remoteSha ?? NULL_SHA;
  const stdinData = `refs/heads/main ${resolvedLocalSha} refs/remotes/origin/main ${resolvedRemoteSha}\n`;

  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(env),
    input: stdinData,
    encoding: 'utf-8',
  });
}

describe('check-mcp-bundle-sync.sh (AISDLC-357)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── (a) pipeline-cli change → stale bundle → auto-rebuild + commit ───

  it('(a) pipeline-cli/src change in push range with stale bundle → rebuilds + commits + exits 1', () => {
    // Stage a pipeline-cli/src change.
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli (AISDLC-357)'], root);

    const devHead = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd } = installFakeBuild(root);

    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });

    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /re-run `git push`|bundle was stale|auto-rebuild/i);

    // A new chore commit must have landed on top.
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /chore: auto-rebuild mcp-server bundle/i);

    // The chore commit must not be the same as the dev commit.
    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(choreHead, devHead, 'chore commit must be a NEW commit on top');

    // dist/bin.js must have been staged + committed.
    const committedFiles = git(['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], root);
    assert.match(
      committedFiles,
      /ai-sdlc-plugin\/mcp-server\/dist\/bin\.js/,
      'dist/bin.js must be in the chore commit',
    );
  });

  // ── (b) pipeline-cli change + bundle already rebuilt → no-op ─────────

  it('(b) pipeline-cli change in push range but bundle already current → exits 0 silently', () => {
    // Stage a pipeline-cli/src change.
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli (AISDLC-357)'], root);

    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    // Install a no-op build that does NOT change the bundle content.
    const { cmd } = installFakeBuild(root, { noop: true });

    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });

    assert.equal(r.status, 0, `expected 0 (bundle already current), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /bundle already current|hashes match/i);

    // No new commit must land.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when bundle already current');
  });

  // ── (c) No pipeline-cli changes → hook is a no-op ────────────────────

  it('(c) no pipeline-cli/src changes in push range → exits 0 without running build', () => {
    // Stage a non-pipeline-cli change.
    writeFileSync(join(root, 'README.md'), 'updated\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'docs: update readme'], root);

    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeBuild(root);

    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });

    assert.equal(r.status, 0, `expected 0 (no pipeline-cli changes), got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), false, 'build must NOT run when no pipeline-cli/src changes');
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when no pipeline-cli/src changes');
  });

  // ── (d) Skip env var ─────────────────────────────────────────────────

  it('(d) AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 short-circuits with exit 0 even when rebuild is needed', () => {
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli'], root);

    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeBuild(root);

    const r = runHook(root, {
      env: { AI_SDLC_MCP_BUILD_CMD: cmd, AI_SDLC_SKIP_MCP_BUNDLE_SYNC: '1' },
    });

    assert.equal(r.status, 0, `expected 0 with deferral, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1/);
    assert.equal(existsSync(logPath), false, 'build must NOT run under deferral');
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change with deferral');
  });

  // ── (e) Build failure → exits 2 ──────────────────────────────────────

  it('(e) exits 2 with ERROR message when build fails', () => {
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli'], root);

    const { cmd } = installFakeBuild(root, { fail: true });

    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });

    assert.equal(r.status, 2, `expected 2 (build failure), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ERROR.*build.*failed|build.*failed/i);
  });

  // ── (f) Idempotent second push ────────────────────────────────────────

  it('(f) idempotent — second push exits 0 after chore commit is on HEAD', () => {
    // First push cycle: hook detects stale bundle + commits.
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli'], root);

    const { cmd } = installFakeBuild(root);
    const r1 = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });
    assert.equal(r1.status, 1, `first push: expected 1, got ${r1.status}: ${r1.stderr}`);

    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    const choreSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(choreSubject, /chore: auto-rebuild mcp-server bundle/i);

    // Second push: HEAD is the chore commit. Hook must exit 0 without committing again.
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();
    const r2 = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });
    assert.equal(
      r2.status,
      0,
      `second push (HEAD is chore commit) must be a no-op; got ${r2.status}: ${r2.stderr}`,
    );

    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `second push must NOT add another chore commit (${commitCountBefore} -> ${commitCountAfter})`,
    );
    // HEAD must still be the chore commit.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, choreHead, 'HEAD must remain the chore commit after second push');
  });

  // ── (g) Load-bearing order assertion ─────────────────────────────────

  it('(g) .husky/pre-push invokes check-mcp-bundle-sync.sh AFTER check-task-moved.sh and BEFORE check-attestation-sign.sh', () => {
    const prePushPath = join(PROJECT_ROOT, '.husky', 'pre-push');
    assert.equal(existsSync(prePushPath), true, `.husky/pre-push must exist at ${prePushPath}`);

    const content = readFileSync(prePushPath, 'utf-8');
    const lines = content.split('\n');

    const taskMoveIdx = lines.findIndex((l) => l.includes('check-task-moved.sh'));
    const mcpBundleIdx = lines.findIndex((l) => l.includes('check-mcp-bundle-sync.sh'));
    const attestationIdx = lines.findIndex((l) => l.includes('check-attestation-sign.sh'));

    assert.ok(
      taskMoveIdx !== -1,
      `check-task-moved.sh must be present in .husky/pre-push:\n${content}`,
    );
    assert.ok(
      mcpBundleIdx !== -1,
      `check-mcp-bundle-sync.sh must be present in .husky/pre-push:\n${content}`,
    );
    assert.ok(
      attestationIdx !== -1,
      `check-attestation-sign.sh must be present in .husky/pre-push:\n${content}`,
    );

    assert.ok(
      taskMoveIdx < mcpBundleIdx,
      `check-task-moved.sh (line ${taskMoveIdx + 1}) must appear BEFORE check-mcp-bundle-sync.sh (line ${mcpBundleIdx + 1})`,
    );
    assert.ok(
      mcpBundleIdx < attestationIdx,
      `check-mcp-bundle-sync.sh (line ${mcpBundleIdx + 1}) must appear BEFORE check-attestation-sign.sh (line ${attestationIdx + 1}) — order is load-bearing: attestation binds {path, headBlobSha}; bundle rebuild must happen before sign`,
    );
  });

  // ── (h) Chore commit must not carry CI-skip tokens (AISDLC-88) ───────

  it('(h) chore commit body does NOT contain a CI-skip magic token (AISDLC-88 contract)', () => {
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli'], root);

    const { cmd } = installFakeBuild(root);
    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });
    assert.equal(r.status, 1);

    const body = git(['log', '-1', '--format=%B', 'HEAD'], root);
    for (const tok of ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']) {
      assert.equal(
        body.toLowerCase().includes(tok.toLowerCase()),
        false,
        `chore commit body must not contain "${tok}": ${body}`,
      );
    }
  });

  // ── (i) Re-push hint mentions the escape hatch ────────────────────────

  it('(i) re-push hint mentions the AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 escape hatch', () => {
    writeFileSync(join(root, 'pipeline-cli', 'src', 'index.ts'), '// change\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: update pipeline-cli'], root);

    const { cmd } = installFakeBuild(root);
    const r = runHook(root, { env: { AI_SDLC_MCP_BUILD_CMD: cmd } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1/);
  });
});
