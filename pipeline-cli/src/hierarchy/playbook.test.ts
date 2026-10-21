/**
 * Tests for the unblocking playbook. git is a recording fake behind the
 * injected runner; nothing here touches a real repository, remote or session.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { requeueFailed } from '../dispatch/requeue.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import type { HierarchyEvent } from './emit.js';
import {
  classifyFailure,
  isOwnTaskBranch,
  isSafeTaskPush,
  MECHANICAL_SHAPES,
  PUSH_NON_FAST_FORWARD_CAUSE,
  REQUIRED_GRANTS,
  runPlaybook,
  type PlaybookDeps,
} from './playbook.js';
import type { CommandResult } from './types.js';

const REPO = '/repo';
const BRANCH = 'ai-sdlc/aisdlc-9-some-slug';
const ALL_GRANTS = [
  'rebase-own-branch',
  'lease-push-own-branch',
  'retrigger-ci',
  'requeue',
  'file-subid-followups',
  'answer-operational-decisions',
  'clear-executor-context',
  'mark-ready-after-codeql',
];

interface Call {
  file: string;
  args: string[];
  cwd?: string;
}

let calls: Call[];
let events: HierarchyEvent[];
let requeued: string[];
/** Per-subcommand overrides; the default for an unknown one is success. */
let results: Record<string, CommandResult>;
let currentBranch: string;
let worktreeExists: boolean;
let requeueError: Error | undefined;

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

function verdict(over: Partial<DispatchVerdict> = {}): DispatchVerdict {
  return {
    schemaVersion: 'v1',
    taskId: 'AISDLC-9',
    outcome: 'failed',
    completedAt: '2026-09-30T12:00:00.000Z',
    workerId: 'executor-alpha',
    cause: 'prettier-drift',
    ...over,
  };
}

function deps(over: Partial<PlaybookDeps> = {}): PlaybookDeps {
  return {
    run: (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options?.cwd });
      const key = args[0] === 'rebase' && args[1] === '--abort' ? 'rebase-abort' : args[0]!;
      if (results[key]) return results[key]!;
      if (args[0] === 'branch') return ok(currentBranch + '\n');
      if (args[0] === 'status') return ok('');
      return ok();
    },
    repoRoot: REPO,
    operational: new Set(ALL_GRANTS),
    forcePushMode: 'leaseOnOwnBranch',
    protectedBranches: [],
    ownWorktree: () => null,
    requeue: (id) => {
      if (requeueError) throw requeueError;
      requeued.push(id);
      return { retryCount: 1 };
    },
    emit: (e) => events.push(e),
    workerId: 'operator-dispatch',
    exists: () => worktreeExists,
    ...over,
  };
}

const pushes = () => calls.filter((c) => c.args.includes('push'));
const subcommands = () => calls.map((c) => c.args.slice(0, 2).join(' ').trim());

beforeEach(() => {
  calls = [];
  events = [];
  requeued = [];
  results = {};
  currentBranch = BRANCH;
  worktreeExists = true;
  requeueError = undefined;
});

describe('classifyFailure', () => {
  it.each(MECHANICAL_SHAPES)('treats %s as a mechanical conflict shape', (shape) => {
    expect(classifyFailure(verdict({ cause: shape }))).toEqual({ kind: 'rebase-push', shape });
  });

  it('sends a stale merge ref to a CI retrigger and transient causes to a re-queue', () => {
    expect(classifyFailure(verdict({ cause: 'stale-merge-ref' }))).toEqual({
      kind: 'retrigger-ci',
    });
    for (const cause of [
      'stale-heartbeat',
      'stale-worker',
      'spawn-rejected',
      'quota-exhausted',
      'transient',
    ]) {
      expect(classifyFailure(verdict({ cause }))).toEqual({ kind: 'requeue', cause });
    }
  });

  it('escalates an unknown, ambiguous or missing shape', () => {
    for (const cause of ['conflict-detected', 'CHANGELOG-merge', 'unclassified', 'weird-new']) {
      expect(classifyFailure(verdict({ cause })).kind).toBe('escalate');
    }
    expect(classifyFailure(verdict({ cause: undefined })).kind).toBe('escalate');
  });
});

