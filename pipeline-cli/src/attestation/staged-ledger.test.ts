/**
 * The `staged` ledger role: the staged review set's verdict is one row per review, and
 * analysis reports it under that role without changing any other role's counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeReviewLedger, formatReviewAnalysis } from './reviews-analysis.js';
import {
  loadReviewLedger,
  normalizeReviewerRole,
  appendReviewLedgerRecord,
} from './reviews-ledger.js';
import type { ReviewLedgerRecord } from './reviews-ledger.js';
import { buildReviewsCli } from '../cli/reviews.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

function rec(overrides: Partial<ReviewLedgerRecord>): ReviewLedgerRecord {
  return {
    taskId: 'AISDLC-1',
    prNumber: null,
    commitSha: 'a'.repeat(40),
    iteration: 1,
    role: 'code',
    harness: 'claude-code',
    timestamp: '2026-10-10T00:00:00.000Z',
    verdict: 'approved',
    findings: [],
    ...overrides,
  };
}

const finding = (title: string) => ({ severity: 'major' as const, summary: title, title });

/** Three cycles with the original three roles, one of which security blocks. */
const base: ReviewLedgerRecord[] = [
  rec({ commitSha: '1'.repeat(40), role: 'code' }),
  rec({ commitSha: '1'.repeat(40), role: 'test' }),
  rec({
    commitSha: '1'.repeat(40),
    role: 'security',
    verdict: 'rejected',
    findings: [finding('hardcoded secret')],
  }),
  rec({ commitSha: '2'.repeat(40), role: 'code', verdict: 'rejected', findings: [finding('a')] }),
  rec({ commitSha: '2'.repeat(40), role: 'test' }),
  rec({ commitSha: '2'.repeat(40), role: 'security' }),
  rec({ commitSha: '3'.repeat(40), role: 'code' }),
  rec({ commitSha: '3'.repeat(40), role: 'test' }),
  rec({ commitSha: '3'.repeat(40), role: 'security' }),
];

describe('normalizeReviewerRole', () => {
  it('maps the staged set to the staged role', () => {
    expect(normalizeReviewerRole('staged-review')).toBe('staged');
    expect(normalizeReviewerRole('staged')).toBe('staged');
  });
  it('leaves the existing mappings alone', () => {
    expect(normalizeReviewerRole('code-reviewer-codex')).toBe('code');
    expect(normalizeReviewerRole('correctness-reviewer')).toBe('correctness');
    expect(normalizeReviewerRole('something-else')).toBeNull();
  });
});

describe('analysis with staged rows', () => {
  const staged: ReviewLedgerRecord[] = [
    // Same cycle as the first three: staged blocked where code and test did not.
    rec({
      commitSha: '1'.repeat(40),
      role: 'staged',
      verdict: 'rejected',
      findings: [finding('hardcoded secret'), finding('extra')],
    }),
    // A cycle only staged ran in.
    rec({ commitSha: '4'.repeat(40), role: 'staged' }),
    // Staged agreeing with code in cycle 2.
    rec({
      commitSha: '2'.repeat(40),
      role: 'staged',
      verdict: 'rejected',
      findings: [finding('a')],
    }),
  ];

  it('reports staged under its own role', () => {
    const result = analyzeReviewLedger([...base, ...staged]);
    const row = result.perRole.find((r) => r.role === 'staged')!;
    expect(row.participatedCycles).toBe(3);
    expect(row.blockedCycles).toBe(2);
    // Cycle 1: security also blocked, so staged is not sole. Cycle 2: code also blocked.
    expect(row.soleBlockerCycles).toBe(0);
    expect(result.totalCycles).toBe(4);
  });

  it("does not change any other role's counts or rates", () => {
    const without = analyzeReviewLedger(base);
    const withStaged = analyzeReviewLedger([...base, ...staged]);
    for (const role of ['code', 'test', 'security', 'correctness'] as const) {
      expect(withStaged.perRole.find((r) => r.role === role)).toEqual(
        without.perRole.find((r) => r.role === role),
      );
    }
    const unrelated = without.pairOverlaps.filter(
      (p) => p.roleA !== 'staged' && p.roleB !== 'staged',
    );
    for (const p of unrelated) {
      expect(
        withStaged.pairOverlaps.find((q) => q.roleA === p.roleA && q.roleB === p.roleB),
      ).toEqual(p);
    }
  });

  it('compares staged against the standalone reviewers', () => {
    const result = analyzeReviewLedger([...base, ...staged]);
    const pair = result.pairOverlaps.find((p) => p.roleA === 'code' && p.roleB === 'staged')!;
    expect(pair.cyclesBothParticipated).toBe(2);
    // Cycle 1: {} vs {hardcoded secret, extra} ; cycle 2: {a} vs {a}.
    expect(pair.unionFindingCount).toBe(3);
    expect(pair.overlapFindingCount).toBe(1);
  });

  it('prints the staged row', () => {
    expect(formatReviewAnalysis(analyzeReviewLedger([...base, ...staged]))).toContain('staged');
  });
});

describe('cli-reviews analyze over a ledger with staged rows', () => {
  let root: string;
  let out: string[];
  let saved: typeof process.stdout.write;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'staged-ledger-'));
    out = [];
    saved = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = saved;
    removeFixtureDir(root);
  });

  it('reports the staged rows under the staged role in JSON', async () => {
    for (const r of [...base, ...staged()]) appendReviewLedgerRecord(r, root);
    expect(loadReviewLedger('AISDLC-1', root)).toHaveLength(base.length + staged().length);
    await buildReviewsCli(['analyze', '--repo-root', root, '--json']).parseAsync();
    const parsed = JSON.parse(out.join('')) as ReturnType<typeof analyzeReviewLedger>;
    expect(parsed.perRole.find((r) => r.role === 'staged')?.participatedCycles).toBe(2);
    expect(parsed.perRole.find((r) => r.role === 'code')?.participatedCycles).toBe(3);
  });

  function staged(): ReviewLedgerRecord[] {
    return [
      rec({ commitSha: '1'.repeat(40), role: 'staged' }),
      rec({
        commitSha: '2'.repeat(40),
        role: 'staged',
        verdict: 'rejected',
        findings: [finding('a')],
      }),
    ];
  }
});
