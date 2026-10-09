import { describe, expect, it } from 'vitest';

import { analyzeState, markReadyAfterCodeql } from './mark-ready.js';
import type { CommandRunner } from './types.js';

const BODY = 'Draft until CodeQL is clean.';

/** A fake `gh`: `list` is the draft list, `views` maps a PR number to its detail. */
function fakeGh(list: unknown[], views: Record<number, unknown>) {
  const calls: string[][] = [];
  const run: CommandRunner = (_file, args) => {
    calls.push([...args]);
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    if (args[1] === 'view') {
      const v = views[Number(args[2])];
      return v === undefined
        ? { status: 1, stdout: '', stderr: 'nope' }
        : { status: 0, stdout: JSON.stringify(v), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const analyze = (conclusion: string, name = 'Analyze (javascript-typescript)') => ({
  name,
  conclusion,
});

describe('analyzeState', () => {
  it('is clean only when every Analyze job succeeded', () => {
    expect(analyzeState([analyze('SUCCESS'), analyze('SUCCESS', 'Analyze (actions)')])).toBe(
      'clean',
    );
    expect(analyzeState([analyze('SUCCESS'), analyze('FAILURE', 'Analyze (actions)')])).toBe(
      'failed',
    );
    expect(analyzeState([analyze('')])).toBe('pending');
    expect(analyzeState([{ name: 'build', conclusion: 'SUCCESS' }])).toBe('pending');
  });
});

describe('markReadyAfterCodeql', () => {
  it('flips a draft whose Analyze jobs all passed, and nothing else', () => {
    const gh = fakeGh(
      [
        { number: 1, body: BODY, mergeStateStatus: 'CLEAN' },
        { number: 2, body: 'an ordinary draft', mergeStateStatus: 'CLEAN' },
      ],
      { 1: { statusCheckRollup: [analyze('SUCCESS')], comments: [] } },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo');
    expect(r.readied).toEqual([1]);
    expect(gh.calls.filter((c) => c[1] === 'ready')).toEqual([['pr', 'ready', '1']]);
    expect(gh.calls.flat()).not.toContain('merge');
  });

  it('reports a failed Analyze job and does not flip it', () => {
    const gh = fakeGh([{ number: 3, body: BODY, mergeStateStatus: 'CLEAN' }], {
      3: { statusCheckRollup: [analyze('FAILURE')], comments: [] },
    });
    const r = markReadyAfterCodeql(gh.run, '/repo');
    expect(r.failedAnalyze).toEqual([3]);
    expect(r.readied).toEqual([]);
    expect(gh.calls.some((c) => c[1] === 'ready')).toBe(false);
  });

  it('never flips a superseded or conflicting PR', () => {
    const gh = fakeGh(
      [
        { number: 4, body: `${BODY} Superseded by #9`, mergeStateStatus: 'CLEAN' },
        { number: 5, body: BODY, mergeStateStatus: 'DIRTY' },
        { number: 6, body: BODY, mergeStateStatus: 'CLEAN' },
      ],
      {
        6: { statusCheckRollup: [analyze('SUCCESS')], comments: [{ body: 'superseded by #10' }] },
      },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo');
    expect(r.readied).toEqual([]);
    expect(r.skipped.map((s) => s.pr)).toEqual([4, 5, 6]);
    expect(gh.calls.some((c) => c[1] === 'ready')).toBe(false);
  });

  it('reports an error and flips nothing when gh cannot list', () => {
    const run: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'gh: not logged in' });
    const r = markReadyAfterCodeql(run, '/repo');
    expect(r.error).toContain('gh pr list failed');
    expect(r.readied).toEqual([]);
  });
});
