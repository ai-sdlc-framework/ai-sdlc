import { describe, it, expect } from 'vitest';
import { analyzeReviewLedger, formatReviewAnalysis } from './reviews-analysis.js';
import type { ReviewLedgerRecord } from './reviews-ledger.js';

function rec(overrides: Partial<ReviewLedgerRecord>): ReviewLedgerRecord {
  return {
    taskId: 'AISDLC-1',
    prNumber: null,
    commitSha: 'a'.repeat(40),
    iteration: 1,
    role: 'code',
    harness: 'claude-code',
    timestamp: '2026-09-14T00:00:00.000Z',
    verdict: 'approved',
    findings: [],
    ...overrides,
  };
}

describe('analyzeReviewLedger — empty input', () => {
  it('returns zeroed stats for no records', () => {
    const result = analyzeReviewLedger([]);
    expect(result.totalCycles).toBe(0);
    for (const r of result.perRole) {
      expect(r.participatedCycles).toBe(0);
      expect(r.blockRate).toBe(0);
      expect(r.soleBlockerRate).toBe(0);
      expect(r.discordantRate).toBe(0);
    }
    for (const p of result.pairOverlaps) {
      expect(p.overlapRatio).toBe(0);
    }
  });
});

describe('analyzeReviewLedger — hand-computed fixture proving the math (AISDLC-616 AC-5)', () => {
  // Fixture: 4 review cycles (one per commit), 3 roles each.
  //
  //   cycle 1 (commit a): code=approved, test=approved, security=REJECTED (critical)
  //     -> security is the SOLE blocker; code+test are discordant (panel
  //        blocked, they alone would not have).
  //   cycle 2 (commit b): code=REJECTED (major), test=approved, security=approved
  //     -> code is the SOLE blocker; test+security are discordant.
  //   cycle 3 (commit c): code=REJECTED, test=REJECTED (same finding title
  //     "unhandled promise rejection"), security=approved
  //     -> NEITHER code nor test is a sole blocker (both blocked); security
  //        is discordant. code/test overlap by 1 finding.
  //   cycle 4 (commit d): all three approved, no findings anywhere.
  //     -> no one blocks, no discordance.
  const records: ReviewLedgerRecord[] = [
    // cycle 1
    rec({ commitSha: 'a'.repeat(40), role: 'code', verdict: 'approved' }),
    rec({ commitSha: 'a'.repeat(40), role: 'test', verdict: 'approved' }),
    rec({
      commitSha: 'a'.repeat(40),
      role: 'security',
      verdict: 'rejected',
      findings: [{ severity: 'critical', summary: 'hardcoded secret', title: 'hardcoded secret' }],
    }),
    // cycle 2
    rec({
      commitSha: 'b'.repeat(40),
      role: 'code',
      verdict: 'rejected',
      findings: [{ severity: 'major', summary: 'race condition', title: 'race condition' }],
    }),
    rec({ commitSha: 'b'.repeat(40), role: 'test', verdict: 'approved' }),
    rec({ commitSha: 'b'.repeat(40), role: 'security', verdict: 'approved' }),
    // cycle 3
    rec({
      commitSha: 'c'.repeat(40),
      role: 'code',
      verdict: 'rejected',
      findings: [
        {
          severity: 'major',
          summary: 'unhandled promise rejection',
          title: 'unhandled promise rejection',
        },
      ],
    }),
    rec({
      commitSha: 'c'.repeat(40),
      role: 'test',
      verdict: 'rejected',
      findings: [
        {
          severity: 'major',
          summary: 'unhandled promise rejection',
          title: 'unhandled promise rejection',
        },
        { severity: 'minor', summary: 'missing test case', title: 'missing test case' },
      ],
    }),
    rec({ commitSha: 'c'.repeat(40), role: 'security', verdict: 'approved' }),
    // cycle 4
    rec({ commitSha: 'd'.repeat(40), role: 'code', verdict: 'approved' }),
    rec({ commitSha: 'd'.repeat(40), role: 'test', verdict: 'approved' }),
    rec({ commitSha: 'd'.repeat(40), role: 'security', verdict: 'approved' }),
  ];

  const result = analyzeReviewLedger(records);

  it('counts 4 distinct review cycles', () => {
    expect(result.totalCycles).toBe(4);
  });

  it('computes code role stats by hand', () => {
    const code = result.perRole.find((r) => r.role === 'code')!;
    // code participated in all 4 cycles.
    expect(code.participatedCycles).toBe(4);
    // code blocked in cycles 2 and 3 -> 2/4 = 0.5
    expect(code.blockedCycles).toBe(2);
    expect(code.blockRate).toBeCloseTo(0.5, 6);
    // code was the SOLE blocker only in cycle 2 (cycle 3 test also blocked)
    // -> 1/4 = 0.25
    expect(code.soleBlockerCycles).toBe(1);
    expect(code.soleBlockerRate).toBeCloseTo(0.25, 6);
    // code was discordant (panel blocked, code alone did not) only in
    // cycle 1 (security blocked, code did not) -> 1/4 = 0.25
    expect(code.discordantCycles).toBe(1);
    expect(code.discordantRate).toBeCloseTo(0.25, 6);
  });

  it('computes test role stats by hand', () => {
    const test = result.perRole.find((r) => r.role === 'test')!;
    expect(test.participatedCycles).toBe(4);
    // test blocked only in cycle 3 -> 1/4
    expect(test.blockedCycles).toBe(1);
    expect(test.blockRate).toBeCloseTo(0.25, 6);
    // test was never the SOLE blocker (cycle 3 code also blocked) -> 0
    expect(test.soleBlockerCycles).toBe(0);
    expect(test.soleBlockerRate).toBe(0);
    // test discordant in cycle 1 (security blocked) and cycle 2 (code
    // blocked) -> 2/4 = 0.5
    expect(test.discordantCycles).toBe(2);
    expect(test.discordantRate).toBeCloseTo(0.5, 6);
  });

  it('computes security role stats by hand', () => {
    const security = result.perRole.find((r) => r.role === 'security')!;
    expect(security.participatedCycles).toBe(4);
    // security blocked only in cycle 1 -> 1/4
    expect(security.blockedCycles).toBe(1);
    expect(security.blockRate).toBeCloseTo(0.25, 6);
    // security was the SOLE blocker in cycle 1 -> 1/4
    expect(security.soleBlockerCycles).toBe(1);
    expect(security.soleBlockerRate).toBeCloseTo(0.25, 6);
    // security discordant in cycle 2 (code blocked) and cycle 3 (code+test
    // blocked) -> 2/4 = 0.5
    expect(security.discordantCycles).toBe(2);
    expect(security.discordantRate).toBeCloseTo(0.5, 6);
  });

  it('computes code/test finding overlap by hand', () => {
    const pair = result.pairOverlaps.find(
      (p) =>
        (p.roleA === 'code' && p.roleB === 'test') || (p.roleA === 'test' && p.roleB === 'code'),
    )!;
    // Both participated in all 4 cycles.
    expect(pair.cyclesBothParticipated).toBe(4);
    // Union of finding titles across all cycles:
    //   cycle 1: code=[], test=[] -> union 0
    //   cycle 2: code=['race condition'], test=[] -> union 1
    //   cycle 3: code=['unhandled promise rejection'],
    //            test=['unhandled promise rejection', 'missing test case']
    //            -> union {unhandled promise rejection, missing test case} = 2
    //   cycle 4: [] / [] -> union 0
    // total union = 1 + 2 = 3
    expect(pair.unionFindingCount).toBe(3);
    // Overlap (title present in BOTH roles' findings, same cycle):
    //   cycle 3: 'unhandled promise rejection' present in both -> 1
    // total overlap = 1
    expect(pair.overlapFindingCount).toBe(1);
    expect(pair.overlapRatio).toBeCloseTo(1 / 3, 6);
  });

  it('computes code/security and test/security overlap as 0 (no shared findings)', () => {
    const codeSecurity = result.pairOverlaps.find(
      (p) =>
        (p.roleA === 'code' && p.roleB === 'security') ||
        (p.roleA === 'security' && p.roleB === 'code'),
    )!;
    expect(codeSecurity.overlapFindingCount).toBe(0);
    // union: cycle1 security has 1 finding, code has 0 -> union 1;
    // cycle2 code has 1, security 0 -> union 1; cycle3 code 1, security 0
    // -> union 1; cycle4 0/0. total union = 3.
    expect(codeSecurity.unionFindingCount).toBe(3);
    expect(codeSecurity.overlapRatio).toBe(0);

    const testSecurity = result.pairOverlaps.find(
      (p) =>
        (p.roleA === 'test' && p.roleB === 'security') ||
        (p.roleA === 'security' && p.roleB === 'test'),
    )!;
    expect(testSecurity.overlapFindingCount).toBe(0);
  });

  it('formatReviewAnalysis renders a non-empty human-readable report', () => {
    const text = formatReviewAnalysis(result);
    expect(text).toContain('Review cycles analyzed: 4');
    expect(text).toContain('code');
    expect(text).toContain('test');
    expect(text).toContain('security');
  });
});

