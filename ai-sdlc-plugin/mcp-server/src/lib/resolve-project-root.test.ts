import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROJECT_ROOT_ERROR_MESSAGE,
  PATTERN_C_ERROR_MESSAGE,
  resolveProjectRoot,
  isPatternCParent,
  resolveActiveTaskId,
  applyPatternCIfNeeded,
} from './resolve-project-root.js';

/**
 * Tests for AISDLC-99: env-var-with-cwd-fallback project-root discovery.
 *
 * Covers the four enumerated paths:
 *   1. env-var set correctly  → use the env var
 *   2. env-var set wrong      → fall back to walking up from cwd
 *   3. env-var unset          → fall back to walking up from cwd
 *   4. neither resolves       → throw the canonical error
 */
describe('resolveProjectRoot (AISDLC-99)', () => {
  let scratch: string;
  let goodProject: string;
  let nestedDir: string;
  let bogusDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-99-resolve-'));

    // A valid "project root": a dir with a backlog/ subdir.
    goodProject = join(scratch, 'good-project');
    mkdirSync(join(goodProject, 'backlog', 'tasks'), { recursive: true });

    // A nested dir three levels deep inside the good project. Used to test
    // walk-up-from-cwd discovery.
    nestedDir = join(goodProject, 'src', 'a', 'b', 'c');
    mkdirSync(nestedDir, { recursive: true });

    // A directory with no backlog/ subdir, used as the "wrong env var" target
    // (mirrors the real-world plugin bug where AI_SDLC_PROJECT_ROOT points at
    // ~/.claude/plugins/data/<plugin>/, which has no backlog/).
    bogusDir = join(scratch, 'bogus');
    mkdirSync(bogusDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('uses AI_SDLC_PROJECT_ROOT when it is set and valid (AC #1)', () => {
    const result = resolveProjectRoot({
      env: { AI_SDLC_PROJECT_ROOT: goodProject },
      cwd: '/tmp', // intentionally unrelated — env var should win
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('falls back to walking up from cwd when AI_SDLC_PROJECT_ROOT points at a dir without backlog/ (AC #1, AC #3)', () => {
    const result = resolveProjectRoot({
      env: { AI_SDLC_PROJECT_ROOT: bogusDir },
      cwd: nestedDir,
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('falls back to walking up from cwd when AI_SDLC_PROJECT_ROOT is unset (AC #1, AC #3)', () => {
    const result = resolveProjectRoot({
      env: {},
      cwd: nestedDir,
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('uses CLAUDE_PROJECT_DIR when AI_SDLC_PROJECT_ROOT is unset (precedence)', () => {
    // CLAUDE_PROJECT_DIR is a recognised secondary signal — Claude Code sets
    // it when a session is bound to a project. We honour it ahead of the
    // walk-up so explicit configuration always wins over discovery.
    const result = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: goodProject },
      cwd: '/tmp',
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('treats AI_SDLC_PROJECT_ROOT pointing at a non-existent path as unset', () => {
    const ghost = join(scratch, 'does-not-exist');
    const result = resolveProjectRoot({
      env: { AI_SDLC_PROJECT_ROOT: ghost },
      cwd: nestedDir,
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('treats AI_SDLC_PROJECT_ROOT pointing at a file (not a dir) as unset', () => {
    const filePath = join(scratch, 'not-a-dir.txt');
    writeFileSync(filePath, 'x', 'utf-8');
    const result = resolveProjectRoot({
      env: { AI_SDLC_PROJECT_ROOT: filePath },
      cwd: nestedDir,
    });
    expect(result).toBe(resolve(goodProject));
  });

  it('finds the closest backlog/ ancestor when nested projects exist', () => {
    // Inner project has its own backlog/. Walking up from `inner/src` should
    // stop at `inner`, not at the outer goodProject.
    const inner = join(goodProject, 'inner');
    mkdirSync(join(inner, 'backlog', 'tasks'), { recursive: true });
    const innerSrc = join(inner, 'src', 'deep');
    mkdirSync(innerSrc, { recursive: true });

    const result = resolveProjectRoot({
      env: {},
      cwd: innerSrc,
    });
    expect(result).toBe(resolve(inner));
  });

  it('throws the canonical error when neither env vars nor cwd-walk yield a backlog/ (AC #3)', () => {
    // cwd is the scratch root which is a sibling of bogusDir/goodProject —
    // so walking up from scratch never sees backlog/ (its parent is the OS
    // tmpdir).
    expect(() =>
      resolveProjectRoot({
        env: {},
        cwd: scratch,
      }),
    ).toThrow(PROJECT_ROOT_ERROR_MESSAGE);
  });

  it('exports a stable error message for callers to match against', () => {
    expect(PROJECT_ROOT_ERROR_MESSAGE).toMatch(/AI_SDLC_PROJECT_ROOT/);
    expect(PROJECT_ROOT_ERROR_MESSAGE).toMatch(/backlog\//);
  });
});

/**
 * Tests for AISDLC-216: Pattern C detection and worktree routing.
 *
 * Pattern C: parent repo has a .worktrees/ directory with at least one
 * worktree subdir. Writes must be routed to the active worktree, not the
 * parent's read-only working tree.
 */
describe('isPatternCParent (AISDLC-216)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-216-pattern-c-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns false when .worktrees/ does not exist', () => {
    mkdirSync(join(scratch, 'backlog', 'tasks'), { recursive: true });
    expect(isPatternCParent(scratch)).toBe(false);
  });

  it('returns false when .worktrees/ exists but is empty', () => {
    mkdirSync(join(scratch, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(scratch, '.worktrees'), { recursive: true });
    expect(isPatternCParent(scratch)).toBe(false);
  });

  it('returns true when .worktrees/ contains at least one subdirectory (AC #1)', () => {
    mkdirSync(join(scratch, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(scratch, '.worktrees', 'aisdlc-99'), { recursive: true });
    expect(isPatternCParent(scratch)).toBe(true);
  });

  it('ignores files inside .worktrees/ (only counts directories)', () => {
    mkdirSync(join(scratch, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(scratch, '.worktrees'), { recursive: true });
    writeFileSync(join(scratch, '.worktrees', 'not-a-dir.txt'), 'x', 'utf-8');
    expect(isPatternCParent(scratch)).toBe(false);
  });
});

describe('resolveActiveTaskId (AISDLC-216)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-216-active-task-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns undefined when no signal is present', () => {
    expect(resolveActiveTaskId(scratch, {})).toBeUndefined();
  });

  it('reads AI_SDLC_ACTIVE_TASK_ID env var (lower-cased) (AC #4)', () => {
    expect(resolveActiveTaskId(scratch, { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-216' })).toBe(
      'aisdlc-216',
    );
  });

  it('trims whitespace from AI_SDLC_ACTIVE_TASK_ID', () => {
    expect(resolveActiveTaskId(scratch, { AI_SDLC_ACTIVE_TASK_ID: '  AISDLC-216  ' })).toBe(
      'aisdlc-216',
    );
  });

  it('reads .active-task sentinel file when env var is absent (AC #3 signal path)', () => {
    writeFileSync(join(scratch, '.active-task'), 'AISDLC-216\n', 'utf-8');
    expect(resolveActiveTaskId(scratch, {})).toBe('aisdlc-216');
  });

  it('prefers env var over .active-task file', () => {
    writeFileSync(join(scratch, '.active-task'), 'AISDLC-999\n', 'utf-8');
    expect(resolveActiveTaskId(scratch, { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-216' })).toBe(
      'aisdlc-216',
    );
  });

  it('returns undefined when .active-task file is empty', () => {
    writeFileSync(join(scratch, '.active-task'), '   \n', 'utf-8');
    expect(resolveActiveTaskId(scratch, {})).toBeUndefined();
  });
});

describe('applyPatternCIfNeeded (AISDLC-216)', () => {
  let scratch: string;
  let parentRoot: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-216-apply-'));

    // Set up a realistic Pattern C parent: has backlog/ + .worktrees/<task>/
    parentRoot = join(scratch, 'parent-repo');
    mkdirSync(join(parentRoot, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(parentRoot, '.worktrees', 'aisdlc-216', 'backlog', 'tasks'), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns root unchanged when NOT a Pattern C parent', () => {
    const plain = join(scratch, 'plain-repo');
    mkdirSync(join(plain, 'backlog', 'tasks'), { recursive: true });
    expect(applyPatternCIfNeeded(plain, {})).toBe(plain);
  });

  it('throws Pattern C error when no active-task signal is present (AC #2, AC #5 hermetic)', () => {
    // Pattern C parent, no .active-task, no env var → should refuse
    expect(() => applyPatternCIfNeeded(parentRoot, {})).toThrow(PATTERN_C_ERROR_MESSAGE);
  });

  it('routes to worktree via AI_SDLC_ACTIVE_TASK_ID env (AC #4, AC #6 hermetic)', () => {
    const result = applyPatternCIfNeeded(parentRoot, { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-216' });
    expect(result).toBe(resolve(parentRoot, '.worktrees', 'aisdlc-216'));
  });

  it('routes to worktree via .active-task sentinel file (AC #3)', () => {
    writeFileSync(join(parentRoot, '.active-task'), 'AISDLC-216\n', 'utf-8');
    const result = applyPatternCIfNeeded(parentRoot, {});
    expect(result).toBe(resolve(parentRoot, '.worktrees', 'aisdlc-216'));
  });

  it('throws when the active-task worktree has no backlog/ dir', () => {
    const result = () =>
      applyPatternCIfNeeded(parentRoot, { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-999' });
    expect(result).toThrow(/aisdlc-999/);
    expect(result).toThrow(/does not contain a backlog\/ directory/);
  });
});

/**
 * End-to-end Pattern C scenarios through resolveProjectRoot() (ACs #5 and #6).
 *
 * These tests simulate what happens when the MCP server starts with cwd at the
 * Pattern C parent root (the common case), and what happens when an active-task
 * signal routes it into the correct worktree.
 */
describe('resolveProjectRoot — Pattern C end-to-end (AISDLC-216)', () => {
  let scratch: string;
  let parentRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-216-e2e-'));

    // Simulate the real Pattern C layout:
    // <parent>/
    //   backlog/tasks/
    //   .worktrees/
    //     aisdlc-216/
    //       backlog/tasks/   ← the target for writes
    parentRoot = join(scratch, 'ai-sdlc');
    mkdirSync(join(parentRoot, 'backlog', 'tasks'), { recursive: true });
    worktreeRoot = join(parentRoot, '.worktrees', 'aisdlc-216');
    mkdirSync(join(worktreeRoot, 'backlog', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('AC #5 hermetic: cwd = parent root + no active-task signal → throws Pattern C refusal', () => {
    // This simulates: MCP server started from parent, no task active.
    // Write would have gone to parent's backlog/ (the bug). Now it refuses.
    expect(() =>
      resolveProjectRoot({
        env: {},
        cwd: parentRoot,
      }),
    ).toThrow(PATTERN_C_ERROR_MESSAGE);
  });

  it('AC #6 hermetic: cwd = parent root + AI_SDLC_ACTIVE_TASK_ID set → routes to worktree backlog/', () => {
    // This simulates: MCP server started from parent, operator set the env var.
    const result = resolveProjectRoot({
      env: { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-216' },
      cwd: parentRoot,
    });
    expect(result).toBe(resolve(worktreeRoot));
    // The resolved root must NOT be the parent — that's the bug we're fixing.
    expect(result).not.toBe(resolve(parentRoot));
  });

  it('AC #6 variant: .active-task sentinel routes to worktree backlog/', () => {
    writeFileSync(join(parentRoot, '.active-task'), 'AISDLC-216\n', 'utf-8');
    const result = resolveProjectRoot({
      env: {},
      cwd: parentRoot,
    });
    expect(result).toBe(resolve(worktreeRoot));
    expect(result).not.toBe(resolve(parentRoot));
  });

  it('non-Pattern-C project still resolves to itself (regression guard)', () => {
    // A plain project without .worktrees/ should be unaffected.
    const plain = join(scratch, 'plain-project');
    mkdirSync(join(plain, 'backlog', 'tasks'), { recursive: true });
    const result = resolveProjectRoot({
      env: {},
      cwd: plain,
    });
    expect(result).toBe(resolve(plain));
  });

  it('Pattern C with worktree cwd falls back to parent, then re-routes via env (AC #4 + #6 composition)', () => {
    // Simulates: Claude Code invoked from inside a worktree subdir.
    // walkUpForBacklog stops at worktreeRoot (which has backlog/), so it
    // never reaches parentRoot — no Pattern C check needed for this sub-path.
    const nestedInWorktree = join(worktreeRoot, 'src', 'lib');
    mkdirSync(nestedInWorktree, { recursive: true });

    const result = resolveProjectRoot({
      env: { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-216' },
      cwd: nestedInWorktree,
    });
    // Worktree itself is a valid root (has backlog/). Pattern C check does
    // NOT apply to worktrees — only to the parent. The worktree root does
    // NOT have a .worktrees/ of its own.
    expect(result).toBe(resolve(worktreeRoot));
  });
});
