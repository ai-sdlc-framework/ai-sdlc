/**
 * AISDLC-1156 (DEC-0291): after a repair push the playbook verifies the attestation, marks the PR ready and
 * writes a delivered verdict. Regression for #2246 (AISDLC-1136) and #2282 (AISDLC-1153): a re-entry that
 * passed verify, review and signing and failed only its push sat as an unowned draft for hours.
 * git is a scripted runner; nothing touches a repository or remote.
 */

import { describe, expect, it } from 'vitest';

import type { DispatchVerdict } from '../dispatch/types.js';
import type { HierarchyEvent } from './emit.js';
import { runPlaybook, type PlaybookDeps, type RepairFinishDeps } from './playbook.js';
import type { CommandResult } from './types.js';

const BRANCH = 'ai-sdlc/aisdlc-9-some-slug';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

function failed(over: Partial<DispatchVerdict> = {}): DispatchVerdict {
  return {
    schemaVersion: 'v1',
    taskId: 'AISDLC-9',
    outcome: 'failed',
    completedAt: '2026-11-02T12:00:00.000Z',
    workerId: 'executor-alpha',
    cause: 'push-non-fast-forward',
    signedAt: '2026-11-02T11:59:00.000Z',
    prNumber: 2282,
    prUrl: 'https://github.com/o/r/pull/2282',
    ...over,
  };
}

function setup(finish: Partial<RepairFinishDeps> = {}, pushStatus = 0) {
  const events: HierarchyEvent[] = [];
  const delivered: DispatchVerdict[] = [];
  const calls: string[][] = [];
  const deps: PlaybookDeps = {
    run: (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'branch') return ok(BRANCH + '\n');
      if (args[0] === 'rev-parse') return ok((args[1] === 'HEAD' ? HEAD : BASE) + '\n');
      if (args[0] === 'status') return ok('');
      if (args[0] === 'push') return { status: pushStatus, stdout: '', stderr: 'rejected' };
      return ok();
    },
    repoRoot: '/repo',
    operational: new Set(['rebase-own-branch', 'lease-push-own-branch']),
    forcePushMode: 'leaseOnOwnBranch',
    protectedBranches: [],
    ownWorktree: () => null,
    requeue: () => ({ retryCount: 1 }),
    emit: (e) => events.push(e),
    workerId: 'operator-dispatch',
    exists: () => true,
    finish: {
      verify: () => ({ ok: true, signedAt: '2026-11-02T12:05:00.000Z' }),
      markReady: () => ({ ok: true }),
      deliver: (v) => delivered.push(v),
      now: () => new Date('2026-11-02T12:06:00.000Z'),
      ...finish,
    },
  };
  return { deps, events, delivered, calls };
}

describe('playbook finishes a repaired push (AISDLC-1156)', () => {
  it('verifies, marks ready and writes a delivered verdict with signedAt and prNumber (#2282)', async () => {
    const { deps, delivered, calls } = setup();
    const outcome = await runPlaybook(failed(), deps);
    expect(outcome).toMatchObject({ action: 'rebase-push', result: 'done', delivered: true });
    expect(calls.some((c) => c[0] === 'push')).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      taskId: 'AISDLC-9',
      outcome: 'success',
      prNumber: 2282,
      commitSha: HEAD,
      pushedBranch: BRANCH,
      signedAt: '2026-11-02T12:05:00.000Z',
    });
  });

  it('keeps the envelope signedAt when the verifier reports none', async () => {
    const { deps, delivered } = setup({ verify: () => ({ ok: true }) });
    await runPlaybook(failed(), deps);
    expect(delivered[0]?.signedAt).toBe('2026-11-02T11:59:00.000Z');
  });

  it('escalates and delivers nothing when the attestation does not verify (#2246)', async () => {
    const { deps, delivered } = setup({ verify: () => ({ ok: false, reason: 'head mismatch' }) });
    const outcome = await runPlaybook(failed(), deps);
    expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
    expect(outcome.escalation?.message).toContain('does not verify');
    expect(delivered).toEqual([]);
  });

  it('escalates and delivers nothing when mark-ready is refused', async () => {
    const { deps, delivered } = setup({ markReady: () => ({ ok: false, reason: 'conflicts' }) });
    const outcome = await runPlaybook(failed(), deps);
    expect(outcome.result).toBe('escalated');
    expect(outcome.escalation?.message).toContain('mark-ready refused');
    expect(delivered).toEqual([]);
  });

  it('does not finish an unsigned failure or a failed push', async () => {
    const unsigned = setup();
    const o1 = await runPlaybook(failed({ signedAt: undefined }), unsigned.deps);
    expect(o1).toMatchObject({ result: 'done' });
    expect(o1.delivered).toBeUndefined();
    expect(unsigned.delivered).toEqual([]);

    const bad = setup({}, 1);
    const o2 = await runPlaybook(failed(), bad.deps);
    expect(o2.result).toBe('escalated');
    expect(bad.delivered).toEqual([]);
  });

  it('escalates when the pushed head cannot be read', async () => {
    const s = setup();
    const run = s.deps.run;
    s.deps.run = (file, args, o) =>
      args[0] === 'rev-parse' ? { status: 1, stdout: '', stderr: 'x' } : run(file, args, o);
    const outcome = await runPlaybook(failed(), s.deps);
    expect(outcome.result).toBe('escalated');
    expect(s.delivered).toEqual([]);
  });
});
