/**
 * Hermetic tests for `cli-hierarchy pr-hold` (AISDLC-1386): injected identity and an
 * injected `gh` runner. No session, tmux or network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import type { IdentityDeps } from './caller-identity.js';
import { withIsolatedBoard, type IsolatedBoard } from './__test-helpers/isolated-board.js';
import { prHold } from './pr-hold.js';
import type { CommandRunner } from './types.js';

let iso: IsolatedBoard;
beforeEach(() => {
  iso = withIsolatedBoard('pr-hold-');
});
afterEach(() => {
  vi.restoreAllMocks();
  iso.cleanup();
});

/** The calling process resolves to pid 4242 with the given role; `null` = no roster session. */
const identityFor = (role: string | null, name = 'proj-x'): IdentityDeps => ({
  readSessions: () => (role ? [{ name, role, pid: 4242, status: 'running' }] : []),
  parentPid: () => null,
  comm: () => 'claude',
  startPid: 4242,
});

function ghFake(fail?: string) {
  const calls: string[][] = [];
  const run: CommandRunner = (_f, args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(' ');
    return key === fail
      ? { status: 1, stdout: '', stderr: 'boom' }
      : { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

async function cli(argv: string[], identity: IdentityDeps, ghRun: CommandRunner) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (c: string | Uint8Array) => (err.push(String(c)), true),
  );
  const code = await runHierarchyCli(
    argv,
    { boardDir: iso.board, cwd: iso.tmp, log: (l) => out.push(l) },
    { identity, ghRun },
  );
  return { code, out, err: err.join('') };
}

describe('cli-hierarchy pr-hold', () => {
  it('adds the label and comments the reason, then clears it', async () => {
    const gh = ghFake();
    const planner = identityFor('planner', 'proj-planner');
    const held = await cli(
      ['pr-hold', '184', '--reason', 'workflow needs review'],
      planner,
      gh.run,
    );
    expect(held.code).toBe(0);
    expect(JSON.parse(held.out[0]!)).toEqual({
      ok: true,
      pr: 184,
      held: true,
      label: 'ai-sdlc/hold',
      by: 'proj-planner',
      disarmed: true,
    });
    expect(gh.calls[0]!.slice(0, 3)).toEqual(['label', 'create', 'ai-sdlc/hold']);
    expect(gh.calls[1]).toEqual(['pr', 'edit', '184', '--add-label', 'ai-sdlc/hold']);
    // An armed PR would merge on green regardless of the label: the hold turns auto-merge off.
    expect(gh.calls[2]).toEqual(['pr', 'merge', '184', '--disable-auto']);
    expect(gh.calls[3]!.slice(0, 4)).toEqual(['pr', 'comment', '184', '--body']);
    expect(gh.calls[3]![4]).toMatch(/Held by proj-planner: workflow needs review/);

    const cleared = ghFake();
    const r = await cli(['pr-hold', '184', '--clear'], identityFor(null), cleared.run);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ held: false, by: 'the operator' });
    expect(JSON.parse(r.out[0]!).disarmed).toBeUndefined();
    expect(cleared.calls[0]).toEqual(['pr', 'edit', '184', '--remove-label', 'ai-sdlc/hold']);
    expect(cleared.calls[1]![4]).toMatch(/Hold lifted by the operator\./);
    expect(cleared.calls.some((a) => a[1] === 'merge')).toBe(false);
  });

  it('still holds an unarmed PR when gh refuses to disable auto-merge', () => {
    const gh = ghFake('pr merge');
    expect(prHold(gh.run, '/', 7, { clear: false, reason: 'r', by: 'b' })).toEqual({
      ok: true,
      disarmed: false,
    });
    expect(gh.calls.map((a) => a.slice(0, 2).join(' '))).toEqual([
      'label create',
      'pr edit',
      'pr merge',
      'pr comment',
    ]);
  });

  it('refuses an executor or dispatch caller and calls no gh', async () => {
    for (const role of ['executor', 'operator-dispatch']) {
      const gh = ghFake();
      const r = await cli(['pr-hold', '184', '--reason', 'x'], identityFor(role), gh.run);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/only the planner or the operator may hold a PR/);
      expect(gh.calls).toEqual([]);
    }
  });

  it('exits 2 without a PR number or a reason, and 1 when gh fails', async () => {
    const gh = ghFake();
    const planner = identityFor('planner');
    expect((await cli(['pr-hold', '--reason', 'x'], planner, gh.run)).code).toBe(2);
    expect((await cli(['pr-hold', '184'], planner, gh.run)).code).toBe(2);
    expect(gh.calls).toEqual([]);
    const failing = await cli(['pr-hold', '184', '--clear'], planner, ghFake('pr edit').run);
    expect(failing.code).toBe(1);
    expect(failing.err).toMatch(/gh pr edit failed: boom/);
  });

  it('prHold stops at the first failed gh step', () => {
    expect(
      prHold(ghFake('label create').run, '/', 1, { clear: false, reason: 'r', by: 'b' }),
    ).toEqual({ ok: false, error: 'gh label create failed: boom' });
    const comment = ghFake('pr comment');
    expect(prHold(comment.run, '/', 1, { clear: true, reason: 'done', by: 'b' })).toEqual({
      ok: false,
      error: 'gh pr comment failed: boom',
    });
    expect(comment.calls[1]![4]).toMatch(/Hold lifted by b: done\./);
    const silent: CommandRunner = () => ({ status: 2, stdout: '', stderr: '' });
    expect(prHold(silent, '/', 1, { clear: true, by: 'b' }).error).toBe(
      'gh pr edit failed: exit 2',
    );
  });
});
