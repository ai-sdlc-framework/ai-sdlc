import { describe, expect, it } from 'vitest';

import {
  classifyAndRecord,
  classifyPr,
  PR_ACTIONS,
  STALE_CLAIM_MS,
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
  ['stale-claim', { ...base, claimHeartbeatAgeMs: STALE_CLAIM_MS + 1 }],
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

  it('keeps a fresh heartbeat and matching branches out of the stale rows', () => {
    const c = classifyPr({ ...base, claimHeartbeatAgeMs: 1, manifestBranch: 'feat/x' });
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
