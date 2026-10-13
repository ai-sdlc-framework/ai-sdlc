/**
 * Tests for resuming a finished task with feedback, the claim surface that
 * hands the feedback to the executor, and the bounded idle back-off (AISDLC-738).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDispatchCli, type DispatchCliDeps } from '../cli/dispatch.js';
import type { IdentityDeps } from '../hierarchy/index.js';
import { claimNext, ensureBoardDirs, readInflightManifest, writeManifest } from './board.js';
import { completeTask } from './complete.js';
import { requeueFailed } from './requeue.js';
import {
  IDLE_BACKOFF_MAX_SEC,
  idleBackoffSec,
  readEmptyQueueHibernateSec,
} from './idle-backoff.js';
import {
  authoriseResume,
  evaluatePushOnly,
  formatResumeFeedback,
  looksLikeCommand,
  readResumeFeedback,
  resumeDone,
  stripControl,
} from './resume.js';
import type { DispatchManifest } from './types.js';

function mkManifest(taskId: string, extra: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-slug`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`, verifyCommands: ['pnpm build'] },
    ...extra,
  };
}

let root: string;
let board: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'resume-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Run a task through claim and a success verdict, as an executor would. */
function finish(taskId: string, prNumber = 7): void {
  writeManifest(board, mkManifest(taskId));
  claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
  completeTask(board, { taskId, outcome: 'success', workerId: 'exec-a', prNumber });
}

const opts = { resumedBy: 'dispatch', now: () => new Date('2026-10-09T10:00:00.000Z') };

