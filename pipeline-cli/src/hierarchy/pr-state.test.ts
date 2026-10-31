import { describe, expect, it } from 'vitest';

import {
  classifyAndRecord,
  classifyPr,
  dropSupersededCancelled,
  PR_ACTIONS,
  type PrCheck,
  type PrFacts,
  type PrState,
} from './pr-state.js';

const ok = (name: string): PrCheck => ({ name, conclusion: 'success' });
const base: PrFacts = { prNumber: 7, taskId: 'AISDLC-1', headBranch: 'feat/x' };
const green = [ok('ai-sdlc/pr-ready'), ok('ai-sdlc/attestation')];

const rows: Array<[PrState, PrFacts]> = [
  ['merged', { ...base, merged: true }],
  ['armed-clean', { ...base, checks: green, mergeStateStatus: 'CLEAN', autoMergeArmed: true }],
  ['ready-to-flip', { ...base, checks: green, draft: true, approvedVerdict: true }],
  ['behind-or-dirty', { ...base, checks: green, mergeStateStatus: 'BEHIND' }],
  ['behind-or-dirty', { ...base, mergeStateStatus: 'DIRTY' }],
  [
    'attestation-content-hash-mismatch',
    {
      ...base,
      checks: [
        { name: 'ai-sdlc/attestation', conclusion: 'failure', summary: 'content-hash mismatch' },
      ],
    },
  ],
  [
    'real-failure',
    {
      ...base,
      checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'FAIL foo.test.ts' }],
    },
  ],
  ['cancelled-or-infra', { ...base, checks: [{ name: 'build', conclusion: 'cancelled' }] }],
  ['cancelled-or-infra', { ...base, checks: [{ name: 'build', conclusion: 'infra' }] }],
  ['pending', { ...base, checks: [] }],
  ['pending', { ...base, checks: [{ name: 'build', conclusion: 'pending' }] }],
  [
    'pending',
    {
      ...base,
      checks: [
        { name: 'ai-sdlc/attestation', conclusion: 'success' },
        { name: 'ai-sdlc/pr-ready', conclusion: 'pending' },
      ],
    },
  ],
  ['manifest-branch-mismatch', { ...base, manifestBranch: 'feat/other' }],
  ['no-match', { ...base, checks: green, draft: true }],
];

describe('classifyPr (AISDLC-823)', () => {
  it.each(rows)('classifies %s', (state, facts) => {
    const c = classifyPr(facts);
    expect(c.state).toBe(state);
    expect(c.action).toBe(PR_ACTIONS[state]);
    expect(c.prNumber).toBe(7);
  });

  it('carries the failing line for a real failure', () => {
    expect(classifyPr(rows[6]![1]).failingLine).toBe('FAIL foo.test.ts');
  });

  it('keeps matching branches out of the mismatch row', () => {
    const c = classifyPr({ ...base, manifestBranch: 'feat/x' });
    expect(c.state).toBe('pending');
  });

  it('a non-attestation-hash attestation failure is not the re-sign row', () => {
    const c = classifyPr({
      ...base,
      checks: [{ name: 'ai-sdlc/attestation', conclusion: 'failure', summary: 'missing' }],
    });
    expect(c.state).toBe('no-match');
  });
});

describe('rate-limited (AISDLC-926)', () => {
  const rl = 'API rate limit exceeded for installation 123';
  const red = (name: string, summary?: string): PrCheck => ({
    name,
    conclusion: 'failure',
    ...(summary ? { summary } : {}),
  });

  it('classifies known checks failing with the installation reason', () => {
    const c = classifyPr({
      ...base,
      checks: [red('Detect Changes', rl), red('ai-sdlc/issue-link'), red('ai-sdlc/pr-ready', rl)],
    });
    expect(c.state).toBe('rate-limited');
    expect(c.action).toBe('wait-and-rerun');
  });

  it('a failed check outside the known set keeps the old classification', () => {
    const c = classifyPr({
      ...base,
      checks: [red('ai-sdlc/pr-ready', rl), red('Build & Test', 'boom')],
    });
    expect(c.state).toBe('real-failure');
  });

  it('a known failed check without the reason is still a real failure', () => {
    expect(classifyPr({ ...base, checks: [red('ai-sdlc/pr-ready', 'tests failed')] }).state).toBe(
      'real-failure',
    );
  });
});

describe('rate-limit signature (AISDLC-949)', () => {
  const rl = '##[error]API rate limit exceeded for installation';
  const job = (name: string, durationSec: number, summary?: string): PrCheck => ({
    name,
    conclusion: 'failure',
    durationSec,
    ...(summary ? { summary } : {}),
  });
  const rollup: PrCheck = { name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'rolled up' };

  it('PR 1652 shape: Detect Changes alone, 6 s', () => {
    expect(classifyPr({ ...base, checks: [job('Detect Changes', 6, rl), rollup] }).state).toBe(
      'rate-limited',
    );
  });

  it('PR 1687 shape: Detect Changes plus issue-link', () => {
    const c = classifyPr({
      ...base,
      checks: [job('Detect Changes', 8, rl), job('ai-sdlc/issue-link', 3, rl), rollup],
    });
    expect(c.state).toBe('rate-limited');
  });

  it('a genuine test failure stays real-failure', () => {
    const c = classifyPr({
      ...base,
      checks: [job('Detect Changes', 6, rl), job('Build & Test', 300, 'FAIL a.test.ts'), rollup],
    });
    expect(c.state).toBe('real-failure');
  });

  it('a slow job with the text stays real-failure', () => {
    expect(classifyPr({ ...base, checks: [job('Other job', 90, rl), rollup] }).state).toBe(
      'real-failure',
    );
  });
});

