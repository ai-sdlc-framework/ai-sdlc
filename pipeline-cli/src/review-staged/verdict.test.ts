/**
 * Step 8 aggregates the staged set's single verdict by the same rules as any other set:
 * a critical or major finding blocks, and without one a verdict that approves passes.
 */
import { describe, expect, it } from 'vitest';
import { aggregateVerdicts } from '../steps/08-aggregate-verdicts.js';
import type { StagedVerdict } from '../review-synth/types.js';
import { toReviewerVerdict } from './verdict.js';

const base = (over: Partial<StagedVerdict> = {}): StagedVerdict => ({
  approved: true,
  findings: [],
  summary: 'Looks right.',
  promptInjectionDetected: false,
  ...over,
});

const finding = (severity: 'critical' | 'major' | 'minor' | 'suggestion') => ({
  severity,
  file: 'src/a.ts',
  line: 4,
  message: `a ${severity} problem`,
  evidence: [{ probeId: 'file-read-0' }],
});

describe('toReviewerVerdict', () => {
  it('is one verdict named for the set, with findings in the Step 8 shape', () => {
    const v = toReviewerVerdict(base({ approved: false, findings: [finding('major')] }));
    expect(v).toEqual({
      agentId: 'staged-review',
      harness: 'claude-code',
      approved: false,
      findings: [{ severity: 'major', file: 'src/a.ts', line: 4, message: 'a major problem' }],
      summary: 'Looks right.',
    });
  });

  it('omits a null file or line instead of carrying null', () => {
    const v = toReviewerVerdict(
      base({ findings: [{ ...finding('minor'), file: null, line: null }] }),
    );
    expect(v.findings[0]).toEqual({ severity: 'minor', message: 'a minor problem' });
  });

  it('says what was dropped and which hunks no probe covered', () => {
    const many = Array.from({ length: 25 }, (_, i) => `h${i}`);
    const v = toReviewerVerdict(base({ groundingDropped: 2 }), many);
    expect(v.summary).toContain('2 finding(s) were dropped');
    expect(v.summary).toContain('h0, h1');
    expect(v.summary).toContain('and 5 more');
    expect(toReviewerVerdict(base({ groundingDropped: 0 })).summary).toBe('Looks right.');
  });
});

describe('Step 8 over a set of one verdict', () => {
  it('blocks on a critical finding', async () => {
    const result = await aggregateVerdicts({
      verdicts: [toReviewerVerdict(base({ approved: false, findings: [finding('critical')] }))],
    });
    expect(result.decision).toBe('CHANGES_REQUESTED');
    expect(result.approved).toBe(false);
    expect(result.counts.critical).toBe(1);
    expect(result.summary).toContain('across 1 reviewers');
  });

  it('blocks on a major finding even when the verdict says approved', async () => {
    const result = await aggregateVerdicts({
      verdicts: [toReviewerVerdict(base({ approved: true, findings: [finding('major')] }))],
    });
    expect(result.decision).toBe('CHANGES_REQUESTED');
  });

  it('approves without a blocking finding, and minor findings do not block', async () => {
    const clean = await aggregateVerdicts({ verdicts: [toReviewerVerdict(base())] });
    expect(clean).toMatchObject({ decision: 'APPROVED', approved: true });
    const minor = await aggregateVerdicts({
      verdicts: [toReviewerVerdict(base({ findings: [finding('minor'), finding('suggestion')] }))],
    });
    expect(minor.decision).toBe('APPROVED');
    expect(minor.counts).toMatchObject({ minor: 1, suggestion: 1 });
  });

  it('does not approve a rejected verdict that has no findings left', async () => {
    const result = await aggregateVerdicts({
      verdicts: [toReviewerVerdict(base({ approved: false }))],
    });
    expect(result.decision).toBe('CHANGES_REQUESTED');
  });

  it('aggregates beside the standalone security reviewer by the same rules', async () => {
    const security = {
      agentId: 'security-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
    };
    const both = await aggregateVerdicts({ verdicts: [toReviewerVerdict(base()), security] });
    expect(both.decision).toBe('APPROVED');
    const blocked = await aggregateVerdicts({
      verdicts: [
        toReviewerVerdict(base()),
        { ...security, approved: false, findings: [{ severity: 'critical', message: 'x' }] },
      ],
    });
    expect(blocked.decision).toBe('CHANGES_REQUESTED');
  });
});