describe('analyzeReviewLedger — a role that never participates gets zeroed stats, not NaN', () => {
  it('handles a corpus with only code+test records (no security)', () => {
    const records: ReviewLedgerRecord[] = [
      rec({ commitSha: 'a'.repeat(40), role: 'code', verdict: 'approved' }),
      rec({ commitSha: 'a'.repeat(40), role: 'test', verdict: 'approved' }),
    ];
    const result = analyzeReviewLedger(records);
    const security = result.perRole.find((r) => r.role === 'security')!;
    expect(security.participatedCycles).toBe(0);
    expect(security.blockRate).toBe(0);
    expect(security.soleBlockerRate).toBe(0);
    expect(security.discordantRate).toBe(0);
    expect(Number.isNaN(security.blockRate)).toBe(false);
  });
});

// AISDLC-617 — a review cycle run under reviewerSet: code-test-merged
// (correctness + security, no separate code/test records) must NOT be
// silently dropped from the analysis.
describe('analyzeReviewLedger — AISDLC-617 code-test-merged cycles are counted, not dropped', () => {
  it('counts a correctness+security cycle in totalCycles and in the correctness role row', () => {
    const records: ReviewLedgerRecord[] = [
      rec({
        commitSha: 'e'.repeat(40),
        role: 'correctness',
        verdict: 'rejected',
        findings: [{ severity: 'major', summary: 'bug', title: 'bug' }],
      }),
      rec({ commitSha: 'e'.repeat(40), role: 'security', verdict: 'approved' }),
    ];
    const result = analyzeReviewLedger(records);
    expect(result.totalCycles).toBe(1);
    const correctness = result.perRole.find((r) => r.role === 'correctness')!;
    expect(correctness).toBeDefined();
    expect(correctness.participatedCycles).toBe(1);
    expect(correctness.blockedCycles).toBe(1);
    expect(correctness.blockRate).toBe(1);
    // No other role blocked in this cycle → correctness is the sole blocker.
    expect(correctness.soleBlockerCycles).toBe(1);
  });

  it('formatReviewAnalysis renders the correctness role row without throwing', () => {
    const records: ReviewLedgerRecord[] = [
      rec({ commitSha: 'f'.repeat(40), role: 'correctness', verdict: 'approved' }),
      rec({ commitSha: 'f'.repeat(40), role: 'security', verdict: 'approved' }),
    ];
    const result = analyzeReviewLedger(records);
    const text = formatReviewAnalysis(result);
    expect(text).toContain('correctness');
  });
});