describe('classifyAndRecord event shape (AC-4)', () => {
  it('writes one DispatchPrClassified event per PR', () => {
    const events: Array<Record<string, unknown>> = [];
    const out = classifyAndRecord([base, { ...base, prNumber: 8, merged: true }], {
      write: (e) => {
        events.push(e);
        return true;
      },
    });
    expect(out).toHaveLength(2);
    expect(events).toEqual([
      {
        ts: '',
        type: 'DispatchPrClassified',
        taskId: 'AISDLC-1',
        prNumber: 7,
        state: 'pending',
        action: 'none',
      },
      {
        ts: '',
        type: 'DispatchPrClassified',
        taskId: 'AISDLC-1',
        prNumber: 8,
        state: 'merged',
        action: PR_ACTIONS.merged,
      },
    ]);
  });
});

describe('Detect Changes structural shape (AISDLC-953)', () => {
  const red = (name: string): PrCheck => ({ name, conclusion: 'failure' });
  const skipped = (name: string): PrCheck => ({ name, conclusion: 'success', skipped: true });
  const downstream = ['Build and Test', 'Lint', 'Attestation', 'Governance', 'Integration'].map(
    skipped,
  );
  const rollup = red('ai-sdlc/pr-ready');

  // Runs 38968818462 (PR 1701), 38970090869 (PR 1701 new head), 38968758154 (PR 1698):
  // Detect Changes plus issue-link failed, everything else skipped, no summaries.
  it.each([
    ['38968818462', [red('Detect Changes'), red('ai-sdlc/issue-link'), ...downstream, rollup]],
    ['38970090869', [red('Detect Changes'), red('ai-sdlc/issue-link'), ...downstream, rollup]],
    ['38968758154', [red('Detect Changes'), ...downstream, rollup]],
  ])('run %s is rate-limited with empty summaries', (_run, checks) => {
    expect(classifyPr({ ...base, checks }).state).toBe('rate-limited');
  });

  it('stays real-failure when a later gate job ran and failed', () => {
    const checks = [red('Detect Changes'), red('Build and Test'), ...downstream.slice(1), rollup];
    expect(classifyPr({ ...base, checks }).state).toBe('real-failure');
  });

  it('stays real-failure when a later gate job ran and passed', () => {
    const checks = [
      red('Detect Changes'),
      { name: 'Build and Test', conclusion: 'success' as const },
      rollup,
    ];
    expect(classifyPr({ ...base, checks }).state).toBe('real-failure');
  });

  it('is not the shape when Detect Changes did not fail', () => {
    const checks = [red('ai-sdlc/issue-link'), ...downstream, rollup];
    expect(classifyPr({ ...base, checks }).state).toBe('real-failure');
  });
});

describe('cancelled duplicate with passing sibling (AISDLC-724)', () => {
  const cancelled = (name: string): PrCheck => ({ name, conclusion: 'cancelled' });

  it('treats a cancelled run with a passing same-name sibling as passing', () => {
    const c = classifyPr({
      ...base,
      checks: [...green, cancelled('ai-sdlc/attestation')],
      mergeStateStatus: 'CLEAN',
      autoMergeArmed: true,
    });
    expect(c.state).toBe('armed-clean');
  });

  it('keeps a cancelled run that has no passing sibling', () => {
    const c = classifyPr({ ...base, checks: [ok('a'), cancelled('b')] });
    expect(c.state).toBe('cancelled-or-infra');
    expect(dropSupersededCancelled([cancelled('b')])).toHaveLength(1);
  });
});

describe('stale-base Backlog Drift (AISDLC-1140)', () => {
  const drift = (changedFiles: string[]) =>
    classifyPr({
      prNumber: 1,
      taskId: 'AISDLC-1133',
      changedFiles,
      checks: [
        {
          name: 'Backlog Drift',
          conclusion: 'failure',
          summary:
            'AISDLC-1132 ✗ Referenced file no longer exists: pipeline-cli/src/usage/transcript-inspect.ts',
        },
        { name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'Backlog Drift failed' },
      ],
    });

  it('reads a drift error on a task outside the diff as behind-or-dirty', () => {
    expect(drift(['backlog/tasks/aisdlc-1133 - x.md']).state).toBe('behind-or-dirty');
  });

  it('keeps real-failure when the PR touches the named task', () => {
    expect(drift(['backlog/tasks/aisdlc-1132 - y.md']).state).toBe('real-failure');
  });

  it('keeps real-failure when changed files are unknown', () => {
    expect(drift(undefined as never).state).toBe('real-failure');
  });

  it('does not treat AISDLC-11320 as AISDLC-1132', () => {
    expect(drift(['backlog/tasks/aisdlc-11320 - z.md']).state).toBe('behind-or-dirty');
  });
});
