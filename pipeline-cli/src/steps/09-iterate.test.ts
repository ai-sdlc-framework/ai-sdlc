import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coerceReviewerVerdict, iterateReviewLoop } from './09-iterate.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import { aggregateVerdicts } from './08-aggregate-verdicts.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type {
  AggregatedVerdict,
  DeveloperReturn,
  ReviewerVerdict,
  SubagentResult,
  TaskSpec,
} from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};

const goodDev: DeveloperReturn = {
  summary: 'ok',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
};

function approvedVerdict(): AggregatedVerdict {
  return {
    approved: true,
    decision: 'APPROVED',
    counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    verdicts: [
      { agentId: 'code-reviewer', harness: 'claude-code', approved: true, findings: [] },
      { agentId: 'test-reviewer', harness: 'claude-code', approved: true, findings: [] },
      { agentId: 'security-reviewer', harness: 'claude-code', approved: true, findings: [] },
    ],
    harnessNote: '',
    summary: 'APPROVED',
  };
}

function blockedVerdict(): AggregatedVerdict {
  return {
    approved: false,
    decision: 'CHANGES_REQUESTED',
    counts: { critical: 1, major: 0, minor: 0, suggestion: 0 },
    verdicts: [
      {
        agentId: 'code-reviewer',
        harness: 'claude-code',
        approved: false,
        findings: [{ severity: 'critical', message: 'bug' }],
      },
      { agentId: 'test-reviewer', harness: 'claude-code', approved: true, findings: [] },
      { agentId: 'security-reviewer', harness: 'claude-code', approved: true, findings: [] },
    ],
    harnessNote: '',
    summary: 'CHANGES_REQUESTED',
  };
}

describe('Step 9 — iterateReviewLoop', () => {
  it('returns immediately when initial verdict is APPROVED', async () => {
    const spawner = new MockSpawner({});
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: approvedVerdict(),
      maxIterations: 2,
      spawner,
    });
    expect(r.iterations).toBe(1);
    expect(r.needsHumanAttention).toBe(false);
    expect(spawner.getCallCount('developer')).toBe(0);
  });

  it('returns immediately when no spawner is provided (Tier 1 prose mode)', async () => {
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 2,
    });
    expect(r.iterations).toBe(1);
    expect(r.finalVerdict.decision).toBe('CHANGES_REQUESTED');
  });

  it('loops once when iteration 2 fixes the issue', async () => {
    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: goodDev,
        status: 'success',
        durationMs: 0,
      },
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: 'ok' },
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': {
        type: 'test-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: 'ok' },
        status: 'success',
        durationMs: 0,
      },
      'security-reviewer': {
        type: 'security-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: 'ok' },
        status: 'success',
        durationMs: 0,
      },
    });
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 2,
      spawner,
    });
    expect(r.iterations).toBe(2);
    expect(r.finalVerdict.decision).toBe('APPROVED');
    expect(r.needsHumanAttention).toBe(false);
    expect(spawner.getCallCount('developer')).toBe(1);
  });

  it('hits cap and flags needsHumanAttention when reviews never approve', async () => {
    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: goodDev,
        status: 'success',
        durationMs: 0,
      },
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: {
          approved: false,
          findings: [{ severity: 'critical', message: 'still broken' }],
          summary: '',
        },
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': {
        type: 'test-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: '' },
        status: 'success',
        durationMs: 0,
      },
      'security-reviewer': {
        type: 'security-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: '' },
        status: 'success',
        durationMs: 0,
      },
    });
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 2,
      spawner,
    });
    expect(r.iterations).toBe(2);
    expect(r.needsHumanAttention).toBe(true);
  });

  it('aborts the loop when developer return becomes invalid mid-loop', async () => {
    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: 'not-json',
        status: 'error',
        durationMs: 0,
      },
    });
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 3,
      spawner,
    });
    // Developer subagent failed → loop bails; iteration counter increments past 1.
    expect(r.iterations).toBeGreaterThanOrEqual(1);
    expect(r.finalVerdict.decision).toBe('CHANGES_REQUESTED');
  });

  it('invokes onIteration callback per iteration', async () => {
    const seen: number[] = [];
    await iterateReviewLoop({
      taskId: 'AISDLC-1',
      workDir: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: approvedVerdict(),
      maxIterations: 2,
      onIteration: (n) => {
        seen.push(n);
      },
    });
    expect(seen).toEqual([1]);
  });
});

describe('Step 9 — coerceReviewerVerdict', () => {
  it('coerces a parsed verdict object', () => {
    const r: SubagentResult = {
      type: 'code-reviewer',
      output: '',
      parsed: { approved: true, findings: [{ severity: 'minor', message: 'x' }], summary: 'ok' },
      status: 'success',
      durationMs: 0,
    };
    const v = coerceReviewerVerdict('code-reviewer', r);
    expect(v.approved).toBe(true);
    expect(v.findings).toHaveLength(1);
    expect(v.summary).toBe('ok');
  });

  it('parses JSON-string output when no parsed', () => {
    const r: SubagentResult = {
      type: 'code-reviewer',
      output: '{"approved":true,"findings":[],"summary":"x"}',
      status: 'success',
      durationMs: 0,
    };
    const v = coerceReviewerVerdict('code-reviewer', r);
    expect(v.approved).toBe(true);
  });

  it('returns synthetic critical finding on unparseable output', () => {
    const r: SubagentResult = {
      type: 'code-reviewer',
      output: 'totally not json',
      status: 'error',
      error: 'boom',
      durationMs: 0,
    };
    const v = coerceReviewerVerdict('code-reviewer', r);
    expect(v.approved).toBe(false);
    expect(v.findings[0].severity).toBe('critical');
  });

  it('reuses harness from parsed payload if present', () => {
    const r: SubagentResult = {
      type: 'code-reviewer',
      output: '',
      parsed: { approved: true, findings: [], harness: 'codex' },
      status: 'success',
      durationMs: 0,
    };
    const v = coerceReviewerVerdict('code-reviewer', r);
    expect(v.harness).toBe('codex');
  });
});

describe('Step 9 — re-uses Step 8 aggregator', () => {
  it('Step 8 produces blockedVerdict shape used by tests above', async () => {
    const r = await aggregateVerdicts({
      verdicts: [
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: false,
          findings: [{ severity: 'critical', message: 'x' }],
        },
        { agentId: 'test-reviewer', harness: 'claude-code', approved: true, findings: [] },
        { agentId: 'security-reviewer', harness: 'claude-code', approved: true, findings: [] },
      ] as ReviewerVerdict[],
    });
    expect(r.decision).toBe('CHANGES_REQUESTED');
  });
});
