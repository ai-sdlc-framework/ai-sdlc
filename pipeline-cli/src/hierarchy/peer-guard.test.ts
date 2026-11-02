import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkRepoMatch, rosterProject } from './peer-guard.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

describe('checkRepoMatch', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'peer-guard-'));
  });
  afterEach(() => {
    removeFixtureDir(tmp);
  });

  const board = (root: string) => path.join(root, '.ai-sdlc', 'dispatch');
  const gitReporting = (root: string | null) => (_args: readonly string[]) =>
    root === null ? null : path.join(root, '.git');

  it('accepts the repository that owns the board, also from a worktree of it', () => {
    const repo = path.join(tmp, 'a');
    const ok = checkRepoMatch({
      cwd: path.join(repo, '.worktrees', 'task'),
      boardDir: board(repo),
      project: 'proj-a',
      git: gitReporting(repo),
    });
    expect(ok).toEqual({ ok: true, project: 'proj-a' });
  });

  it('stops a session sitting in another project repository, naming the next step', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    const r = checkRepoMatch({
      cwd: b,
      boardDir: board(a),
      project: 'proj-a',
      git: gitReporting(b),
    });
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("project 'proj-a'");
    expect(reason).toContain('no repository work was started');
    expect(reason).toContain(`Change to ${a}`);
  });

  it('stops a session outside any repository, naming the next step', () => {
    const r = checkRepoMatch({
      cwd: tmp,
      boardDir: board(path.join(tmp, 'a')),
      project: 'proj-a',
      git: gitReporting(null),
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('change to that repository');
  });
});

describe('rosterProject', () => {
  it('returns the single project of a roster', () => {
    expect(rosterProject([{ project: 'p' }, { project: 'p' }])).toEqual({ ok: true, project: 'p' });
  });

  it('refuses an empty roster, a roster without project and a roster of mixed projects', () => {
    expect(rosterProject([]).ok).toBe(false);
    expect(rosterProject([{}]).ok).toBe(false);
    const mixed = rosterProject([{ project: 'a' }, { project: 'b' }]);
    expect(mixed.ok).toBe(false);
    expect((mixed as { reason: string }).reason).toContain('cli-hierarchy down');
  });
});
