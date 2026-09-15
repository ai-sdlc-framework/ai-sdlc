import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendReviewLedgerRecord,
  loadReviewLedger,
  loadAllReviewLedgers,
  normalizeFindings,
  normalizeReviewerRole,
  reviewsLedgerPath,
  type ReviewLedgerRecord,
} from './reviews-ledger.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'aisdlc-616-ledger-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ReviewLedgerRecord> = {}): ReviewLedgerRecord {
  return {
    taskId: 'AISDLC-616',
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

describe('reviewsLedgerPath', () => {
  it('resolves to .ai-sdlc/reviews/<task-id-lower>.jsonl', () => {
    const p = reviewsLedgerPath('AISDLC-616', repoRoot);
    expect(p).toBe(join(repoRoot, '.ai-sdlc', 'reviews', 'aisdlc-616.jsonl'));
  });
});

describe('AC-1: append-only — every call appends, never overwrites', () => {
  it('a single append writes one line readable back', () => {
    appendReviewLedgerRecord(makeRecord(), repoRoot);
    const records = loadReviewLedger('AISDLC-616', repoRoot);
    expect(records).toHaveLength(1);
    expect(records[0]?.taskId).toBe('AISDLC-616');
  });

  it('multiple iterations for the same task/reviewer all survive (first pass is never lost)', () => {
    appendReviewLedgerRecord(
      makeRecord({
        iteration: 1,
        verdict: 'rejected',
        findings: [{ severity: 'critical', summary: 'sql injection', title: 'sql injection' }],
      }),
      repoRoot,
    );
    appendReviewLedgerRecord(
      makeRecord({ iteration: 2, verdict: 'approved', findings: [] }),
      repoRoot,
    );

    const records = loadReviewLedger('AISDLC-616', repoRoot);
    expect(records).toHaveLength(2);
    // The iteration-1 REJECTED record with the critical finding must still be
    // present even though iteration 2 flipped to approved — this is the
    // exact signal the gitignored verdict files destroy today.
    expect(records[0]?.iteration).toBe(1);
    expect(records[0]?.verdict).toBe('rejected');
    expect(records[0]?.findings[0]?.severity).toBe('critical');
    expect(records[1]?.iteration).toBe(2);
    expect(records[1]?.verdict).toBe('approved');
  });

  it('records from multiple reviewer roles in the same iteration all persist independently', () => {
    appendReviewLedgerRecord(makeRecord({ role: 'code' }), repoRoot);
    appendReviewLedgerRecord(makeRecord({ role: 'test' }), repoRoot);
    appendReviewLedgerRecord(makeRecord({ role: 'security' }), repoRoot);

    const records = loadReviewLedger('AISDLC-616', repoRoot);
    expect(records.map((r) => r.role).sort()).toEqual(['code', 'security', 'test']);
  });

  it('writes the ledger file to disk as JSONL (one JSON object per line)', () => {
    appendReviewLedgerRecord(makeRecord(), repoRoot);
    appendReviewLedgerRecord(makeRecord({ iteration: 2 }), repoRoot);
    const raw = readFileSync(reviewsLedgerPath('AISDLC-616', repoRoot), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('returns an empty array when no ledger exists yet', () => {
    expect(loadReviewLedger('AISDLC-999', repoRoot)).toEqual([]);
    expect(existsSync(reviewsLedgerPath('AISDLC-999', repoRoot))).toBe(false);
  });
});

describe('AC-2: records carry role, severity-tagged findings, verdict, commitSha, iteration', () => {
  it('a record round-trips every required field', () => {
    const record = makeRecord({
      prNumber: 1234,
      commitSha: 'b'.repeat(40),
      iteration: 3,
      role: 'security',
      harness: 'claude-code',
      verdict: 'rejected',
      findings: [
        {
          severity: 'critical',
          summary: 'hardcoded secret',
          title: 'hardcoded secret',
          area: 'src/foo.ts',
        },
        { severity: 'minor', summary: 'nit', title: 'nit' },
      ],
    });
    appendReviewLedgerRecord(record, repoRoot);
    const [loaded] = loadReviewLedger('AISDLC-616', repoRoot);
    expect(loaded).toEqual(record);
  });
});

describe('normalizeReviewerRole', () => {
  it('maps plugin agent names to canonical roles', () => {
    expect(normalizeReviewerRole('code-reviewer')).toBe('code');
    expect(normalizeReviewerRole('code-reviewer-codex')).toBe('code');
    expect(normalizeReviewerRole('test-reviewer')).toBe('test');
    expect(normalizeReviewerRole('test-reviewer-codex')).toBe('test');
    expect(normalizeReviewerRole('security-reviewer')).toBe('security');
  });

  it('maps legacy orchestrator-tick classifier names', () => {
    expect(normalizeReviewerRole('testing')).toBe('test');
    expect(normalizeReviewerRole('critic')).toBe('security');
  });

  it('returns null for unrecognized names', () => {
    expect(normalizeReviewerRole('bogus')).toBeNull();
  });

  // AISDLC-617 — opt-in merged code+test reviewer.
  it('maps the AISDLC-617 correctness-reviewer name to the correctness role', () => {
    expect(normalizeReviewerRole('correctness-reviewer')).toBe('correctness');
    expect(normalizeReviewerRole('correctness')).toBe('correctness');
  });
});

describe('normalizeFindings — itemized array shape', () => {
  it('normalizes an itemized findings array into ReviewLedgerFinding[]', () => {
    const out = normalizeFindings([
      { severity: 'major', file: 'src/foo.ts', line: 10, message: 'Unhandled promise rejection' },
      { severity: 'MINOR', message: '  Extra   whitespace   ' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      severity: 'major',
      summary: 'Unhandled promise rejection',
      title: 'src/foo.ts: unhandled promise rejection',
      area: 'src/foo.ts',
    });
    expect(out[1]?.severity).toBe('minor');
    expect(out[1]?.title).toBe('extra whitespace');
  });

  it('drops items with an unrecognized severity', () => {
    const out = normalizeFindings([{ severity: 'nonsense', message: 'x' }]);
    expect(out).toEqual([]);
  });
});

describe('normalizeFindings — legacy counts-object shape', () => {
  it('synthesizes one finding per non-zero severity bucket', () => {
    const out = normalizeFindings({ critical: 1, major: 2, minor: 0, suggestion: 0 });
    expect(out.filter((f) => f.severity === 'critical')).toHaveLength(1);
    expect(out.filter((f) => f.severity === 'major')).toHaveLength(2);
    expect(out).toHaveLength(3);
  });

  it('returns [] for all-zero counts', () => {
    expect(normalizeFindings({ critical: 0, major: 0, minor: 0, suggestion: 0 })).toEqual([]);
  });
});

describe('normalizeFindings — undefined input', () => {
  it('returns []', () => {
    expect(normalizeFindings(undefined)).toEqual([]);
  });
});

describe('loadAllReviewLedgers', () => {
  it('flattens records across every task ledger file under .ai-sdlc/reviews/', () => {
    appendReviewLedgerRecord(makeRecord({ taskId: 'AISDLC-1' }), repoRoot);
    appendReviewLedgerRecord(makeRecord({ taskId: 'AISDLC-1', iteration: 2 }), repoRoot);
    appendReviewLedgerRecord(makeRecord({ taskId: 'AISDLC-2', role: 'test' }), repoRoot);

    const all = loadAllReviewLedgers(repoRoot);
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.taskId === 'AISDLC-1')).toHaveLength(2);
    expect(all.filter((r) => r.taskId === 'AISDLC-2')).toHaveLength(1);
  });

  it('returns [] when the reviews/ directory does not exist', () => {
    expect(loadAllReviewLedgers(repoRoot)).toEqual([]);
  });

  it('ignores non-.jsonl files in the reviews directory', () => {
    appendReviewLedgerRecord(makeRecord({ taskId: 'AISDLC-1' }), repoRoot);
    const dir = join(repoRoot, '.ai-sdlc', 'reviews');
    writeFileSync(join(dir, 'README.md'), 'not a ledger\n');
    expect(loadAllReviewLedgers(repoRoot)).toHaveLength(1);
  });
});

describe('loadReviewLedgerFromFile — malformed line resilience', () => {
  it('skips malformed JSONL lines without losing valid ones', () => {
    appendReviewLedgerRecord(makeRecord(), repoRoot);
    const p = reviewsLedgerPath('AISDLC-616', repoRoot);
    appendFileSync(p, 'not json\n');
    appendReviewLedgerRecord(makeRecord({ iteration: 2 }), repoRoot);

    const records = loadReviewLedger('AISDLC-616', repoRoot);
    expect(records).toHaveLength(2);
  });
});