describe('resumeDone', () => {
  it('records the PR head ref as the branch when a --pr head is supplied (AISDLC-762.2)', () => {
    finish('AISDLC-803', 9);
    const r = resumeDone(
      board,
      'AISDLC-803',
      { note: 'again', prNumber: 9, prHeadRef: 'ai-sdlc/aisdlc-803' },
      opts,
    );
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-803');
    expect(queued.resume?.prHeadRef).toBe('ai-sdlc/aisdlc-803');
  });

  it('ignores a PR head ref when no PR number is given (AISDLC-762.2)', () => {
    finish('AISDLC-804');
    const r = resumeDone(board, 'AISDLC-804', { note: 'x', prHeadRef: 'other' }, opts);
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-804-slug');
    expect(queued.resume?.prHeadRef).toBeUndefined();
  });

  it('moves a done task back to queue/ with the feedback note and its original branch', () => {
    finish('AISDLC-801');
    const r = resumeDone(
      board,
      'AISDLC-801',
      { note: 'Raise coverage', failingChecks: ['coverage', 'attestation'], findings: ['no test'] },
      opts,
    );
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-801-slug');
    expect(queued.workerId).toBeUndefined();
    expect(queued.resume).toMatchObject({
      note: 'Raise coverage',
      prNumber: 7,
      failingChecks: ['coverage', 'attestation'],
      findings: ['no test'],
      priorOutcome: 'success',
      resumedBy: 'dispatch',
    });
    // No longer finished: the verdict and the manifest copy are gone.
    expect(existsSync(path.join(board, 'done', 'AISDLC-801.verdict.json'))).toBe(false);
    expect(existsSync(path.join(board, 'done', 'AISDLC-801.manifest.json'))).toBe(false);
  });

  it('works from a completion marker once the verdict was handled', async () => {
    finish('AISDLC-802');
    const { removeVerdict } = await import('./board.js');
    removeVerdict(board, 'AISDLC-802');
    expect(existsSync(path.join(board, 'done', 'AISDLC-802.completed.json'))).toBe(true);
    resumeDone(board, 'AISDLC-802', { note: 'again' }, opts);
    expect(existsSync(path.join(board, 'queue', 'AISDLC-802.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(board, 'done', 'AISDLC-802.completed.json'))).toBe(false);
  });

  it('rebuilds a manifest for a task finished before copies were kept', () => {
    writeFileSync(
      path.join(board, 'done', 'AISDLC-803.verdict.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-803',
        outcome: 'success',
        completedAt: '2026-10-01T00:00:00Z',
        workerId: 'w',
        prNumber: 9,
        pushedBranch: 'ai-sdlc/aisdlc-803-old',
      }),
    );
    const r = resumeDone(
      board,
      'AISDLC-803',
      { note: 'n' },
      {
        ...opts,
        resolveBaseSha: () => 'deadbee',
        resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()} - x.md`,
      },
    );
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued).toMatchObject({
      branch: 'ai-sdlc/aisdlc-803-old',
      baseSha: 'deadbee',
      resume: { prNumber: 9 },
    });
    // The verdict recorded a branch, so the name is not a guess.
    expect(queued.resume?.branchGuessed).toBeUndefined();
  });

  it('marks the branch name as a guess when the verdict recorded none', () => {
    writeFileSync(
      path.join(board, 'done', 'AISDLC-804.verdict.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-804',
        outcome: 'success',
        completedAt: '2026-10-01T00:00:00Z',
        workerId: 'w',
      }),
    );
    const r = resumeDone(
      board,
      'AISDLC-804',
      { note: 'n' },
      {
        ...opts,
        resolveBaseSha: () => 'deadbee',
        resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()} - x.md`,
      },
    );
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-804');
    expect(queued.resume?.branchGuessed).toBe(true);
  });

  it('keeps a done/ manifest copy only after the verdict, for a success', () => {
    finish('AISDLC-805');
    expect(existsSync(path.join(board, 'done', 'AISDLC-805.verdict.json'))).toBe(true);
    expect(existsSync(path.join(board, 'done', 'AISDLC-805.manifest.json'))).toBe(true);
  });

  it('refuses, writing nothing, in every unsafe state', () => {
    expect(() => resumeDone(board, 'bad', { note: 'n' }, opts)).toThrow(/not a valid task id/);
    expect(() => resumeDone(board, 'AISDLC-804', { note: '  ' }, opts)).toThrow(/feedback note/);
    expect(() => resumeDone(board, 'AISDLC-804', { note: 'x'.repeat(4001) }, opts)).toThrow(
      /at most/,
    );
    expect(() => resumeDone(board, 'AISDLC-804', { note: 'n', prNumber: 0 }, opts)).toThrow(
      /positive integer/,
    );
    expect(() =>
      resumeDone(board, 'AISDLC-804', { note: 'n', findings: Array(21).fill('f') }, opts),
    ).toThrow(/at most 20/);
    expect(() => resumeDone(board, 'AISDLC-804', { note: 'n' }, opts)).toThrow(/not in done/);

    finish('AISDLC-805');
    writeManifest(board, mkManifest('AISDLC-805'));
    expect(() => resumeDone(board, 'AISDLC-805', { note: 'n' }, opts)).toThrow(/already in queue/);
    expect(existsSync(path.join(board, 'done', 'AISDLC-805.verdict.json'))).toBe(true);

    writeFileSync(
      path.join(board, 'done', 'AISDLC-806.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-806', outcome: 'iterate-needed' }),
    );
    // iterate-needed is resumable now; with no saved manifest it cannot be rebuilt.
    expect(() => resumeDone(board, 'AISDLC-806', { note: 'n' }, opts)).toThrow(
      /none can be rebuilt/,
    );

    writeFileSync(
      path.join(board, 'done', 'AISDLC-807.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-807', outcome: 'success' }),
    );
    expect(() => resumeDone(board, 'AISDLC-807', { note: 'n' }, opts)).toThrow(
      /none can be rebuilt/,
    );

    rmSync(path.join(board, 'queue', 'AISDLC-805.dispatch.json'));
    finish('AISDLC-808');
    writeFileSync(path.join(board, 'failed', 'AISDLC-808.diagnostic.json'), '{}');
    expect(() => resumeDone(board, 'AISDLC-808', { note: 'n' }, opts)).toThrow(/use requeue/);
  });

  it('rejects a note, finding or failing check that starts like a command', () => {
    finish('AISDLC-840');
    for (const bad of [
      'cli-dispatch release --task-id X',
      'git push --force',
      '  $ gh pr view 1',
    ]) {
      expect(() => resumeDone(board, 'AISDLC-840', { note: bad }, opts)).toThrow(/must be prose/);
      expect(() => resumeDone(board, 'AISDLC-840', { note: 'ok\n' + bad }, opts)).toThrow(
        /must be prose/,
      );
      expect(() => resumeDone(board, 'AISDLC-840', { note: 'ok', findings: [bad] }, opts)).toThrow(
        /must be prose/,
      );
      expect(() =>
        resumeDone(board, 'AISDLC-840', { note: 'ok', failingChecks: [bad] }, opts),
      ).toThrow(/must be prose/);
    }
    expect(looksLikeCommand('Fix the gitignore and the github check')).toBe(false);
    expect(looksLikeCommand('Git hooks failed in CI')).toBe(false);
    expect(looksLikeCommand('GH checks are red')).toBe(false);
    expect(existsSync(path.join(board, 'done', 'AISDLC-840.verdict.json'))).toBe(true);
  });

  it('rejects command lines hidden behind escape sequences or zero-width characters', () => {
    finish('AISDLC-841');
    for (const bad of [
      '\x1b[0mgit push --force',
      '\x1b]0;x\x07gh pr view 1',
      '\u200bgit push --force',
      '\ufeff\u200dcli-dispatch release --task-id X',
    ]) {
      expect(() => resumeDone(board, 'AISDLC-841', { note: bad }, opts)).toThrow(/must be prose/);
      expect(() => resumeDone(board, 'AISDLC-841', { note: 'ok', findings: [bad] }, opts)).toThrow(
        /must be prose/,
      );
      expect(() =>
        resumeDone(board, 'AISDLC-841', { note: 'ok', failingChecks: [bad] }, opts),
      ).toThrow(/must be prose/);
    }
    expect(existsSync(path.join(board, 'done', 'AISDLC-841.verdict.json'))).toBe(true);
  });

  it('stores the stripped note, findings and failing checks', () => {
    finish('AISDLC-842');
    const r = resumeDone(
      board,
      'AISDLC-842',
      {
        note: 'fix \x1b[31mcoverage\x1b[0m',
        findings: ['a\x1b]0;t\x07b'],
        failingChecks: ['c\x1b[1md'],
      },
      opts,
    );
    expect(r.resume.note).toBe('fix coverage');
    expect(r.resume.findings).toEqual(['ab']);
    expect(r.resume.failingChecks).toEqual(['cd']);
  });

  it('writes no wave on a resume, keeps the priority and sets retryCount', () => {
    writeManifest(board, mkManifest('AISDLC-841', { wave: 3, priority: 1 }));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    completeTask(board, { taskId: 'AISDLC-841', outcome: 'success', workerId: 'exec-a' });
    const r = resumeDone(board, 'AISDLC-841', { note: 'again' }, opts);
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.wave).toBeUndefined();
    expect(queued.priority).toBe(1);
    expect(queued.retryCount).toBe(0);
  });

  it('renders the executor instruction from the fixed template', () => {
    const text = formatResumeFeedback({
      note: 'Raise coverage',
      resumedAt: '2026-10-09T10:00:00.000Z',
      resumedBy: 'dispatch',
    });
    expect(text).toContain('Run the pipeline unmodified from the existing worktree');
  });

  describe('iterate-needed verdicts (AISDLC-800)', () => {
    function iterate(taskId: string, notes = 'Reviewer wants a test for the edge case'): void {
      writeManifest(board, mkManifest(taskId, { priority: 2 }));
      claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
      completeTask(board, { taskId, outcome: 'iterate-needed', workerId: 'exec-a', notes });
    }

    it('takes over the held claim and resumes carrying the verdict notes', () => {
      iterate('AISDLC-843');
      const r = resumeDone(board, 'AISDLC-843', {}, opts);
      const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
      expect(queued.resume?.note).toBe('Reviewer wants a test for the edge case');
      expect(queued.resume?.priorOutcome).toBe('iterate-needed');
      expect(queued.priority).toBe(2);
      expect(queued.wave).toBeUndefined();
      expect(existsSync(path.join(board, 'done', 'AISDLC-843.verdict.json'))).toBe(false);
    });

    it('drops command-looking lines from the verdict notes and falls back when none remain', () => {
      iterate('AISDLC-844', 'Add a test\ngit push --force\n');
      expect(resumeDone(board, 'AISDLC-844', {}, opts).resume.note).toBe('Add a test');
    });

    it('falls back to a fixed sentence when no prose is left', () => {
      iterate('AISDLC-845', 'cli-dispatch release');
      expect(resumeDone(board, 'AISDLC-845', {}, opts).resume.note).toMatch(/no notes/);
    });

    it('lets an explicit note override the verdict notes', () => {
      iterate('AISDLC-846');
      expect(resumeDone(board, 'AISDLC-846', { note: 'Do this instead' }, opts).resume.note).toBe(
        'Do this instead',
      );
    });
  });

  it('strips control characters from list entries', () => {
    finish('AISDLC-809');
    const r = resumeDone(board, 'AISDLC-809', { note: 'n', findings: ['a\u001b[31m\nb'] }, opts);
    expect(r.resume.findings).toEqual(['a b']);
  });
});

