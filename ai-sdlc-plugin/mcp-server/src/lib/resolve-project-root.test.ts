import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT_ERROR_MESSAGE, resolveProjectRoot } from './resolve-project-root.js';

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
