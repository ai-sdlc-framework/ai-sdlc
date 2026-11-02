import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeState,
  codeqlRunsOnPullRequests,
  decidePrDraft,
  markReadyAfterCodeql,
  rollupState,
} from './mark-ready.js';
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
        { number: 1, body: BODY, headRefName: 'ai-sdlc/t', mergeStateStatus: 'CLEAN' },
        { number: 2, body: 'an ordinary draft', headRefName: 'feat/x', mergeStateStatus: 'CLEAN' },
      ],
      { 1: { statusCheckRollup: [analyze('SUCCESS')], comments: [] } },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo');
    expect(r.readied).toEqual([1]);
    expect(gh.calls.filter((c) => c[1] === 'ready')).toEqual([['pr', 'ready', '1']]);
    expect(gh.calls.flat()).not.toContain('merge');
  });

  it('reports a failed Analyze job and does not flip it', () => {
    const gh = fakeGh(
      [{ number: 3, body: BODY, headRefName: 'ai-sdlc/t', mergeStateStatus: 'CLEAN' }],
      {
        3: { statusCheckRollup: [analyze('FAILURE')], comments: [] },
      },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo');
    expect(r.failedAnalyze).toEqual([3]);
    expect(r.readied).toEqual([]);
    expect(gh.calls.some((c) => c[1] === 'ready')).toBe(false);
  });

  it('never flips a superseded or conflicting PR', () => {
    const gh = fakeGh(
      [
        {
          number: 4,
          body: `${BODY} Superseded by #9`,
          headRefName: 'ai-sdlc/t',
          mergeStateStatus: 'CLEAN',
        },
        { number: 5, body: BODY, headRefName: 'ai-sdlc/t', mergeStateStatus: 'DIRTY' },
        { number: 6, body: BODY, headRefName: 'ai-sdlc/t', mergeStateStatus: 'CLEAN' },
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

describe('repos without CodeQL (AISDLC-896)', () => {
  const green = { statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }], comments: [] };

  it('flips a task-branch draft whose PR checks are green', () => {
    const gh = fakeGh(
      [
        {
          number: 7,
          body: 'plain body',
          headRefName: 'ai-sdlc/aisdlc-1-x',
          mergeStateStatus: 'CLEAN',
        },
        { number: 8, body: 'wip', headRefName: 'feat/other', mergeStateStatus: 'CLEAN' },
      ],
      { 7: green, 8: green },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo', { hasCodeql: false });
    expect(r.readied).toEqual([7]);
  });

  it('leaves a draft with failing or pending checks alone', () => {
    const gh = fakeGh(
      [
        { number: 9, headRefName: 'ai-sdlc/a', mergeStateStatus: 'CLEAN' },
        { number: 10, headRefName: 'ai-sdlc/b', mergeStateStatus: 'CLEAN' },
      ],
      {
        9: { statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }], comments: [] },
        10: { statusCheckRollup: [{ name: 'build', conclusion: '' }], comments: [] },
      },
    );
    const r = markReadyAfterCodeql(gh.run, '/repo', { hasCodeql: false });
    expect(r.readied).toEqual([]);
  });

  it('with CodeQL, a green non-Analyze rollup does not flip a task draft', () => {
    const gh = fakeGh([{ number: 7, body: 'plain', headRefName: 'ai-sdlc/a' }], { 7: green });
    expect(markReadyAfterCodeql(gh.run, '/repo', { hasCodeql: true }).readied).toEqual([]);
  });

  it('rollupState classifies', () => {
    expect(rollupState([])).toBe('pending');
    expect(rollupState([{ conclusion: 'SKIPPED' }, { conclusion: 'SUCCESS' }])).toBe('clean');
    expect(rollupState([{ conclusion: 'ERROR' }])).toBe('failed');
  });

  it('codeqlRunsOnPullRequests is true only for CodeQL on a pull_request trigger', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cq-'));
    const wf = path.join(root, '.github', 'workflows');
    expect(codeqlRunsOnPullRequests(root)).toBe(false);
    mkdirSync(wf, { recursive: true });
    writeFileSync(path.join(wf, 'ci.yml'), 'on: [pull_request]\njobs: {}\n');
    expect(codeqlRunsOnPullRequests(root)).toBe(false);
    // Scorecard shape: upload-sarif only.
    writeFileSync(
      path.join(wf, 'scorecard.yml'),
      'on:\n  pull_request: {}\njobs:\n  s:\n    steps:\n      - uses: github/codeql-action/upload-sarif@v3\n',
    );
    expect(codeqlRunsOnPullRequests(root)).toBe(false);
    // This repository's shape: schedule only.
    writeFileSync(
      path.join(wf, 'codeql.yml'),
      'on:\n  schedule:\n    - cron: "0 0 * * 1"\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/analyze@v3\n',
    );
    expect(codeqlRunsOnPullRequests(root)).toBe(false);
    writeFileSync(
      path.join(wf, 'codeql.yml'),
      'on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/analyze@v3\n',
    );
    expect(codeqlRunsOnPullRequests(root)).toBe(true);
    writeFileSync(
      path.join(wf, 'codeql.yml'),
      'on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/init@v3\n',
    );
    expect(codeqlRunsOnPullRequests(root)).toBe(true);
    writeFileSync(
      path.join(wf, 'codeql.yml'),
      'on: [push, pull_request]\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/init@v3\n',
    );
    expect(codeqlRunsOnPullRequests(root)).toBe(true);
    writeFileSync(path.join(wf, 'codeql.yml'), ': : bad\n  - [\n uses: github/codeql-action/init');
    expect(codeqlRunsOnPullRequests(root)).toBe(false);
  });

  it('decidePrDraft names the reason', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cq-'));
    expect(decidePrDraft(root, false)).toEqual({
      draft: false,
      reason: 'ready: no pull-request codeql',
    });
    expect(decidePrDraft(root, true)).toEqual({
      draft: false,
      reason: 'ready: governance.openTaskPrsReady',
    });
    const wf = path.join(root, '.github', 'workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      path.join(wf, 'codeql.yml'),
      'on: [pull_request]\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/init@v3\n',
    );
    expect(decidePrDraft(root, false)).toEqual({
      draft: true,
      reason: 'draft: codeql runs on pull requests',
    });
    expect(decidePrDraft(root, true).draft).toBe(false);
  });
});