describe('resume from iterate-needed and failed verdicts (AISDLC-807)', () => {
  function runTo(taskId: string, outcome: 'iterate-needed' | 'failed'): void {
    writeManifest(board, mkManifest(taskId));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    completeTask(board, { taskId, outcome, workerId: 'exec-a', prNumber: 9 });
  }

  it('resumes an iterate-needed verdict and records where it came from', () => {
    runTo('AISDLC-831', 'iterate-needed');
    const r = resumeDone(board, 'AISDLC-831', { note: 'Fix it', prNumber: 12 }, opts);
    expect(r.resume).toMatchObject({
      note: 'Fix it',
      prNumber: 12,
      fromVerdictOutcome: 'iterate-needed',
    });
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-831-slug');
    expect(existsSync(path.join(board, 'done', 'AISDLC-831.verdict.json'))).toBe(false);
  });

  it('resumes a verdict in failed/ and clears every failure record', () => {
    runTo('AISDLC-832', 'failed');
    writeFileSync(path.join(board, 'failed', 'AISDLC-832.diagnostic.json'), '{}');
    expect(existsSync(path.join(board, 'failed', 'AISDLC-832.verdict.json'))).toBe(true);
    const r = resumeDone(board, 'AISDLC-832', { note: 'Try again' }, opts);
    expect(r.resume).toMatchObject({
      note: 'Try again',
      prNumber: 9,
      fromVerdictOutcome: 'failed',
    });
    for (const f of ['verdict', 'diagnostic', 'manifest']) {
      expect(existsSync(path.join(board, 'failed', `AISDLC-832.${f}.json`))).toBe(false);
    }
  });

  it('records success for a task resumed from a success verdict', () => {
    finish('AISDLC-833');
    expect(resumeDone(board, 'AISDLC-833', { note: 'n' }, opts).resume.fromVerdictOutcome).toBe(
      'success',
    );
  });

  it('still refuses a task with no verdict at all, and one with only a diagnostic', () => {
    expect(() => resumeDone(board, 'AISDLC-834', { note: 'n' }, opts)).toThrow(/not in done/);
    writeFileSync(path.join(board, 'failed', 'AISDLC-835.diagnostic.json'), '{}');
    expect(() => resumeDone(board, 'AISDLC-835', { note: 'n' }, opts)).toThrow(/use requeue/);
  });

  it('requeueFailed with a note writes resume.note on the same channel', () => {
    runTo('AISDLC-836', 'failed');
    const r = requeueFailed(board, 'AISDLC-836', {
      note: ' Look at the lint ',
      requeuedBy: 'dispatch',
    });
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.retryCount).toBe(1);
    expect(queued.resume).toMatchObject({
      note: 'Look at the lint',
      resumedBy: 'dispatch',
      fromVerdictOutcome: 'failed',
    });
  });

  it('requeueFailed refuses an empty note, writing nothing', () => {
    runTo('AISDLC-837', 'failed');
    expect(() => requeueFailed(board, 'AISDLC-837', { note: '  ' })).toThrow(/feedback note/);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-837.verdict.json'))).toBe(true);
  });

  it('requeueFailed tolerates an unreadable failure verdict and defaults the author', () => {
    runTo('AISDLC-838', 'failed');
    writeFileSync(path.join(board, 'failed', 'AISDLC-838.verdict.json'), 'not json');
    const r = requeueFailed(board, 'AISDLC-838', { note: 'n' });
    expect(r.retryCount).toBe(1);
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.resume?.resumedBy).toBe('dispatch');
    expect(queued.resume?.fromVerdictOutcome).toBeUndefined();
  });
});

