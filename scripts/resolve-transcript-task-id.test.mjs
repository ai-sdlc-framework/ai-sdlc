/**
 * Tests for `scripts/resolve-transcript-task-id.sh` — AISDLC-562.
 *
 * The script is the single point of TASK_ID resolution shared by the Bash-
 * capable reviewer subagents (code-reviewer, test-reviewer, and their -codex
 * variants). It exists to eliminate the silent 'UNKNOWN' fallback that let
 * unrelated reviewer runs collide on `.ai-sdlc/transcripts/UNKNOWN/` and
 * overwrite each other's evidence.
 *
 * Hermetic: every test runs the script against a mkdtemp'd cwd — never a
 * shared /tmp marker path (AISDLC feedback: shared-tmp pollution incident).
 *
 * Run with: node --test scripts/resolve-transcript-task-id.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'resolve-transcript-task-id.sh');

/** Fresh scratch dir per test — never a shared /tmp marker path. */
function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'ai-sdlc-resolve-transcript-task-id-'));
}

/** Run the script with a clean env (no TASK_ID / AI_SDLC_ACTIVE_TASK_ID bleed from the host). */
function run(cwd, args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.TASK_ID;
  delete env.AI_SDLC_ACTIVE_TASK_ID;
  Object.assign(env, extraEnv);
  return spawnSync('bash', [SCRIPT, ...args], { cwd, env, encoding: 'utf-8' });
}

describe('resolve-transcript-task-id.sh — attribution sources', () => {
  it('resolves from the .active-task sentinel file', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-562\n');
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-562');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims whitespace from the .active-task file content', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '  AISDLC-562  \n\n');
      const result = run(dir, ['test-reviewer']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-562');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves from AI_SDLC_ACTIVE_TASK_ID when no sentinel file exists', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-999' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-999');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves from TASK_ID env var, taking precedence over the sentinel file', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-100');
      const result = run(dir, ['code-reviewer'], { TASK_ID: 'AISDLC-200' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-200');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the sentinel file over AI_SDLC_ACTIVE_TASK_ID', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-100');
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-200' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-100');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — no-sentinel case (AC #1, #3)', () => {
  it('refuses (non-zero exit) when no attribution source resolves', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer']);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, ''); // never prints a fabricated task id
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error names the .active-task sentinel as a remedy (AC #3)', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['test-reviewer']);
      assert.match(result.stderr, /\.active-task/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error names AI_SDLC_ACTIVE_TASK_ID as a remedy (AC #3)', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['test-reviewer']);
      assert.match(result.stderr, /AI_SDLC_ACTIVE_TASK_ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error names the calling reviewer so operators know which run failed', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['security-reviewer-example']);
      assert.match(result.stderr, /security-reviewer-example/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes a fallback directory (e.g. UNKNOWN/) as a side effect', () => {
    const dir = scratchDir();
    try {
      run(dir, ['code-reviewer']);
      assert.equal(existsSync(join(dir, '.ai-sdlc')), false);
      assert.equal(existsSync(join(dir, 'UNKNOWN')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty .active-task file is treated as unattributable, not as an empty task id', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '');
      const result = run(dir, ['code-reviewer']);
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a reviewer-name argument', () => {
    const dir = scratchDir();
    try {
      const result = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf-8' });
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — collision case (AC #2)', () => {
  it('two concurrent unattributed runs in different worktrees both refuse — neither writes a shared path', () => {
    const dirA = scratchDir();
    const dirB = scratchDir();
    try {
      // Simulate two separate reviewer subagent runs (e.g. against
      // .worktrees/aisdlc-557/ and .worktrees/aisdlc-559/ from the incident
      // report) that both lack a .active-task sentinel.
      const resultA = run(dirA, ['code-reviewer']);
      const resultB = run(dirB, ['test-reviewer']);

      assert.notEqual(resultA.status, 0);
      assert.notEqual(resultB.status, 0);
      // Neither run printed a task id at all (let alone the SAME one), so a
      // caller that naively did `mkdir -p .ai-sdlc/transcripts/$TASK_ID`
      // right after this script has nothing to collide on.
      assert.equal(resultA.stdout, '');
      assert.equal(resultB.stdout, '');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('two DIFFERENT attributed runs never resolve to the same task id from different sentinels', () => {
    const dirA = scratchDir();
    const dirB = scratchDir();
    try {
      writeFileSync(join(dirA, '.active-task'), 'AISDLC-557');
      writeFileSync(join(dirB, '.active-task'), 'AISDLC-559');

      const resultA = run(dirA, ['code-reviewer']);
      const resultB = run(dirB, ['code-reviewer']);

      assert.equal(resultA.status, 0);
      assert.equal(resultB.status, 0);
      assert.notEqual(resultA.stdout.trim(), resultB.stdout.trim());
      assert.equal(resultA.stdout.trim(), 'AISDLC-557');
      assert.equal(resultB.stdout.trim(), 'AISDLC-559');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('a worktree with a sentinel and a sibling worktree without one never fall back to a shared UNKNOWN path', () => {
    const attributed = scratchDir();
    const unattributed = scratchDir();
    try {
      writeFileSync(join(attributed, '.active-task'), 'AISDLC-562');

      const good = run(attributed, ['code-reviewer']);
      const bad = run(unattributed, ['code-reviewer']);

      assert.equal(good.status, 0);
      assert.equal(good.stdout.trim(), 'AISDLC-562');
      assert.notEqual(bad.status, 0);
      assert.equal(bad.stdout, '');
    } finally {
      rmSync(attributed, { recursive: true, force: true });
      rmSync(unattributed, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — script hygiene', () => {
  it('is executable', () => {
    // Guards against a chmod regression breaking direct invocation (agents
    // invoke it as `bash scripts/resolve-transcript-task-id.sh ...`, but the
    // executable bit should still be set for direct-invocation callers).
    const result = spawnSync('test', ['-x', SCRIPT]);
    assert.equal(result.status, 0);
  });
});