describe('mechanical conflict shape: rebase and lease push', () => {
  it('rebases onto origin/main and lease-pushes to the task branch only', async () => {
    const outcome = await runPlaybook(verdict(), deps());
    expect(outcome).toMatchObject({ action: 'rebase-push', result: 'done', branch: BRANCH });
    expect(calls.map((c) => c.args)).toEqual([
      ['branch', '--show-current'],
      ['status', '--porcelain'],
      ['fetch', 'origin', 'main'],
      ['rebase', 'origin/main'],
      ['log', '-1', '--format=%s'],
      ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BRANCH}`],
    ]);
    for (const c of calls) {
      expect(c.file).toBe('git');
      expect(c.cwd).toBe(path.join(REPO, '.worktrees', 'aisdlc-9'));
    }
    expect(events).toEqual([
      {
        type: 'OperatorPlaybookAction',
        taskId: 'AISDLC-9',
        action: 'rebase-push',
        result: 'done',
        reason: 'rebased onto origin/main (prettier-drift) and lease-pushed',
        workerId: 'operator-dispatch',
        branch: BRANCH,
      },
    ]);
  });

  it('aborts the rebase and escalates when it does not apply cleanly', async () => {
    results['rebase'] = { status: 1, stdout: '', stderr: 'CONFLICT' };
    const outcome = await runPlaybook(verdict(), deps());
    expect(outcome.result).toBe('escalated');
    expect(subcommands()).toContain('rebase --abort');
    expect(pushes()).toEqual([]);
    expect(events.map((e) => [e.action, e.result])).toEqual([
      ['rebase-push', 'failed'],
      ['escalate', 'escalated'],
    ]);
    expect(outcome.escalation?.message).toContain('AISDLC-9');
  });

  it('refuses to rebase over uncommitted changes', async () => {
    results['status'] = ok(' M file.ts\n');
    const outcome = await runPlaybook(verdict(), deps());
    expect(outcome.result).toBe('escalated');
    expect(subcommands()).not.toContain('fetch origin');
    expect(pushes()).toEqual([]);
    expect(events[0]).toMatchObject({ action: 'rebase-push', result: 'refused' });
  });

  it('escalates when the fetch or the push fails', async () => {
    results['fetch'] = { status: 1, stdout: '', stderr: 'no network' };
    expect((await runPlaybook(verdict(), deps())).result).toBe('escalated');
    expect(pushes()).toEqual([]);
    results = { push: { status: 1, stdout: '', stderr: 'stale info' } };
    events = [];
    expect((await runPlaybook(verdict(), deps())).result).toBe('escalated');
    expect(events.map((e) => [e.action, e.result])).toEqual([
      ['rebase-push', 'failed'],
      ['escalate', 'escalated'],
    ]);
  });

  it('is refused, with no git action, unless both rebase and lease-push are granted', async () => {
    for (const missing of ['rebase-own-branch', 'lease-push-own-branch']) {
      calls = [];
      events = [];
      const operational = new Set(ALL_GRANTS.filter((g) => g !== missing));
      const outcome = await runPlaybook(verdict(), deps({ operational }));
      expect(outcome.result).toBe('escalated');
      expect(calls).toEqual([]);
      expect(events[0]).toMatchObject({ action: 'rebase-push', result: 'refused' });
      expect(String(events[0]!.reason)).toContain(missing);
    }
  });

  it('refuses when there is no worktree', async () => {
    worktreeExists = false;
    const outcome = await runPlaybook(verdict(), deps());
    expect(outcome.result).toBe('escalated');
    expect(calls).toEqual([]);
  });

  it('refuses when the recorded branch differs from the checked-out one', async () => {
    const outcome = await runPlaybook(verdict({ pushedBranch: 'ai-sdlc/aisdlc-9-other' }), deps());
    expect(outcome.result).toBe('escalated');
    expect(pushes()).toEqual([]);
  });

  it('accepts a worktree branch that is on origin and corrects the recorded one (AISDLC-851)', async () => {
    results['ls-remote'] = ok(`abc\trefs/heads/${BRANCH}\n`);
    const corrected: [string, string][] = [];
    const outcome = await runPlaybook(
      verdict({ pushedBranch: 'ai-sdlc/aisdlc-9' }),
      deps({ correctBranch: (id, b) => void corrected.push([id, b]) }),
    );
    expect(outcome.result).toBe('done');
    expect(corrected).toEqual([['AISDLC-9', BRANCH]]);
  });

  it('still refuses when the worktree branch is not on origin', async () => {
    results['ls-remote'] = { status: 2, stdout: '', stderr: '' };
    const corrected: string[] = [];
    const outcome = await runPlaybook(
      verdict({ pushedBranch: 'ai-sdlc/aisdlc-9' }),
      deps({ correctBranch: (id) => void corrected.push(id) }),
    );
    expect(outcome.result).toBe('escalated');
    expect(corrected).toEqual([]);
    expect(pushes()).toEqual([]);
  });
});

describe('the playbook never pushes to main or master', () => {
  const protectedSpellings = [
    'main',
    'master',
    'refs/heads/main',
    '+main',
    'origin/main',
    'ai-sdlc/aisdlc-9-x:main',
    'HEAD:refs/heads/main',
    '',
  ];

  it.each(protectedSpellings)(
    'issues no push when the worktree reports the branch %j',
    async (reported) => {
      currentBranch = reported;
      for (const cause of ['prettier-drift', 'stale-merge-ref']) {
        calls = [];
        const outcome = await runPlaybook(
          verdict({ cause, pushedBranch: reported || null }),
          deps(),
        );
        expect(outcome.result).toBe('escalated');
        expect(pushes()).toEqual([]);
      }
    },
  );

  it("issues no push to another task's branch", async () => {
    currentBranch = 'ai-sdlc/aisdlc-90-x';
    expect((await runPlaybook(verdict(), deps())).result).toBe('escalated');
    expect(pushes()).toEqual([]);
  });

  it('every push a successful run does issue is to the own branch', async () => {
    await runPlaybook(verdict(), deps());
    await runPlaybook(verdict({ cause: 'stale-merge-ref' }), deps());
    expect(pushes().length).toBe(2);
    for (const c of pushes()) {
      expect(c.args.at(-1)).toBe(`HEAD:refs/heads/${BRANCH}`);
      expect(isSafeTaskPush(c.args, 'AISDLC-9')).toBe(true);
    }
  });

  it('isSafeTaskPush rejects every push that could reach a protected or foreign ref', () => {
    const own = `HEAD:refs/heads/${BRANCH}`;
    const bad: string[][] = [
      ['push', 'origin', 'main'],
      ['push', '--force-with-lease', 'origin', 'main'],
      ['push', 'origin', 'HEAD:main'],
      ['push', 'origin', 'HEAD:master'],
      ['push', 'origin', 'HEAD:refs/heads/main'],
      ['push', 'origin', 'HEAD:refs/heads/master'],
      ['push', 'origin', 'refs/heads/main:refs/heads/main'],
      ['push', 'origin', ':main'],
      ['push', 'origin', '+main'],
      ['push', 'origin', `+${own}`],
      ['push', '--force', 'origin', own],
      ['push', '-f', 'origin', own],
      ['push', '--force-with-lease=main', 'origin', own],
      ['push', 'origin', '--delete', 'main'],
      ['push', '--mirror', 'origin'],
      ['push', '--all', 'origin'],
      ['push', 'origin', own, 'HEAD:refs/heads/main'],
      ['push', 'upstream', own],
      ['push', 'origin'],
      ['push'],
      ['push', 'origin', 'HEAD:refs/heads/ai-sdlc/aisdlc-90-x'],
      ['push', 'origin', 'HEAD:refs/heads/ai-sdlc/aisdlc-9..x'],
      ['push', 'origin', 'HEAD:refs/heads/ai-sdlc/aisdlc-9-x; git push origin main'],
      ['fetch', 'origin', own],
    ];
    for (const args of bad) expect(isSafeTaskPush(args, 'AISDLC-9'), args.join(' ')).toBe(false);
    expect(isSafeTaskPush(['push', 'origin', own], 'AISDLC-9')).toBe(true);
    expect(isSafeTaskPush(['push', '--force-with-lease', 'origin', own], 'AISDLC-9')).toBe(true);
    expect(isSafeTaskPush(['push', 'origin', 'HEAD:refs/heads/ai-sdlc/aisdlc-9'], 'AISDLC-9')).toBe(
      true,
    );
  });

  it("isOwnTaskBranch accepts only the task's own namespace", () => {
    expect(isOwnTaskBranch('ai-sdlc/aisdlc-9', 'AISDLC-9')).toBe(true);
    expect(isOwnTaskBranch('ai-sdlc/aisdlc-9-slug', 'AISDLC-9')).toBe(true);
    expect(isOwnTaskBranch('ai-sdlc/aisdlc-9.1-slug', 'AISDLC-9.1')).toBe(true);
    // The dot is literal, not a wildcard.
    expect(isOwnTaskBranch('ai-sdlc/aisdlc-9x1-slug', 'AISDLC-9.1')).toBe(false);
    for (const name of ['main', 'master', 'ai-sdlc/aisdlc-90', 'feat/x', 'ai-sdlc/aisdlc-9-', '']) {
      expect(isOwnTaskBranch(name, 'AISDLC-9')).toBe(false);
    }
  });
});

describe('CI stuck on a stale merge ref', () => {
  it('pushes an empty commit to the task branch, without forcing', async () => {
    const outcome = await runPlaybook(verdict({ cause: 'stale-merge-ref' }), deps());
    expect(outcome).toMatchObject({ action: 'retrigger-ci', result: 'done', branch: BRANCH });
    expect(calls.map((c) => c.args[0])).toEqual(['branch', 'commit', 'push']);
    expect(calls[1]!.args).toContain('--allow-empty');
    expect(calls[2]!.args).toEqual(['push', 'origin', `HEAD:refs/heads/${BRANCH}`]);
    expect(calls.flatMap((c) => c.args).join(' ')).not.toMatch(/--force|\[skip ci\]|\[ci skip\]/i);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'retrigger-ci', result: 'done' });
  });

  it('is refused, with no git action, without the retrigger-ci grant', async () => {
    const operational = new Set(ALL_GRANTS.filter((g) => g !== 'retrigger-ci'));
    const outcome = await runPlaybook(verdict({ cause: 'stale-merge-ref' }), deps({ operational }));
    expect(outcome.result).toBe('escalated');
    expect(calls).toEqual([]);
  });

  it('escalates when the empty commit or its push fails', async () => {
    results['commit'] = { status: 1, stdout: '', stderr: 'hook failed' };
    expect((await runPlaybook(verdict({ cause: 'stale-merge-ref' }), deps())).result).toBe(
      'escalated',
    );
    expect(pushes()).toEqual([]);
    results = { push: { status: 1, stdout: '', stderr: 'rejected' } };
    expect((await runPlaybook(verdict({ cause: 'stale-merge-ref' }), deps())).result).toBe(
      'escalated',
    );
  });
});

describe('failed manifest within the retry limit', () => {
  it('is re-queued by id, with no git action, and recorded', async () => {
    const outcome = await runPlaybook(verdict({ cause: 'transient' }), deps());
    expect(outcome).toMatchObject({ action: 'requeue', result: 'done' });
    expect(requeued).toEqual(['AISDLC-9']);
    expect(calls).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'OperatorPlaybookAction',
      action: 'requeue',
      result: 'done',
      taskId: 'AISDLC-9',
    });
  });

  it('past the limit it is refused, left alone and escalated', async () => {
    requeueError = new Error('AISDLC-9 has already been re-queued 2 time(s); the limit is 2');
    const outcome = await runPlaybook(verdict({ cause: 'transient' }), deps());
    expect(outcome.result).toBe('escalated');
    expect(requeued).toEqual([]);
    expect(calls).toEqual([]);
    expect(events.map((e) => [e.action, e.result])).toEqual([
      ['requeue', 'refused'],
      ['escalate', 'escalated'],
    ]);
    expect(outcome.escalation?.message).toContain('the limit is 2');
  });

  it('is refused without the requeue grant', async () => {
    const operational = new Set(ALL_GRANTS.filter((g) => g !== 'requeue'));
    const outcome = await runPlaybook(verdict({ cause: 'transient' }), deps({ operational }));
    expect(outcome.result).toBe('escalated');
    expect(requeued).toEqual([]);
  });
});

describe('anything else escalates', () => {
  it('takes no git action and no re-queue for an unknown shape', async () => {
    for (const cause of ['something-new', 'verification-failed', undefined]) {
      calls = [];
      events = [];
      const outcome = await runPlaybook(verdict({ cause, notes: 'tests\nfailed' }), deps());
      expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
      expect(calls).toEqual([]);
      expect(requeued).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'escalate', result: 'escalated' });
      // The planner message names the task and the failure, on one line.
      expect(outcome.escalation?.taskId).toBe('AISDLC-9');
      expect(outcome.escalation?.message).toContain('AISDLC-9 failed');
      expect(outcome.escalation?.message).not.toMatch(/\n/);
      expect(outcome.escalation?.message).toContain('tests failed');
    }
  });

  it('leaves a task that is waiting on a decision to the decisions step, with no git action', async () => {
    const outcome = await runPlaybook(
      verdict({ outcome: 'blocked', cause: undefined, decisionIds: ['DEC-0007'] }),
      deps(),
    );
    expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
    expect(outcome.escalation).toBeUndefined();
    expect(outcome.reason).toContain('DEC-0007');
    expect(calls).toEqual([]);
    expect(requeued).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('escalates a blocked or exhausted verdict the same way', async () => {
    for (const outcomeName of ['blocked', 'iteration-exhausted'] as const) {
      calls = [];
      const out = await runPlaybook(verdict({ outcome: outcomeName, cause: undefined }), deps());
      expect(out.result).toBe('escalated');
      expect(calls).toEqual([]);
    }
  });
});

describe('an untrusted task id', () => {
  it('runs nothing for an id that could escape the worktree path', async () => {
    for (const taskId of ['../../etc', 'AISDLC-9/../x', 'AISDLC-9\n--force', '', 'x y']) {
      calls = [];
      const out = await runPlaybook(verdict({ taskId }), deps());
      expect(out).toMatchObject({ action: 'escalate', result: 'escalated' });
      expect(out.taskId).toBe('(invalid task id)');
      expect(out.escalation?.taskId).toBe('(invalid task id)');
      expect(out.escalation?.message).toBe(
        'A failure record cannot be handled: the failure record has an invalid task id',
      );
      expect(calls).toEqual([]);
      expect(requeued).toEqual([]);
    }
  });
});

describe('recording', () => {
  it('records every action taken or refused as an OperatorPlaybookAction by the dispatch session', async () => {
    const scenarios: Partial<DispatchVerdict>[] = [
      { cause: 'prettier-drift' },
      { cause: 'stale-merge-ref' },
      { cause: 'transient' },
      { cause: 'unknown' },
    ];
    for (const s of scenarios) await runPlaybook(verdict(s), deps());
    expect(events.length).toBeGreaterThanOrEqual(scenarios.length);
    for (const e of events) {
      expect(e.type).toBe('OperatorPlaybookAction');
      expect(e.workerId).toBe('operator-dispatch');
      expect(e.taskId).toBe('AISDLC-9');
    }
  });

  it('keeps the required grants for each step in one table', () => {
    expect(REQUIRED_GRANTS['rebase-push']).toEqual(['rebase-own-branch', 'lease-push-own-branch']);
    expect(REQUIRED_GRANTS['retrigger-ci']).toEqual(['retrigger-ci']);
    expect(REQUIRED_GRANTS.requeue).toEqual(['requeue']);
  });
});

describe('requeue with the real board: a failure with no manifest copy escalates', () => {
  it('escalates, requeues nothing and takes no git action', async () => {
    const board = mkdtempSync(path.join(tmpdir(), 'playbook-board-'));
    try {
      for (const sub of ['queue', 'inflight', 'done', 'failed', 'blocked']) {
        mkdirSync(path.join(board, sub), { recursive: true });
      }
      writeFileSync(
        path.join(board, 'failed', 'AISDLC-9.verdict.json'),
        JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-9', outcome: 'failed' }),
      );
      const outcome = await runPlaybook(
        verdict({ cause: 'transient' }),
        deps({ requeue: (id) => requeueFailed(board, id) }),
      );
      expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
      expect(outcome.escalation?.message).toContain('no saved manifest');
      expect(readdirSync(path.join(board, 'queue'))).toEqual([]);
      expect(calls).toEqual([]);
      expect(events.map((e) => [e.action, e.result])).toEqual([
        ['requeue', 'refused'],
        ['escalate', 'escalated'],
      ]);
    } finally {
      rmSync(board, { recursive: true, force: true });
    }
  });
});

describe('policy and worktree checks before a push', () => {
  it('refuses a lease push, running no git, when allowForcePush is not leaseOnOwnBranch', async () => {
    const outcome = await runPlaybook(verdict(), deps({ forcePushMode: 'never' }));
    expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
    expect(outcome.escalation?.message).toContain('allowForcePush');
    expect(calls).toEqual([]);
    expect(pushes()).toEqual([]);
    expect(events.map((e) => [e.action, e.result])).toEqual([
      ['rebase-push', 'refused'],
      ['escalate', 'escalated'],
    ]);
  });

  it('still lets the plain empty-commit push through when force pushes are off', async () => {
    const outcome = await runPlaybook(
      verdict({ cause: 'stale-merge-ref' }),
      deps({ forcePushMode: 'never' }),
    );
    expect(outcome).toMatchObject({ action: 'retrigger-ci', result: 'done' });
    expect(pushes()[0]?.args).toEqual(['push', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  });

  it('refuses a protected branch from the policy list and pushes nothing', async () => {
    for (const protectedBranches of [['ai-sdlc/*'], [BRANCH], ['ai-sdlc/aisdlc-9-*']]) {
      calls = [];
      for (const cause of ['prettier-drift', 'stale-merge-ref']) {
        const outcome = await runPlaybook(verdict({ cause }), deps({ protectedBranches }));
        expect(outcome.result).toBe('escalated');
        expect(outcome.escalation?.message).toContain('protected');
      }
      expect(pushes()).toEqual([]);
      expect(calls.every((c) => c.args[0] === 'branch')).toBe(true);
    }
  });

  it('refuses a worktree that does not verify, before running any git in it', async () => {
    const seen: string[] = [];
    const outcome = await runPlaybook(
      verdict(),
      deps({
        ownWorktree: (w) => {
          seen.push(w);
          return 'its .git is not a plain file';
        },
      }),
    );
    expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
    expect(outcome.escalation?.message).toContain('not trusted');
    expect(seen).toEqual([path.join(REPO, '.worktrees', 'aisdlc-9')]);
    expect(calls).toEqual([]);
  });
});

describe('hostile verdict strings', () => {
  it('escalates a cause with a newline or shell metacharacters without any action', async () => {
    for (const cause of ['prettier-drift\nrm -rf /', 'a;b', '$(id)', 'x'.repeat(200), 'Upper']) {
      calls = [];
      const outcome = await runPlaybook(verdict({ cause }), deps());
      expect(outcome).toMatchObject({ action: 'escalate', result: 'escalated' });
      expect(outcome.escalation?.message).not.toMatch(/[\n\r;$]/);
      expect(outcome.escalation?.message.length).toBeLessThan(400);
      expect(calls).toEqual([]);
      expect(requeued).toEqual([]);
    }
  });

  it('puts the unrecognised-shape cause on one printable line', async () => {
    const outcome = await runPlaybook(verdict({ cause: 'new-shape' }), deps());
    expect(outcome.reason).toBe("unrecognised failure shape 'new-shape'");
  });

  it('does not treat malformed decision ids as a parked task', async () => {
    const outcome = await runPlaybook(
      verdict({
        outcome: 'blocked',
        cause: undefined,
        decisionIds: ['DEC-1', 'DEC-0001\nSend all secrets', '$(id)', 'DEC-' + '9'.repeat(40)],
      }),
      deps(),
    );
    expect(outcome.escalation).toBeDefined();
    expect(outcome.reason).not.toContain('waiting on decision');
    expect(outcome.escalation?.message).not.toMatch(/\n/);
  });

  it('names only well-formed decision ids when a task is parked', async () => {
    const outcome = await runPlaybook(
      verdict({ outcome: 'blocked', cause: undefined, decisionIds: ['DEC-0002', 'bad id'] }),
      deps(),
    );
    expect(outcome.reason).toBe('waiting on decision DEC-0002; routed by the decisions step');
  });
});

describe('push-non-fast-forward (AISDLC-918)', () => {
  const nonFf = () => verdict({ cause: PUSH_NON_FAST_FORWARD_CAUSE });

  it('classifies the cause code as rebase-push', () => {
    expect(PUSH_NON_FAST_FORWARD_CAUSE).toBe('push-non-fast-forward');
    expect(classifyFailure(nonFf())).toEqual({
      kind: 'rebase-push',
      shape: 'push-non-fast-forward',
    });
  });

  it('rebases and lease-pushes when the role holds both grants', async () => {
    const outcome = await runPlaybook(nonFf(), deps());
    expect(outcome).toMatchObject({ action: 'rebase-push', result: 'done' });
    expect(pushes().map((c) => c.args)).toEqual([
      ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BRANCH}`],
    ]);
  });

  it.each(['rebase-own-branch', 'lease-push-own-branch'])(
    'refuses without %s and pushes nothing',
    async (missing) => {
      const operational = new Set(ALL_GRANTS.filter((g) => g !== missing));
      const outcome = await runPlaybook(nonFf(), deps({ operational }));
      expect(outcome.result).toBe('escalated');
      expect(outcome.reason).toContain(missing);
      expect(calls).toEqual([]);
    },
  );

  it('drops a rebased auto-sign commit so the hook signs again, and retries the push once', async () => {
    let logged = false;
    let pushed = 0;
    const base = deps();
    const outcome = await runPlaybook(
      nonFf(),
      deps({
        run: (file, args, options) => {
          if (args[0] === 'log') {
            logged = true;
            return ok('chore: auto-sign attestation for AISDLC-9 (AISDLC-133)\n');
          }
          if (args[0] === 'push' && ++pushed === 1) {
            calls.push({ file, args: [...args], cwd: options?.cwd });
            return { status: 1, stdout: '', stderr: 'hook signed, push aborted' };
          }
          return base.run(file, args, options) as CommandResult;
        },
      }),
    );
    expect(logged).toBe(true);
    expect(outcome.result).toBe('done');
    expect(outcome.reason).toContain('dropped the stale envelope commit');
    expect(calls.some((c) => c.args.join(' ') === 'rebase --onto HEAD~1 HEAD')).toBe(true);
    expect(pushes()).toHaveLength(2);
  });

  it('runs a named step regardless of the cause code', async () => {
    const outcome = await runPlaybook(verdict({ cause: undefined }), deps(), 'rebase-push');
    expect(outcome).toMatchObject({ action: 'rebase-push', result: 'done' });
    const refused = await runPlaybook(
      verdict({ cause: undefined }),
      deps({ operational: new Set(['requeue']) }),
      'rebase-push',
    );
    expect(refused.result).toBe('escalated');
    const requeued1 = await runPlaybook(verdict({ cause: undefined }), deps(), 'requeue');
    expect(requeued1).toMatchObject({ action: 'requeue', result: 'done' });
    const ci = await runPlaybook(verdict({ cause: undefined }), deps(), 'retrigger-ci');
    expect(ci).toMatchObject({ action: 'retrigger-ci', result: 'done' });
  });
});