describe('feedback reaches the executor', () => {
  it('formats the note, PR, failing checks and findings', () => {
    const text = formatResumeFeedback({
      note: 'Fix it',
      prNumber: 12,
      failingChecks: ['coverage'],
      findings: ['missing test'],
      resumedAt: 'x',
      resumedBy: 'dispatch',
    });
    expect(text).toContain('pull request #12');
    expect(text).toContain('Fix it');
    expect(text).toContain('- coverage');
    expect(text).toContain('- missing test');
    const dirty = formatResumeFeedback({
      note: 'a\u001b[31mred\u001b[0m\u0007\nline2',
      failingChecks: ['c\u001b]0;title\u0007k'],
      findings: ['f\u0000g'],
      resumedAt: 'x',
      resumedBy: 'd\u001b[1m',
    });
    // eslint-disable-next-line no-control-regex
    expect(dirty).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(dirty).toContain('ared\nline2');
    expect(stripControl('x\u001b[2Jy\ttab')).toBe('xy tab');
    expect(formatResumeFeedback({ note: 'n', resumedAt: 'x', resumedBy: 'd' })).toContain(
      'do not create a new one',
    );
  });

  it('reads the feedback from the claimed manifest only', () => {
    finish('AISDLC-810');
    resumeDone(board, 'AISDLC-810', { note: 'again' }, opts);
    expect(readResumeFeedback(board, 'AISDLC-810')).toBeUndefined(); // queued, not claimed
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
    expect(readResumeFeedback(board, 'AISDLC-810')?.note).toBe('again');
    expect(readResumeFeedback(board, 'bad id')).toBeUndefined();
    expect(readInflightManifest(board, 'AISDLC-810')?.workerId).toBe('exec-b');
  });

  it('a task without feedback is claimed exactly as before', () => {
    writeManifest(board, mkManifest('AISDLC-811'));
    const claim = claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    expect(claim.claimed).toBe(true);
    expect(readResumeFeedback(board, 'AISDLC-811')).toBeUndefined();
  });
});

