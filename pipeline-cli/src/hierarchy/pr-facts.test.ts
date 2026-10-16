import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstFailingLine, gatherPrFacts, toMergeStateStatus } from './pr-facts.js';
import { classifyPr } from './pr-state.js';
import type { CommandRunner } from './types.js';

describe('toMergeStateStatus', () => {
  it.each([
    ['clean', 'CLEAN'],
    ['behind', 'BEHIND'],
    ['dirty', 'DIRTY'],
    ['blocked', 'BLOCKED'],
    ['unstable', 'UNSTABLE'],
    ['has_hooks', 'HAS_HOOKS'],
    ['draft', 'DRAFT'],
    ['unknown', 'UNKNOWN'],
    ['CLEAN', 'CLEAN'],
    ['weird', 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
  ])('maps %s to %s', (raw, want) => {
    expect(toMergeStateStatus(raw)).toBe(want);
  });
});

describe('firstFailingLine', () => {
  it('picks the first error line and strips the log prefix', () => {
    const log = [
      'build\tSetup\t2026-10-14T10:00:00.1Z starting',
      'build\tTest\t2026-10-14T10:00:01.1Z FAIL src/a.test.ts > adds',
      'build\tTest\t2026-10-14T10:00:02.1Z ##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(firstFailingLine(log)).toBe('FAIL src/a.test.ts > adds');
  });
  it('falls back to the first non-blank line, and undefined for an empty log', () => {
    expect(firstFailingLine('\n\nsomething odd\n')).toBe('something odd');
    expect(firstFailingLine('')).toBeUndefined();
  });
});

describe('gatherPrFacts', () => {
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  const make = (mergeStateStatus: string | undefined, logStatus = 0): CommandRunner => {
    return (_file, args) => {
      const a = args.join(' ');
      if (a.startsWith('pr list'))
        return ok(
          JSON.stringify([
            {
              number: 7,
              title: 'chore(docs): file x',
              headRefName: 'ai-sdlc/file-x',
              isDraft: false,
              isCrossRepository: false,
              author: { login: 'me' },
              ...(mergeStateStatus ? { mergeStateStatus } : {}),
              files: [],
            },
          ]),
        );
      if (a.startsWith('api user')) return ok('me');
      if (a.startsWith('api repos/')) return ok('behind');
      if (a.startsWith('pr view 7'))
        return ok(
          JSON.stringify({
            statusCheckRollup: [
              {
                name: 'ai-sdlc/pr-ready',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                detailsUrl: 'https://github.com/o/r/actions/runs/555/job/9',
              },
            ],
          }),
        );
      if (a.startsWith('run view 555'))
        return logStatus === 0
          ? ok('build\tTest\t2026-10-14T10:00:01Z FAIL src/a.test.ts > adds\n')
          : { status: 1, stdout: '', stderr: 'no' };
      return { status: 1, stdout: '', stderr: '' };
    };
  };
  const board = mkdtempSync(path.join(os.tmpdir(), 'pr-facts-'));

  it('fills the failing line from the job log and keeps a GraphQL merge state', () => {
    const facts = gatherPrFacts(make('CLEAN'), '/', board);
    expect(facts).toHaveLength(1);
    expect(facts?.[0]?.mergeStateStatus).toBe('CLEAN');
    expect(facts?.[0]?.checks?.[0]?.summary).toBe('FAIL src/a.test.ts > adds');
    expect(classifyPr({ ...facts![0]!, taskId: 'AISDLC-1' })).toMatchObject({
      state: 'real-failure',
      failingLine: 'FAIL src/a.test.ts > adds',
    });
  });

  it('reads the log of a short failed job so the rate-limit signature matches (AISDLC-949)', () => {
    const run: CommandRunner = (file, args) => {
      const a = args.join(' ');
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
      if (a.startsWith('pr list'))
        return ok(
          JSON.stringify([
            {
              number: 7,
              title: 'chore(docs): file x',
              headRefName: 'ai-sdlc/file-x',
              isDraft: false,
              isCrossRepository: false,
              author: { login: 'me' },
              mergeStateStatus: 'CLEAN',
              files: [],
            },
          ]),
        );
      if (a.startsWith('api user')) return ok('me');
      if (a.startsWith('pr view 7'))
        return ok(
          JSON.stringify({
            statusCheckRollup: [
              {
                name: 'Detect Changes',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                startedAt: '2026-10-16T19:29:00Z',
                completedAt: '2026-10-16T19:29:06Z',
                detailsUrl: 'https://github.com/o/r/actions/runs/555/job/9',
              },
              {
                name: 'ai-sdlc/pr-ready',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                detailsUrl: 'https://github.com/o/r/actions/runs/555/job/10',
              },
            ],
          }),
        );
      if (a === 'run view 555 --log-failed --job 9')
        return ok(
          'Detect\tStep\t2026-10-16T19:29:05Z ##[error]API rate limit exceeded for installation\n',
        );
      if (a.startsWith('run view 555')) return ok('x\ty\t2026-10-16T19:29:05Z rolled up\n');
      return { status: 1, stdout: '', stderr: file };
    };
    const facts = gatherPrFacts(run, '/', board);
    expect(classifyPr({ ...facts![0]!, taskId: 'AISDLC-1' }).state).toBe('rate-limited');
  });

  it('falls back to the single-PR resource when the list has no merge state', () => {
    expect(gatherPrFacts(make(undefined), '/', board)?.[0]?.mergeStateStatus).toBe('BEHIND');
    expect(gatherPrFacts(make('UNKNOWN'), '/', board)?.[0]?.mergeStateStatus).toBe('BEHIND');
  });

  it('leaves the summary alone when the log is unreadable; undefined without GitHub', () => {
    expect(gatherPrFacts(make('CLEAN', 1), '/', board)?.[0]?.checks?.[0]?.summary).toBeUndefined();
    expect(
      gatherPrFacts(() => ({ status: 1, stdout: '', stderr: '' }), '/', board),
    ).toBeUndefined();
  });
});
