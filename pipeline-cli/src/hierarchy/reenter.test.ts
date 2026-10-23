import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
let warnings: string[];
let calls: { file: string; args: readonly string[] }[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'reenter-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
  calls = [];
  warnings = [];
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
  origin?: string | null;
  runId?: string | null;
}

/** A GitHub stand-in: answers the PR read, records every other command. */
function gh(v: View = {}): CommandRunner {
  return (file, args) => {
    if (file === 'git' && args[0] === 'ls-remote') {
      if (v.origin === null) return { status: 128, stdout: '', stderr: 'no route' };
      const sha = v.origin ?? v.sha ?? 'aaaaaaa1111111';
      return { status: 0, stdout: `${sha}\trefs/heads/${BRANCH}\n`, stderr: '' };
    }
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
    if (args[0] === 'run' && args[1] === 'list') {
      return { status: 0, stdout: v.runId === null ? '\n' : `${v.runId ?? '4242'}\n`, stderr: '' };
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
  warn: (l) => warnings.push(l),
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

  it('--developer-round sets resume.developerRound on the manifest (AISDLC-1053)', () => {
    failTask();
    const r = reenter({ target: '7', developerRound: true }, deps(gh()));
    expect(r.kind === 'manifest' && r.resume.developerRound).toBe(true);
  });

  it('without the flag the manifest carries no developerRound', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh()));
    expect(r.kind === 'manifest' && r.resume.developerRound).toBeUndefined();
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
    expect(calls).toEqual([{ file: 'gh', args: ['run', 'rerun', '4242', '--failed'] }]);
    expect(calls.flatMap((c) => c.args)).not.toContain('--commit');
    expect(queued()).toEqual([]);
  });

  it('falls back to executor re-entry only when no gate run id resolves', () => {
    failTask();
    const r = reenter(
      { target: '7' },
      deps(
        gh({
          runId: null,
          checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED' }],
        }),
      ),
    );
    expect(r).toMatchObject({ kind: 'manifest', state: 'cancelled-or-infra' });
    expect(calls).toEqual([]);
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

describe('reenter origin head (AISDLC-937)', () => {
  const ORIGIN = 'ccccccc3333333';
  const full = ORIGIN;

  it('a record that lags origin is accepted and the guard carries the origin head', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh({ origin: ORIGIN })));
    expect(r).toMatchObject({ kind: 'manifest', headSha: full });
    const g = JSON.parse(
      readFileSync(path.join(board, 'landing', '7', 'reentered.json'), 'utf-8'),
    ) as { headSha: string }[];
    expect(g[0]?.headSha).toBe(full);
    expect(warnings).toEqual([]);
  });

  it('refuses the same origin head and route twice', () => {
    failTask();
    reenter({ target: '7' }, deps(gh({ origin: ORIGIN })));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
    completeTask(board, { taskId: TASK, outcome: 'failed', workerId: 'exec-b', prNumber: 7 });
    expect(() => reenter({ target: '7' }, deps(gh({ origin: ORIGIN })))).toThrow(
      /loop guard: executor@ccccccc x2/,
    );
  });

  it('falls back to the recorded head and says so when ls-remote fails', () => {
    failTask();
    const r = reenter({ target: '7' }, deps(gh({ origin: null })));
    expect(r).toMatchObject({ kind: 'manifest', headSha: 'aaaaaaa1111111' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ls-remote.*recorded head aaaaaaa/);
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

describe('reenter, local HEAD ahead of the PR head (AISDLC-946)', () => {
  const ahead = (): ReenterDeps => ({
    ...deps(gh({ merge: 'DIRTY', checks: [] })),
    resolveLocalAheadHead: () => 'bbbbbbb2222222',
  });

  it('routes to the executor with a push-pending note, keyed on the local HEAD', () => {
    failTask();
    const r = reenter({ target: '7' }, ahead());
    expect(r).toMatchObject({ kind: 'manifest', headSha: 'bbbbbbb2222222' });
    const m = JSON.parse(
      readFileSync(path.join(board, 'queue', `${TASK}.dispatch.json`), 'utf-8'),
    ) as DispatchManifest;
    expect(m.resume?.note).toContain('push pending');
    expect(m.resume?.note).toContain('lease-push');
  });

  it('is not blocked by a guard entry recorded for the unchanged PR head', () => {
    failTask();
    const guard = path.join(board, 'landing', '7', 'reentered.json');
    mkdirSync(path.dirname(guard), { recursive: true });
    writeFileSync(
      guard,
      JSON.stringify([
        { action: 'executor', headSha: 'aaaaaaa1111111', at: '2026-10-15T09:00:00Z' },
      ]),
    );
    expect(() => reenter({ target: '7' }, deps(gh({ merge: 'DIRTY', checks: [] })))).toThrow(
      /loop guard/,
    );
    expect(reenter({ target: '7' }, ahead())).toMatchObject({ kind: 'manifest' });
  });
});