describe('authoriseResume', () => {
  const roster = (
    sessions: { name: string; role: string; pid: number; status: string }[],
    start = 500,
  ): IdentityDeps => ({
    readSessions: () => sessions,
    parentPid: (pid) => (pid === 500 ? 401 : null),
    comm: (pid) => (pid === 401 ? 'claude' : 'zsh'),
    startPid: start,
  });
  const dispatch = { name: 'dispatch', role: 'operator-dispatch', pid: 400, status: 'running' };
  const executor = { name: 'exec-b', role: 'executor', pid: 401, status: 'running' };

  function resumedAndClaimed(taskId: string, by = 'dispatch'): void {
    finish(taskId);
    resumeDone(board, taskId, { note: 'again' }, { ...opts, resumedBy: by });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
  }

  it('accepts a block left by a dispatch session, claimed by this session', () => {
    resumedAndClaimed('AISDLC-830');
    const r = authoriseResume(board, 'AISDLC-830', roster([dispatch, executor]));
    expect(r).toMatchObject({ ok: true, feedback: { note: 'again' } });
  });

  it('says nothing when the manifest has no resume block', () => {
    writeManifest(board, mkManifest('AISDLC-831'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' });
    expect(authoriseResume(board, 'AISDLC-831', roster([dispatch, executor]))).toBeUndefined();
  });

  it('refuses a block whose author is not a dispatch-role session in the roster', () => {
    resumedAndClaimed('AISDLC-832', 'mallory');
    const r = authoriseResume(board, 'AISDLC-832', roster([dispatch, executor]));
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.reason).toMatch(/not a dispatch session in the roster/);
  });

  it('refuses a block left by a roster name that has another role', () => {
    // A roster name that exists but with another role is not enough.
    resumedAndClaimed('AISDLC-833', 'exec-b');
    const r2 = authoriseResume(board, 'AISDLC-833', roster([dispatch, executor]));
    expect(r2?.ok).toBe(false);
  });

  it('refuses a manifest claimed by another session when this session is identifiable', () => {
    resumedAndClaimed('AISDLC-834');
    const other = { ...executor, name: 'exec-c' };
    const r = authoriseResume(board, 'AISDLC-834', roster([dispatch, other]));
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.reason).toMatch(/claimed by 'exec-b', not by this session \('exec-c'\)/);
  });

  it('skips the worker check when this session cannot be identified', () => {
    resumedAndClaimed('AISDLC-835');
    // No ancestor of the start pid is a roster entry.
    const r = authoriseResume(board, 'AISDLC-835', roster([dispatch], 999));
    expect(r?.ok).toBe(true);
  });

  it('refuses when the roster is unreadable', () => {
    resumedAndClaimed('AISDLC-836');
    const broken: IdentityDeps = {
      ...roster([dispatch, executor]),
      readSessions: () => {
        throw new Error('boom');
      },
    };
    expect(authoriseResume(board, 'AISDLC-836', broken)?.ok).toBe(false);
  });
});

