import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  coerceReviewerVerdict,
  isDegenerateVerdict,
  iterateReviewLoop,
  spawnReviewerWithRetry,
} from './09-iterate.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import { aggregateVerdicts } from './08-aggregate-verdicts.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type {
  AggregatedVerdict,
  DeveloperContractRetryInfo,
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
      worktreePath: tmp,
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
      worktreePath: tmp,
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
      worktreePath: tmp,
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
      worktreePath: tmp,
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
      worktreePath: tmp,
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

  it('fires onDeveloperContractRetry when iteration 2 dev returns prose then retry recovers (AISDLC-184)', async () => {
    // Sequence on the developer fixture:
    //   call 0 (iteration 2 initial dispatch from inside the loop) → prose,
    //     triggering parseDeveloperReturnWithRetry to issue a retry spawn.
    //   call 1 (the retry spawn) → valid JSON envelope.
    // Reviewers approve so the loop exits cleanly and we can assert the
    // event payload.
    const spawner = new MockSpawner({
      developer: (_opts, callIndex): SubagentResult => {
        if (callIndex === 0) {
          return {
            type: 'developer',
            output: 'I worked on this and committed abc1234, here is some prose without JSON.',
            status: 'success',
            durationMs: 0,
          };
        }
        return {
          type: 'developer',
          output: '',
          parsed: goodDev,
          status: 'success',
          durationMs: 0,
        };
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
    const events: DeveloperContractRetryInfo[] = [];
    const r = await iterateReviewLoop({
      taskId: 'AISDLC-1',
      worktreePath: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 2,
      spawner,
      onDeveloperContractRetry: (info) => {
        events.push(info);
      },
    });
    // Loop ran iteration 2; retry recovered; reviewers approved on iter 2.
    expect(r.iterations).toBe(2);
    expect(r.finalVerdict.decision).toBe('APPROVED');
    expect(spawner.getCallCount('developer')).toBe(2); // one prose + one retry
    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe('AISDLC-1');
    expect(events[0].initialOutputPreview).toContain('prose without JSON');
    expect(events[0].retryOutputPreview).toBe('<empty>'); // retry fixture's output is ''
    expect(typeof events[0].durationMs).toBe('number');
    // AISDLC-196 — iteration-path discriminator. The retry recovered on
    // iteration 2 (the loop's first body pass; iteration 1 is the
    // pre-loop initial dispatch handled by execute-pipeline). Without
    // this discriminator operators grepping events.jsonl can't tell
    // initial-dispatch retries from iteration-path retries.
    expect(events[0].phase).toBe('iteration');
    expect(events[0].iteration).toBe(2);
  });

  it('does not throw when onDeveloperContractRetry is omitted and dev returns prose on iter 2', async () => {
    // Same scenario as above but no callback wired — verifies the helper is
    // a true no-op when omitted (the iterate loop must not require the hook).
    const spawner = new MockSpawner({
      developer: (_opts, callIndex): SubagentResult => {
        if (callIndex === 0) {
          return {
            type: 'developer',
            output: 'prose-only response, no JSON envelope',
            status: 'success',
            durationMs: 0,
          };
        }
        return {
          type: 'developer',
          output: '',
          parsed: goodDev,
          status: 'success',
          durationMs: 0,
        };
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
      worktreePath: tmp,
      task,
      branch: 'b',
      initialDeveloperReturn: goodDev,
      initialVerdict: blockedVerdict(),
      maxIterations: 2,
      spawner,
    });
    expect(r.iterations).toBe(2);
    expect(r.finalVerdict.decision).toBe('APPROVED');
    expect(spawner.getCallCount('developer')).toBe(2);
  });

  it('invokes onIteration callback per iteration', async () => {
    const seen: number[] = [];
    await iterateReviewLoop({
      taskId: 'AISDLC-1',
      worktreePath: tmp,
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

// ── AISDLC-355: Bug 3 — isDegenerateVerdict + spawnReviewerWithRetry ───────

describe('AISDLC-355 — isDegenerateVerdict', () => {
  it('returns true for synthetic-critical "returned no parseable verdict" placeholder', () => {
    const v: ReviewerVerdict = {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'code-reviewer returned no parseable verdict (status=error)',
        },
      ],
    };
    expect(isDegenerateVerdict(v)).toBe(true);
  });

  it('returns true for fully empty degenerate verdict (no approval, no findings, no summary)', () => {
    const v: ReviewerVerdict = {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: false,
      findings: [],
      summary: '',
    };
    expect(isDegenerateVerdict(v)).toBe(true);
  });

  it('returns false for a substantive rejection with real findings', () => {
    const v: ReviewerVerdict = {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: false,
      findings: [{ severity: 'major', message: 'function is not pure' }],
      summary: 'needs work',
    };
    expect(isDegenerateVerdict(v)).toBe(false);
  });

  it('returns false for an approval', () => {
    const v: ReviewerVerdict = {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    };
    expect(isDegenerateVerdict(v)).toBe(false);
  });
});

describe('AISDLC-355 — spawnReviewerWithRetry (Bug 3: degenerate-reviewer one-time retry)', () => {
  it('returns the first result when it is substantive (no retry needed)', async () => {
    const spawner = new MockSpawner({
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: { approved: true, findings: [], summary: 'lgtm' },
        status: 'success',
        durationMs: 0,
      },
    });
    const verdict = await spawnReviewerWithRetry(
      spawner,
      { type: 'code-reviewer', prompt: 'review this', cwd: tmp },
      'code-reviewer',
    );
    expect(verdict.approved).toBe(true);
    expect(spawner.getCallCount('code-reviewer')).toBe(1);
  });

  it('retries once on degenerate first result and uses second result', async () => {
    const retryLogs: string[] = [];
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      progress: (stage: string, status: string) => retryLogs.push(`${stage}: ${status}`),
    };

    const spawner = new MockSpawner({
      'code-reviewer': (_opts, callIndex): SubagentResult => {
        if (callIndex === 0) {
          // First call: returns error (no parseable verdict)
          return {
            type: 'code-reviewer',
            output: 'pure prose, no JSON',
            status: 'error',
            error: 'truncated',
            durationMs: 0,
          };
        }
        // Second call: substantive verdict
        return {
          type: 'code-reviewer',
          output: '',
          parsed: { approved: true, findings: [], summary: 'lgtm on retry' },
          status: 'success',
          durationMs: 0,
        };
      },
    });

    const verdict = await spawnReviewerWithRetry(
      spawner,
      { type: 'code-reviewer', prompt: 'review this', cwd: tmp },
      'code-reviewer',
      mockLogger,
    );

    expect(verdict.approved).toBe(true);
    expect(verdict.summary).toBe('lgtm on retry');
    expect(spawner.getCallCount('code-reviewer')).toBe(2);
    // Must emit the retry progress line
    expect(retryLogs).toContain('reviewer-retry: code-reviewer attempt=2');
  });

  it('does NOT retry on timeout status — emits reviewer-timeout finding instead', async () => {
    const spawner = new MockSpawner({
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        status: 'timeout',
        durationMs: 60000,
      },
    });
    const verdict = await spawnReviewerWithRetry(
      spawner,
      { type: 'code-reviewer', prompt: 'review this', cwd: tmp },
      'code-reviewer',
    );
    // Should NOT retry (timeout = real failure)
    expect(spawner.getCallCount('code-reviewer')).toBe(1);
    // Must produce a critical finding (not a retry)
    expect(verdict.approved).toBe(false);
    expect(verdict.findings[0].message).toMatch(/timed out/);
    expect(verdict.summary).toBe('reviewer-timeout');
  });

  it('max 1 retry per call — if second call is also degenerate, returns that degenerate result', async () => {
    // Both calls return unparseable output — no infinite loop
    const spawner = new MockSpawner({
      'code-reviewer': {
        type: 'code-reviewer',
        output: 'still prose',
        status: 'error',
        durationMs: 0,
      },
    });
    const verdict = await spawnReviewerWithRetry(
      spawner,
      { type: 'code-reviewer', prompt: 'review this', cwd: tmp },
      'code-reviewer',
    );
    // Exactly 2 calls (1 original + 1 retry), no more
    expect(spawner.getCallCount('code-reviewer')).toBe(2);
    // Result is still the synthetic-critical from the second attempt
    expect(verdict.approved).toBe(false);
    expect(verdict.findings[0].severity).toBe('critical');
  });

  // ── AISDLC-359 regression pin ────────────────────────────────────────────
  // The original AISDLC-359 incident (2026-05-17, test-reviewer on AISDLC-283
  // dispatch) reported `status=success` from the spawner, NOT `status=error`.
  // The reviewer LLM produced content that defeated all 3 fence-strip parser
  // strategies (pure prose, no JSON, no fenced block, no `{...}` substring),
  // so `parseClaudeOutput` returned `undefined`, `r.parsed` was `undefined`,
  // and `coerceReviewerVerdict` synthesised the critical placeholder. The
  // pre-AISDLC-359/355 codepath then propagated that placeholder verbatim;
  // the retry layer now recovers when the second attempt parses cleanly.
  //
  // The earlier "retries once on degenerate first result and uses second
  // result" test exercises the `status=error` arm. This test pins the
  // *exact* AISDLC-359 failure mode: `status=success` + unparseable content.
  it('AISDLC-359 regression: retries when status=success but output is unparseable prose', async () => {
    const retryLogs: string[] = [];
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      progress: (stage: string, status: string) => retryLogs.push(`${stage}: ${status}`),
    };

    const spawner = new MockSpawner({
      'test-reviewer': (_opts, callIndex): SubagentResult => {
        if (callIndex === 0) {
          // Exact shape from the AISDLC-359 incident: the spawner reported
          // `success`, but the reviewer LLM returned narrative prose with
          // no JSON envelope (no fences, no `{...}`). All 3 parser
          // strategies fail, `r.parsed` is undefined, and the verdict
          // coerces to the synthetic-critical placeholder.
          return {
            type: 'test-reviewer',
            output:
              'I reviewed the tests and they look mostly correct. Coverage seems fine. ' +
              'No JSON returned — context window hit, or the model decided to summarise ' +
              'rather than emit the requested envelope.',
            status: 'success',
            durationMs: 1234,
          };
        }
        // Second attempt: the model produces the proper verdict envelope.
        return {
          type: 'test-reviewer',
          output: '',
          parsed: {
            approved: true,
            findings: [],
            summary: 'tests reviewed on retry; coverage adequate',
          },
          status: 'success',
          durationMs: 1500,
        };
      },
    });

    const verdict = await spawnReviewerWithRetry(
      spawner,
      { type: 'test-reviewer', prompt: 'review the tests', cwd: tmp },
      'test-reviewer',
      mockLogger,
    );

    // Recovery: second attempt's substantive verdict is used.
    expect(verdict.approved).toBe(true);
    expect(verdict.summary).toBe('tests reviewed on retry; coverage adequate');
    expect(spawner.getCallCount('test-reviewer')).toBe(2);
    // Operator-visibility: the progress line MUST fire so unattended runs
    // surface the retry in the orchestrator's events.jsonl tail.
    expect(retryLogs).toContain('reviewer-retry: test-reviewer attempt=2');
  });
});