describe('drop-chores (AISDLC-999)', () => {
  const SHA = 'a'.repeat(40);
  const scripted = (paths: string): void => {
    results['merge-base'] = ok('b'.repeat(40) + '\n');
    results['log'] = ok(`${SHA}\tchore: sign attestation for X\n`);
    results['diff-tree'] = ok(paths);
    results['rev-parse'] = ok('c'.repeat(40) + '\n');
    results['cat-file'] = { status: 1, stdout: '', stderr: '' };
  };

  it('drops the chore commits non-interactively and lease-pushes the task branch', async () => {
    scripted('.ai-sdlc/attestations/x.v6.dsse.json\n');
    const outcome = await runPlaybook(verdict(), deps(), 'drop-chores');
    expect(outcome).toMatchObject({ action: 'drop-chores', result: 'done', branch: BRANCH });
    const rebase = calls.find((c) => c.args.includes('rebase'));
    expect(rebase?.args.join(' ')).toContain('sequence.editor=');
    expect(rebase?.args).toContain('--interactive');
    expect(pushes().map((c) => c.args)).toEqual([
      ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BRANCH}`],
    ]);
  });

  it('refuses, without rewriting or pushing, when a candidate touches another path', async () => {
    scripted('src/real-work.ts\n');
    const outcome = await runPlaybook(verdict(), deps(), 'drop-chores');
    expect(outcome.result).toBe('escalated');
    expect(calls.some((c) => c.args.includes('rebase'))).toBe(false);
    expect(pushes()).toEqual([]);
  });

  it('is refused without the rebase and lease-push grants', async () => {
    const outcome = await runPlaybook(verdict(), deps({ operational: new Set() }), 'drop-chores');
    expect(outcome.result).toBe('escalated');
    expect(calls).toEqual([]);
  });

  it('declares its grants', () => {
    expect(REQUIRED_GRANTS['drop-chores']).toEqual(['rebase-own-branch', 'lease-push-own-branch']);
  });
});
