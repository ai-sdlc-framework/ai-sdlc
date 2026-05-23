/**
 * Tests for `scripts/check-dor-gate.sh` — AISDLC-370.
 *
 * The script is invoked from `.husky/pre-push` AFTER attestation-bundle-sync
 * and BEFORE attestation-sign. It reads git's pre-push stdin protocol,
 * computes the push range, finds touched `backlog/{tasks,completed}/*.md`
 * files, and runs `cli-dor-check --task <path>` against each. Non-zero
 * exit aborts the push.
 *
 * These tests exercise the bash wrapper end-to-end against the REAL
 * pipeline-cli bin. The wrapper no-ops when the bin or dist isn't built
 * — those cases skip rather than fail so the test suite stays usable
 * before a first `pnpm build`.
 *
 * Run with: node --test scripts/check-dor-gate.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(__dirname, 'check-dor-gate.sh');
const REAL_BIN = join(REPO_ROOT, 'pipeline-cli', 'bin', 'cli-dor-check.mjs');
const REAL_DIST = join(REPO_ROOT, 'pipeline-cli', 'dist', 'cli', 'dor-check.js');

const HAS_BIN = existsSync(REAL_BIN) && existsSync(REAL_DIST);
const ZEROS = '0000000000000000000000000000000000000000';

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_DOR_GATE;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepoWithSymlinkedBin() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-dor-gate-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  // Bind in scripts/ and pipeline-cli/ from the real repo so the bash
  // wrapper can find the bin + dist. We symlink rather than copy so any
  // edits to the source land in the test invocation immediately.
  mkdirSync(join(root, 'scripts'));
  symlinkSync(SCRIPT, join(root, 'scripts', 'check-dor-gate.sh'));
  mkdirSync(join(root, 'pipeline-cli'));
  symlinkSync(join(REPO_ROOT, 'pipeline-cli', 'bin'), join(root, 'pipeline-cli', 'bin'));
  symlinkSync(join(REPO_ROOT, 'pipeline-cli', 'dist'), join(root, 'pipeline-cli', 'dist'));
  symlinkSync(
    join(REPO_ROOT, 'pipeline-cli', 'node_modules'),
    join(root, 'pipeline-cli', 'node_modules'),
  );
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));

  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', 'README.md'], root);
  git(['commit', '-q', '-m', 'baseline'], root);

  return root;
}

function writeTaskFile(root, id, body) {
  const dir = join(root, 'backlog', 'tasks');
  mkdirSync(dir, { recursive: true });
  const filename = `${id.toLowerCase()} - test.md`;
  const path = join(dir, filename);
  writeFileSync(path, body);
  return path;
}

function runGate(root, pushStdin) {
  const r = spawnSync('bash', [join('scripts', 'check-dor-gate.sh')], {
    cwd: root,
    env: cleanEnv(),
    input: pushStdin,
    encoding: 'utf-8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const CLEAN_TASK = `---
id: AISDLC-9001
title: 'test: clean task'
status: To Do
priority: low
references: []
---

## Problem
Need to implement the feature so users can do the thing.

## Design
The implementation lives in src/feature.ts.

## Acceptance criteria
- [ ] src/feature.ts exists with the expected named exports
- [ ] Unit test covers the happy path and one edge case
`;

const GATE2_MARKER_TASK = `---
id: AISDLC-9002
title: 'test: task with placeholder marker'
status: To Do
priority: low
references: []
---

## Problem
We need to do XXX before shipping.

## Acceptance criteria
- [ ] Fix the placeholder
`;

describe('check-dor-gate.sh (AISDLC-370)', () => {
  let root;
  beforeEach(() => {
    root = setupRepoWithSymlinkedBin();
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('exit 0 immediately with AI_SDLC_BYPASS_ALL_GATES=1 even when violations exist', () => {
    const path = writeTaskFile(root, 'aisdlc-9002', GATE2_MARKER_TASK);
    git(['add', path], root);
    git(['commit', '-q', '-m', 'feat: bad task'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();

    const r = spawnSync('bash', [join('scripts', 'check-dor-gate.sh')], {
      cwd: root,
      env: cleanEnv({ AI_SDLC_BYPASS_ALL_GATES: '1' }),
      input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, `expected exit 0 with bypass, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('AI_SDLC_BYPASS_ALL_GATES=0 does NOT bypass (falls through to normal logic)', () => {
    // When not set to 1, the bypass block must not fire; normal no-op for empty push.
    const r = spawnSync('bash', [join('scripts', 'check-dor-gate.sh')], {
      cwd: root,
      env: cleanEnv({ AI_SDLC_BYPASS_ALL_GATES: '0' }),
      input: '',
      encoding: 'utf-8',
    });
    // Empty stdin → no task files → normal exit 0 (not via bypass).
    assert.equal(
      r.status,
      0,
      `expected exit 0 (no-task-changes path), got ${r.status}: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('exit 0 with AI_SDLC_SKIP_DOR_GATE=1 even when violations exist', () => {
    const path = writeTaskFile(root, 'aisdlc-9002', GATE2_MARKER_TASK);
    git(['add', path], root);
    git(['commit', '-q', '-m', 'feat: bad task'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();

    const r = spawnSync('bash', [join('scripts', 'check-dor-gate.sh')], {
      cwd: root,
      env: cleanEnv({ AI_SDLC_SKIP_DOR_GATE: '1' }),
      input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /skipping/i);
  });

  it('exit 0 when push range has no backlog task changes', () => {
    writeFileSync(join(root, 'src.txt'), 'code\n');
    git(['add', 'src.txt'], root);
    git(['commit', '-q', '-m', 'feat: non-task change'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();

    const r = runGate(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(r.code, 0);
  });

  it('exit 0 when push stdin is empty (no refs to push)', () => {
    const r = runGate(root, '');
    assert.equal(r.code, 0);
  });

  it('exit 0 on deletion push (LOCAL_SHA is zeros)', () => {
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const r = runGate(root, `refs/heads/old ${ZEROS} refs/heads/old ${head}\n`);
    assert.equal(r.code, 0);
  });

  if (HAS_BIN) {
    it('exit 0 on a DoR-clean task file', () => {
      const path = writeTaskFile(root, 'aisdlc-9001', CLEAN_TASK);
      git(['add', path], root);
      git(['commit', '-q', '-m', 'feat: clean task'], root);
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const base = git(['rev-parse', 'HEAD~1'], root).trim();

      const r = runGate(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(r.code, 0, `gate output: ${r.stdout}\n${r.stderr}`);
    });

    it('exit 1 on a task with a gate-2 placeholder marker (XXX)', () => {
      const path = writeTaskFile(root, 'aisdlc-9002', GATE2_MARKER_TASK);
      git(['add', path], root);
      git(['commit', '-q', '-m', 'feat: bad task'], root);
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const base = git(['rev-parse', 'HEAD~1'], root).trim();

      const r = runGate(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(
        r.code,
        1,
        `expected gate to BLOCK but it passed. output: ${r.stdout}\n${r.stderr}`,
      );
      assert.match(r.stdout, /Gate 2/);
      assert.match(r.stdout, /XXX|placeholder/i);
    });

    it('exit 1 when bin/dist missing AND push touches backlog tasks (AISDLC-378)', () => {
      // Simulate fresh worktree by removing the symlinked dist directory.
      // The push range INCLUDES a backlog task file, so this must fail loud
      // — silently skipping here is what allowed the 2026-05-20 incident
      // to ship 5 violating task files past the gate.
      const distDir = join(root, 'pipeline-cli', 'dist');
      rmSync(distDir, { recursive: true, force: true });
      mkdirSync(distDir, { recursive: true });
      // Note: dist/cli/dor-check.js is now absent.

      const path = writeTaskFile(root, 'aisdlc-9002', GATE2_MARKER_TASK);
      git(['add', path], root);
      git(['commit', '-q', '-m', 'feat: bad task'], root);
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const base = git(['rev-parse', 'HEAD~1'], root).trim();

      const r = runGate(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(r.code, 1, `expected exit 1 (fail loud), got: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /pipeline-cli is not built/);
      assert.match(r.stderr, /pnpm --filter @ai-sdlc\/pipeline-cli build/);
    });

    it('exit 0 when bin/dist missing AND push has NO task changes (fresh worktree)', () => {
      // Even without dist, a push of unrelated code (no backlog tasks)
      // should still silently no-op so first-build pushes aren't blocked.
      const distDir = join(root, 'pipeline-cli', 'dist');
      rmSync(distDir, { recursive: true, force: true });
      mkdirSync(distDir, { recursive: true });

      writeFileSync(join(root, 'src.txt'), 'code\n');
      git(['add', 'src.txt'], root);
      git(['commit', '-q', '-m', 'feat: non-task change'], root);
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const base = git(['rev-parse', 'HEAD~1'], root).trim();

      const r = runGate(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(
        r.code,
        0,
        `expected silent no-op (no task changes), got: ${r.stdout}\n${r.stderr}`,
      );
    });
  } else {
    it.skip('skipped: pipeline-cli bin/dist not built (run pnpm build first)', () => {});
  }
});
