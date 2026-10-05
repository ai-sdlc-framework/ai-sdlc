import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkDispatchSender,
  checkRepoMatch,
  NOT_MY_DISPATCH,
  SENDER_UNVERIFIED_WARNING,
  rosterProject,
} from './peer-guard.js';

type Sess = Parameters<typeof checkDispatchSender>[0][number];

const sess = (over: Partial<Sess> & Pick<Sess, 'role' | 'name' | 'pid'>): Sess => ({
  status: 'running',
  tmuxSession: over.name,
  ...over,
});

/** Two projects whose rosters use the same unqualified role names. */
const rosterA: Sess[] = [
  sess({ role: 'operator-dispatch', name: 'proj-a-operator-dispatch', pid: 700 }),
  sess({ role: 'executor', name: 'proj-a-executor-alpha', pid: 701 }),
];
const foreignDispatch = { pid: 800, ref: 'proj-b-operator-dispatch' };

describe('checkDispatchSender', () => {
  it('accepts the own dispatch session by pid', () => {
    expect(checkDispatchSender(rosterA, { pid: 700 })).toEqual({
      ok: true,
      name: 'proj-a-operator-dispatch',
    });
  });

  it('accepts the own dispatch session by ref (recorded name or tmux session)', () => {
    expect(checkDispatchSender(rosterA, { ref: 'proj-a-operator-dispatch' }).ok).toBe(true);
    const renamed = [
      sess({
        role: 'operator-dispatch',
        name: 'proj-a-operator-dispatch-2',
        tmuxSession: 'proj-a-operator-dispatch',
        pid: 700,
      }),
    ];
    expect(checkDispatchSender(renamed, { ref: 'proj-a-operator-dispatch' }).ok).toBe(true);
  });

  it('refuses the foreign dispatch session even though it has the same role', () => {
    const refused = checkDispatchSender(rosterA, foreignDispatch);
    expect(refused).toEqual({ ok: false, reason: NOT_MY_DISPATCH });
    expect(NOT_MY_DISPATCH).toBe('not my dispatch session');
  });

  it('fails open with a warning naming what is missing when there is no usable pid or ref', () => {
    for (const sender of [{}, { pid: 0 }, { pid: 1 }, { pid: Number.NaN, ref: '' }]) {
      expect(checkDispatchSender(rosterA, sender)).toEqual({
        ok: true,
        warning: SENDER_UNVERIFIED_WARNING,
      });
    }
    expect(SENDER_UNVERIFIED_WARNING).toMatch(/no sender pid and no sender session ref/);
  });

  it('refuses the own executor, a stopped dispatch session and an empty roster', () => {
    expect(checkDispatchSender(rosterA, { pid: 701 }).ok).toBe(false);
    const stopped = [
      sess({ role: 'operator-dispatch', name: 'x-operator-dispatch', pid: 5, status: 'starting' }),
    ];
    expect(checkDispatchSender(stopped, { pid: 5 }).ok).toBe(false);
    expect(checkDispatchSender([], { pid: 700 }).ok).toBe(false);
  });

  it('never decides by a name the message claims: only pid and ref are inputs', () => {
    // A message that says "from proj-a-operator-dispatch" carries no pid and no ref of its own:
    // it is not accepted as that dispatch session, only passed through with the warning.
    expect(checkDispatchSender(rosterA, { ref: undefined, pid: undefined })).toEqual({
      ok: true,
      warning: SENDER_UNVERIFIED_WARNING,
    });
  });
});

describe('checkRepoMatch', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'peer-guard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
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