describe('cli-dispatch resume and claim', () => {
  const asCaller = (role: string): IdentityDeps => ({
    readSessions: () => [{ name: role, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });
  const allowed: DispatchCliDeps = {
    identity: asCaller('operator-dispatch'),
    operational: new Set(['requeue']),
  };

  async function cli(
    argv: string[],
    deps: DispatchCliDeps = allowed,
  ): Promise<{ exit: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      stdout += c.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      stderr += c.toString();
      return true;
    }) as typeof process.stderr.write);
    const exit = await runDispatchCli(argv, deps);
    return { exit, stdout, stderr };
  }

  it('accepts the singular --failing-check flag', async () => {
    finish('AISDLC-821');
    const r = await cli([
      'resume',
      '--board-dir',
      board,
      '--task-id',
      'AISDLC-821',
      '--note',
      'Coverage is low',
      '--failing-check',
      'coverage',
      '--work-dir',
      root,
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout.trim()).resume.failingChecks).toEqual(['coverage']);
  });

  it('resumes a done task and the next claim surfaces the feedback note', async () => {
    finish('AISDLC-820');
    const r = await cli([
      'resume',
      '--board-dir',
      board,
      '--task-id',
      'AISDLC-820',
      '--note',
      'Coverage is 70 percent',
      '--failing-checks',
      'coverage,attestation',
      '--work-dir',
      root,
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(true);

    vi.restoreAllMocks();
    const claim = await cli(
      ['claim', '--board-dir', board, '--worker-kind', 'in-session-agent', '--worker', 'exec-z'],
      {},
    );
    const parsed = JSON.parse(claim.stdout.trim());
    expect(parsed.claimed).toBe(true);
    expect(parsed.resumeFeedback).toContain('Coverage is 70 percent');
    expect(parsed.resumeFeedback).toContain('- coverage');
    expect(parsed.resumeFeedback).toContain('pull request #7');
  });

  it('records the caller roster name as resumedBy when --worker is omitted', async () => {
    finish('AISDLC-822');
    const r = await cli([
      'resume',
      '--board-dir',
      board,
      '--task-id',
      'AISDLC-822',
      '--note',
      'raise coverage',
      '--work-dir',
      root,
    ]);
    expect(r.exit).toBe(0);
    const queued = JSON.parse(
      readFileSync(path.join(board, 'queue', 'AISDLC-822.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    // The documented command omits --worker: resumedBy must be the roster name, not a pid label.
    expect(queued.resume?.resumedBy).toBe('operator-dispatch');
  });

  it('reads the note from a file', async () => {
    finish('AISDLC-821');
    const noteFile = path.join(root, 'note.txt');
    writeFileSync(noteFile, 'from file');
    const r = await cli([
      'resume',
      '--board-dir',
      board,
      '--task-id',
      'AISDLC-821',
      '--note-file',
      noteFile,
      '--work-dir',
      root,
    ]);
    expect(r.exit).toBe(0);
    const queued = JSON.parse(
      readFileSync(path.join(board, 'queue', 'AISDLC-821.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(queued.resume?.note).toBe('from file');
  });

  it('reads a note file under the board dir, and refuses outside files and oversized ones', async () => {
    finish('AISDLC-823');
    const base = ['resume', '--board-dir', board, '--work-dir', root, '--task-id', 'AISDLC-823'];
    const inBoard = path.join(board, 'note.txt');
    writeFileSync(inBoard, 'in board');
    const outside = path.join(process.cwd(), 'package.json');
    const outsideRes = await cli([...base, '--note-file', outside]);
    expect(outsideRes.exit).toBe(2);
    expect(outsideRes.stderr).toContain('--note-file must be under');
    const big = path.join(root, 'big.txt');
    writeFileSync(big, 'x'.repeat(4000 * 4 + 1));
    vi.restoreAllMocks();
    const bigRes = await cli([...base, '--note-file', big]);
    expect(bigRes.exit).toBe(2);
    expect(bigRes.stderr).toContain('note limit');
    vi.restoreAllMocks();
    expect((await cli([...base, '--note-file', path.join(root, 'missing.txt')])).exit).toBe(2);
    vi.restoreAllMocks();
    expect((await cli([...base, '--note-file', inBoard])).exit).toBe(0);
  });

  it('refuses bad input, a wrong caller, a missing grant and a task that is not done', async () => {
    finish('AISDLC-822');
    const base = ['resume', '--board-dir', board, '--work-dir', root];
    expect((await cli([...base, '--task-id', 'x', '--note', 'n'])).exit).toBe(2);
    expect((await cli([...base, '--task-id', 'AISDLC-822'])).exit).toBe(1);
    expect(
      (await cli([...base, '--task-id', 'AISDLC-822', '--note', 'n', '--pr', 'zz'])).exit,
    ).toBe(2);
    expect(
      (
        await cli([...base, '--task-id', 'AISDLC-822', '--note', 'n'], {
          identity: asCaller('executor'),
          operational: new Set(['requeue']),
        })
      ).exit,
    ).toBe(1);
    expect(
      (
        await cli([...base, '--task-id', 'AISDLC-822', '--note', 'n'], {
          identity: asCaller('operator-dispatch'),
          operational: new Set(),
        })
      ).exit,
    ).toBe(1);
    expect((await cli([...base, '--task-id', 'AISDLC-899', '--note', 'n'])).exit).toBe(1);
    expect(existsSync(path.join(board, 'done', 'AISDLC-822.verdict.json'))).toBe(true);
  });
});

describe('cli-dispatch resume, requeue --note and release (AISDLC-807)', () => {
  const asCaller = (role: string): IdentityDeps => ({
    readSessions: () => [{ name: role, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });
  const allowed: DispatchCliDeps = {
    identity: asCaller('operator-dispatch'),
    operational: new Set(['requeue']),
  };

  async function cli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      stdout += c.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      stderr += c.toString();
      return true;
    }) as typeof process.stderr.write);
    const exit = await runDispatchCli(argv, allowed);
    return { exit, stdout, stderr };
  }

  function run(taskId: string, outcome: 'iterate-needed' | 'failed'): void {
    writeManifest(board, mkManifest(taskId));
    claimNext(board, 'in-session-agent', undefined, { workerId: `exec-${taskId}` });
    completeTask(board, { taskId, outcome, workerId: `exec-${taskId}` });
  }
  const queued = (id: string): DispatchManifest =>
    JSON.parse(
      readFileSync(path.join(board, 'queue', `${id}.dispatch.json`), 'utf-8'),
    ) as DispatchManifest;
  const base = () => ['--board-dir', board, '--work-dir', root];

  it('resume accepts an iterate-needed verdict and a failed verdict', async () => {
    run('AISDLC-841', 'iterate-needed');
    run('AISDLC-842', 'failed');
    const a = await cli([
      'resume',
      ...base(),
      '--task-id',
      'AISDLC-841',
      '--pr',
      '5',
      '--note',
      'T',
    ]);
    expect(a.exit).toBe(0);
    expect(queued('AISDLC-841').resume).toMatchObject({
      prNumber: 5,
      note: 'T',
      fromVerdictOutcome: 'iterate-needed',
    });
    const b = await cli([
      'resume',
      ...base(),
      '--task-id',
      'AISDLC-842',
      '--pr',
      '6',
      '--note',
      'T',
    ]);
    expect(b.exit).toBe(0);
    expect(queued('AISDLC-842').resume).toMatchObject({
      prNumber: 6,
      fromVerdictOutcome: 'failed',
    });
  });

  it('resume with no verdict refuses with the existing message', async () => {
    const r = await cli(['resume', ...base(), '--task-id', 'AISDLC-843', '--note', 'T']);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/is not in done\/; only a finished task can be resumed/);
  });

  it('requeue --note writes resume.note, and a blank --note exits 2', async () => {
    run('AISDLC-844', 'failed');
    expect((await cli(['requeue', ...base(), '--task-id', 'AISDLC-844', '--note'])).exit).toBe(2);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-844.verdict.json'))).toBe(true);
    const r = await cli(['requeue', ...base(), '--task-id', 'AISDLC-844', '--note', 'Check lint']);
    expect(r.exit).toBe(0);
    expect(queued('AISDLC-844').resume).toMatchObject({
      note: 'Check lint',
      resumedBy: 'operator-dispatch',
    });
  });

  it('release refuses a task with a done verdict, naming resume and remove-verdict', async () => {
    finish('AISDLC-845');
    writeManifest(board, mkManifest('AISDLC-845'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    const r = await cli(['release', '--board-dir', board, '--task-id', 'AISDLC-845']);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/resume/);
    expect(r.stderr).toMatch(/remove-verdict/);
    expect(existsSync(path.join(board, 'queue', 'AISDLC-845.dispatch.json'))).toBe(false);
  });

  it('release still works for a task with no verdict', async () => {
    writeManifest(board, mkManifest('AISDLC-846'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    const r = await cli(['release', '--board-dir', board, '--task-id', 'AISDLC-846']);
    expect(r.exit).toBe(0);
    expect(existsSync(path.join(board, 'queue', 'AISDLC-846.dispatch.json'))).toBe(true);
  });
});

describe('idle back-off', () => {
  it('stays within a minute whatever the config asks for', () => {
    expect(idleBackoffSec()).toBe(30);
    expect(idleBackoffSec(1800)).toBe(IDLE_BACKOFF_MAX_SEC);
    expect(idleBackoffSec(1)).toBe(5);
    expect(idleBackoffSec(Number.NaN)).toBe(30);
    expect(idleBackoffSec(45)).toBe(45);
  });

  it('reads emptyQueueHibernateSec from the dispatch config', () => {
    expect(readEmptyQueueHibernateSec(root)).toBeUndefined();
    mkdirSync(path.join(root, '.ai-sdlc'), { recursive: true });
    const file = path.join(root, '.ai-sdlc', 'dispatch-config.yaml');
    writeFileSync(file, 'spec:\n  inSessionAgent:\n    emptyQueueHibernateSec: 1800\n');
    expect(readEmptyQueueHibernateSec(root)).toBe(1800);
    writeFileSync(file, 'spec: [broken');
    expect(readEmptyQueueHibernateSec(root)).toBeUndefined();
    writeFileSync(file, 'spec:\n  inSessionAgent:\n    emptyQueueHibernateSec: soon\n');
    expect(readEmptyQueueHibernateSec(root)).toBeUndefined();
  });

  it('idle-backoff prints a sleep of at most a minute, and claim output is unchanged', async () => {
    mkdirSync(path.join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      path.join(root, '.ai-sdlc', 'dispatch-config.yaml'),
      'spec:\n  inSessionAgent:\n    emptyQueueHibernateSec: 1800\n',
    );
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      stdout += c.toString();
      return true;
    }) as typeof process.stdout.write);
    expect(await runDispatchCli(['idle-backoff', '--work-dir', root], {})).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ sleepSec: 60 });
    stdout = '';
    await runDispatchCli(
      ['claim', '--board-dir', board, '--worker-kind', 'in-session-agent', '--work-dir', root],
      {},
    );
    expect(JSON.parse(stdout.trim())).toEqual({ claimed: false });
  });
});

describe('push-only resume (AISDLC-821)', () => {
  it('records resumeMode push-only and prints it; no flag leaves it unset', () => {
    finish('AISDLC-830');
    const r = resumeDone(board, 'AISDLC-830', { note: 'n', pushOnly: true }, opts);
    expect(r.resume.resumeMode).toBe('push-only');
    const queued = JSON.parse(readFileSync(r.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued.resume?.resumeMode).toBe('push-only');
    expect(formatResumeFeedback(r.resume)).toContain('RESUME MODE: push-only');
  });

  it('leaves resumeMode unset without the flag', () => {
    finish('AISDLC-831');
    const plain = resumeDone(board, 'AISDLC-831', { note: 'n' }, opts);
    expect(plain.resume.resumeMode).toBeUndefined();
    expect(formatResumeFeedback(plain.resume)).not.toContain('RESUME MODE');
  });

  it('cli-dispatch resume --push-only sets the mode', async () => {
    finish('AISDLC-832');
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    const exit = await runDispatchCli(
      [
        'resume',
        '--board-dir',
        board,
        '--task-id',
        'AISDLC-832',
        '--note',
        'n',
        '--push-only',
        '--work-dir',
        root,
      ],
      {
        identity: {
          readSessions: () => [
            { name: 'operator-dispatch', role: 'operator-dispatch', pid: 400, status: 'running' },
          ],
          parentPid: (pid) => (pid === 500 ? 400 : null),
          comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
          startPid: 500,
        },
        operational: new Set(['requeue']),
      },
    );
    vi.restoreAllMocks();
    expect(exit).toBe(0);
    const queued = JSON.parse(
      readFileSync(path.join(board, 'queue', 'AISDLC-832.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(queued.resume?.resumeMode).toBe('push-only');
  });

  describe('evaluatePushOnly', () => {
    const writeVerdict = (wt: string, id: string, body: unknown): void => {
      mkdirSync(path.join(wt, '.ai-sdlc', 'verdicts'), { recursive: true });
      writeFileSync(
        path.join(wt, '.ai-sdlc', 'verdicts', `${id.toLowerCase()}.json`),
        typeof body === 'string' ? body : JSON.stringify(body),
      );
    };
    const good = { taskId: 'AISDLC-840', approved: true, decision: 'APPROVED' };
    it('accepts an approval whose content still matches', () => {
      writeVerdict(root, 'AISDLC-840', good);
      expect(evaluatePushOnly(root, 'AISDLC-840', { contentMatches: () => true })).toEqual({
        mode: 'push-only',
      });
    });
    it('computes the verdict when the file is missing but the content is approved', () => {
      expect(evaluatePushOnly(root, 'AISDLC-841', { contentMatches: () => true })).toEqual({
        mode: 'push-only',
        verdictMissing: true,
      });
    });
    it('falls back when the verdict file is missing and the content is not approved', () => {
      const d = evaluatePushOnly(root, 'AISDLC-841', { contentMatches: () => false });
      expect(d).toMatchObject({ mode: 'normal' });
      expect((d as { reason: string }).reason).toContain('no verdict file');
    });
    it('falls back when the verdict is unreadable, foreign or not an approval', () => {
      writeVerdict(root, 'AISDLC-842', '{nope');
      writeVerdict(root, 'AISDLC-843', { ...good, taskId: 'AISDLC-1' });
      writeVerdict(root, 'AISDLC-844', { ...good, approved: false, decision: 'CHANGES_REQUESTED' });
      for (const id of ['AISDLC-842', 'AISDLC-843', 'AISDLC-844']) {
        expect(evaluatePushOnly(root, id, { contentMatches: () => true }).mode).toBe('normal');
      }
    });
    it('falls back when the content no longer matches or cannot be checked', () => {
      writeVerdict(root, 'AISDLC-845', { ...good, taskId: 'AISDLC-845' });
      expect(evaluatePushOnly(root, 'AISDLC-845', { contentMatches: () => false }).mode).toBe(
        'normal',
      );
      expect(evaluatePushOnly(root, 'AISDLC-845').mode).toBe('normal');
    });
  });
});
