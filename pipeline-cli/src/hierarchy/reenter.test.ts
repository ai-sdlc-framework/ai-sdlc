import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimNext,
  ensureBoardDirs,
  readInflightManifest,
  writeManifest,
} from '../dispatch/board.js';
import { completeTask } from '../dispatch/complete.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { reenter, type ReenterDeps } from './reenter.js';
import type { CommandRunner } from './types.js';

const TASK = 'AISDLC-950';
const BRANCH = 'ai-sdlc/aisdlc-950-the-real-branch';

let root: string;
let board: string;
let calls: { file: string; args: readonly string[] }[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'reenter-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId: TASK,
    branch: BRANCH,
    worktree: `.worktrees/${TASK.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
  };
}

/** The task ran, opened PR 7 and failed: `failed/` holds the verdict and the manifest copy. */
function failTask(): void {
  writeManifest(board, manifest());
  claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
  completeTask(board, { taskId: TASK, outcome: 'failed', workerId: 'exec-a', prNumber: 7 });
}

interface View {
  sha?: string;
  merge?: string;
  state?: string;
  checks?: unknown[];
}

/** A GitHub stand-in: answers the PR read, records every other command. */
function gh(v: View = {}): CommandRunner {
  return (file, args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          number: 7,
          title: `feat: thing (${TASK})`,
          state: v.state ?? 'OPEN',
          headRefName: BRANCH,
          headRefOid: v.sha ?? 'aaaaaaa1111111',
          isDraft: true,
          mergeStateStatus: v.merge ?? 'BLOCKED',
          statusCheckRollup: v.checks ?? [
            {
              name: 'ai-sdlc/pr-ready',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              title: 'test foo > bar failed',
            },
          ],
        }),
      };
    }
    calls.push({ file, args });
    return { status: 0, stdout: '', stderr: '' };
  };
}

const deps = (run: CommandRunner): ReenterDeps => ({
  boardDir: board,
  run,
  cwd: root,
  reenteredBy: 'operator-dispatch',
  now: () => new Date('2026-10-15T10:00:00.000Z'),
});

const queued = (): string[] => readdirSync(path.join(board, 'queue'));
const failedFiles = (): string[] =>
  readdirSync(path.join(board, 'failed')).filter((f) => f.startsWith(TASK));

describe('reenter, a real failure on the head', () => {
  it('writes one manifest naming the branch, head SHA and failing line', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh()));
    expect(r).toMatchObject({ kind: 'manifest', pr: 7, taskId: TASK, headSha: 'aaaaaaa1111111' });
    expect(queued()).toEqual([`${TASK}.dispatch.json`]);
    const m = JSON.parse(
      readFileSync(path.join(board, 'queue', `${TASK}.dispatch.json`), 'utf-8'),
    ) as DispatchManifest;
    expect(m.branch).toBe(BRANCH);
    expect(m.resume).toMatchObject({
      prNumber: 7,
      prHeadRef: BRANCH,
      headSha: 'aaaaaaa1111111',
      failingLine: 'test foo > bar failed',
      resumedBy: 'operator-dispatch',
    });
    expect(m.resume?.note).toContain('test foo > bar failed');
    expect(calls).toEqual([]);
  });

  it('an executor that claims it works on the PR branch; no new branch is made', () => {
    failTask();
    reenter({ target: TASK }, deps(gh()));
    const claim = claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
    expect(claim.claimed).toBe(true);
    const held = readInflightManifest(board, TASK);
    expect(held?.branch).toBe(BRANCH);
    expect(held?.resume?.prHeadRef).toBe(BRANCH);
    expect(held?.resume?.branchGuessed).toBeUndefined();
  });

  it('moves the failed verdict and manifest to landing/<pr>/history/', () => {
    failTask();
    expect(failedFiles().length).toBeGreaterThan(0);
    reenter({ target: '7' }, deps(gh()));
    expect(failedFiles()).toEqual([]);
    const history = readdirSync(path.join(board, 'landing', '7', 'history'));
    expect(history.some((f) => f.startsWith(`${TASK}.verdict.json.`))).toBe(true);
    expect(history.some((f) => f.startsWith(`${TASK}.manifest.json.`))).toBe(true);
  });

  it('a reaped claim (diagnostic only) re-enters too', () => {
    failTask();
    const failed = path.join(board, 'failed');
    rmSync(path.join(failed, `${TASK}.verdict.json`));
    writeFileSync(path.join(failed, `${TASK}.diagnostic.json`), '{}');
    const r = reenter({ target: '7' }, deps(gh()));
    expect(r.kind).toBe('manifest');
    expect(failedFiles()).toEqual([]);
  });

  it('an attestation content mismatch orders a push-only round', () => {
    failTask();
    const r = reenter(
      { target: '7' },
      deps(
        gh({
          checks: [
            {
              name: 'ai-sdlc/attestation',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              title: 'content hash mismatch',
            },
          ],
        }),
      ),
    );
    expect(r.kind === 'manifest' && r.resume.resumeMode).toBe('push-only');
  });

  it('a DIRTY PR is a semantic conflict for an executor', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh({ merge: 'DIRTY', checks: [] })));
    expect(r).toMatchObject({ kind: 'manifest', state: 'behind-or-dirty' });
    expect(calls).toEqual([]);
  });
});

describe('reenter, a machine action', () => {
  it('a BEHIND PR is rebased and no manifest is written', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh({ merge: 'BEHIND' })));
    expect(r).toMatchObject({ kind: 'machine', action: 'rebase' });
    expect(calls).toEqual([{ file: 'gh', args: ['pr', 'update-branch', '7', '--rebase'] }]);
    expect(queued()).toEqual([]);
    expect(failedFiles().length).toBeGreaterThan(0);
  });

  it('a cancelled check is rerun on the head and no manifest is written', () => {
    const r = reenter(
      { target: '7' },
      deps(gh({ checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED' }] })),
    );
    expect(r).toMatchObject({ kind: 'machine', action: 'rerun' });
    expect(calls[0]?.args).toEqual(['run', 'rerun', '--failed', '--commit', 'aaaaaaa1111111']);
    expect(queued()).toEqual([]);
  });

  it('reports a failing machine action and does not record it', () => {
    const bad: CommandRunner = (f, a) =>
      a[1] === 'view'
        ? gh({ merge: 'BEHIND' })(f, a)
        : { status: 1, stdout: '', stderr: 'rebase refused\nmore' };
    expect(() => reenter({ target: '7' }, deps(bad))).toThrow(/rebase of pull request #7 failed/);
    expect(existsSync(path.join(board, 'landing', '7', 'reentered.json'))).toBe(false);
  });
});

describe('reenter loop guard (AISDLC-883)', () => {
  it('refuses the same head twice, and allows it again after a new head', () => {
    failTask();
    reenter({ target: '7' }, deps(gh()));
    // The round failed again without a new push: the manifest and failure come back.
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
    completeTask(board, { taskId: TASK, outcome: 'failed', workerId: 'exec-b', prNumber: 7 });
    expect(() => reenter({ target: '7' }, deps(gh()))).toThrow(/loop guard: executor@aaaaaaa x2/);
    expect(queued()).toEqual([]);
    const r = reenter({ target: '7' }, deps(gh({ sha: 'bbbbbbb2222222' })));
    expect(r).toMatchObject({ kind: 'manifest', headSha: 'bbbbbbb2222222' });
  });

  it('guards a machine action on the same head too', () => {
    reenter({ target: '7' }, deps(gh({ merge: 'BEHIND' })));
    expect(() => reenter({ target: '7' }, deps(gh({ merge: 'BEHIND' })))).toThrow(/loop guard/);
    expect(calls).toHaveLength(1);
  });
});

describe('reenter refusals', () => {
  it('names nothing to do for a green or pending PR, unless a note orders a round', () => {
    failTask();
    const green = gh({ checks: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    expect(() => reenter({ target: '7' }, deps(green))).toThrow(/nothing to re-enter/);
    const r = reenter({ target: '7', note: 'Please recheck the docs' }, deps(green));
    expect(r.kind).toBe('manifest');
  });

  it('refuses merged and closed PRs, bad targets and unreadable PRs', () => {
    expect(() => reenter({ target: '7' }, deps(gh({ state: 'MERGED' })))).toThrow(/merged/);
    expect(() => reenter({ target: '7' }, deps(gh({ state: 'CLOSED' })))).toThrow(/closed/);
    expect(() => reenter({ target: 'nope' }, deps(gh()))).toThrow(/neither/);
    const fail: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'x' });
    expect(() => reenter({ target: '7' }, deps(fail))).toThrow(/could not be read/);
    expect(() => reenter({ target: TASK }, deps(fail))).toThrow(/has no pull request/);
  });

  it('refuses a task with no verdict, writing nothing', () => {
    expect(() => reenter({ target: '7' }, deps(gh()))).toThrow(/not in done/);
    expect(queued()).toEqual([]);
    expect(existsSync(path.join(board, 'landing', '7', 'reentered.json'))).toBe(false);
  });
});
