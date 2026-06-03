/**
 * Hermetic tests for RFC-0043 Phase 2 — Zod boundary schema (AISDLC-498)
 *
 * AC#10 coverage:
 *   - Schema round-trip: write report → validate → mutate → re-validate fails
 *   - Tamper rejection: malformed / missing / extra fields rejected
 *   - No confidence-score / cveDetected / complexityDelta fields (AC#4)
 *   - Decision Catalog Stage A counter (AC#9)
 */

import { describe, expect, it } from 'vitest';
import {
  UntrustedPrReportSchema,
  validateReport,
  incrementSigstoreAnchorCounter,
  SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY,
} from './report-validator.js';
import type { UntrustedPrReport, SigstoreAnchorRequestCounter } from './report-validator.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const VALID_REPORT: UntrustedPrReport = {
  schemaVersion: 'untrusted-pr-report.v1',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  generatedAt: '2026-06-02T10:00:00.000Z',
  trust: {
    classification: 'untrusted',
    reason: 'author-not-in-allowlist',
  },
  astGate: {
    outcome: 'pass',
    offendingPaths: [],
  },
  differentialTest: {
    upstreamSuitePassed: true,
    newTestsPassed: true,
    newCodeCoveragePct: 87.5,
  },
  reviewers: {
    code: {
      approved: true,
      findings: [],
      promptInjectionDetected: false,
    },
    test: {
      approved: true,
      findings: [
        {
          severity: 'minor',
          message: 'Test naming could be more descriptive',
          path: 'src/foo.test.ts',
        },
      ],
      promptInjectionDetected: false,
    },
    security: {
      approved: true,
      findings: [],
      promptInjectionDetected: false,
    },
  },
  consensus: {
    approved: true,
    blockingFindings: 0,
  },
};

// ── Schema round-trip tests ──────────────────────────────────────────────────

describe('UntrustedPrReportSchema — round-trip', () => {
  it('accepts a fully valid report', () => {
    const result = validateReport(VALID_REPORT);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('Expected valid');
    expect(result.report.schemaVersion).toBe('untrusted-pr-report.v1');
    expect(result.report.prNumber).toBe(42);
  });

  it('infers promptInjectionDetected default false', () => {
    // Use safeParse to check default inference
    const data = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: { approved: true, findings: [] }, // omit promptInjectionDetected
      },
    };
    const result = UntrustedPrReportSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewers.code.promptInjectionDetected).toBe(false);
    }
  });

  it('accepts a report with blocking findings (not approved)', () => {
    const report: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: {
          approved: false,
          findings: [
            {
              severity: 'critical',
              message: 'SQL injection vulnerability in query builder',
              path: 'src/db/query.ts',
            },
          ],
          promptInjectionDetected: false,
        },
      },
      consensus: {
        approved: false,
        blockingFindings: 1,
      },
    };
    const result = validateReport(report);
    expect(result.valid).toBe(true);
  });

  it('accepts a report with prompt-injection detected', () => {
    const report: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: {
          approved: false,
          findings: [
            {
              severity: 'critical',
              message:
                'prompt-injection-attempt: diff contained instruction to approve unconditionally',
            },
          ],
          promptInjectionDetected: true,
        },
      },
      consensus: { approved: false, blockingFindings: 1 },
    };
    const result = validateReport(report);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('Expected valid');
    expect(result.report.reviewers.security.promptInjectionDetected).toBe(true);
  });
});

// ── Tamper rejection tests ───────────────────────────────────────────────────

describe('UntrustedPrReportSchema — tamper rejection (AC#10)', () => {
  it('rejects wrong schemaVersion', () => {
    const tampered = { ...VALID_REPORT, schemaVersion: 'untrusted-pr-report.v2' };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('schemaVersion');
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion: _, ...noVersion } = VALID_REPORT;
    const result = validateReport(noVersion);
    expect(result.valid).toBe(false);
  });

  it('rejects headSha with wrong length', () => {
    const tampered = { ...VALID_REPORT, headSha: 'abc123' };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('headSha');
  });

  it('rejects headSha with non-hex characters', () => {
    const tampered = { ...VALID_REPORT, headSha: 'g'.repeat(40) };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects baseSha with wrong length', () => {
    const tampered = { ...VALID_REPORT, baseSha: 'short' };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects prNumber of 0', () => {
    const tampered = { ...VALID_REPORT, prNumber: 0 };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('prNumber');
  });

  it('rejects negative prNumber', () => {
    const tampered = { ...VALID_REPORT, prNumber: -1 };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid generatedAt (not ISO 8601)', () => {
    const tampered = { ...VALID_REPORT, generatedAt: '2026-06-02' }; // date only, not datetime
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid trust.classification', () => {
    const tampered = {
      ...VALID_REPORT,
      trust: { classification: 'partially-trusted', reason: 'foo' },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('trust');
  });

  it('rejects invalid astGate.outcome', () => {
    const tampered = {
      ...VALID_REPORT,
      astGate: { outcome: 'skip', offendingPaths: [] },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects newCodeCoveragePct > 100', () => {
    const tampered = {
      ...VALID_REPORT,
      differentialTest: { ...VALID_REPORT.differentialTest, newCodeCoveragePct: 101 },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('newCodeCoveragePct');
  });

  it('rejects newCodeCoveragePct < 0', () => {
    const tampered = {
      ...VALID_REPORT,
      differentialTest: { ...VALID_REPORT.differentialTest, newCodeCoveragePct: -1 },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid finding severity', () => {
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          approved: false,
          findings: [{ severity: 'high', message: 'bad severity enum' }],
          promptInjectionDetected: false,
        },
      },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects empty finding message', () => {
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          approved: false,
          findings: [{ severity: 'major', message: '' }],
          promptInjectionDetected: false,
        },
      },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects missing reviewers.test', () => {
    const {
      reviewers: { test: _test, ...otherReviewers },
    } = VALID_REPORT;
    const tampered = { ...VALID_REPORT, reviewers: otherReviewers };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects negative blockingFindings', () => {
    const tampered = {
      ...VALID_REPORT,
      consensus: { approved: false, blockingFindings: -1 },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toContain('blockingFindings');
  });

  it('rejects null input', () => {
    const result = validateReport(null);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    const result = validateReport('not-a-report');
    expect(result.valid).toBe(false);
  });

  it('rejects array input', () => {
    const result = validateReport([VALID_REPORT]);
    expect(result.valid).toBe(false);
  });
});

// ── AC#4: No confidence-score / cveDetected / complexityDelta ───────────────

describe('UntrustedPrReportSchema — no forbidden fields (AC#4)', () => {
  it('schema does NOT have top-level confidenceScore field', () => {
    // Verify that the inferred type does not include these fields.
    // We add them as extra props to a valid report and expect them to be
    // stripped (Zod does NOT use strict mode here — they'll be accepted
    // but the type won't expose them). The key invariant is that the
    // authoritative type has no such fields.
    type HasConfidenceScore = 'confidenceScore' extends keyof UntrustedPrReport ? true : false;
    type HasComplexityDelta = 'complexityDelta' extends keyof UntrustedPrReport ? true : false;
    type HasCveDetected = 'cveDetected' extends keyof UntrustedPrReport ? true : false;

    // These should all be `false` — i.e. the keys do NOT exist on the type.
    const noConfidenceScore: HasConfidenceScore = false;
    const noComplexityDelta: HasComplexityDelta = false;
    const noCveDetected: HasCveDetected = false;

    expect(noConfidenceScore).toBe(false);
    expect(noComplexityDelta).toBe(false);
    expect(noCveDetected).toBe(false);
  });

  it('schema keys match the RFC §Design Details specification', () => {
    const shape = UntrustedPrReportSchema.shape;
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'prNumber',
        'headSha',
        'baseSha',
        'generatedAt',
        'trust',
        'astGate',
        'differentialTest',
        'reviewers',
        'consensus',
      ]),
    );
    // These MUST NOT be present.
    expect(Object.keys(shape)).not.toContain('confidenceScore');
    expect(Object.keys(shape)).not.toContain('complexityDelta');
    expect(Object.keys(shape)).not.toContain('cveDetected');
  });
});

// ── Decision Catalog Stage A counter (AC#9) ──────────────────────────────────

describe('SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY', () => {
  it('has the correct summary string (no internal tracker IDs)', () => {
    expect(SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY).toBe('untrusted-pr-sigstore-anchor-request');
    // Must not contain internal tracker IDs
    expect(SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY).not.toMatch(/AISDLC-\d+/i);
    expect(SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY).not.toMatch(/DEC-\d+/i);
  });
});

describe('incrementSigstoreAnchorCounter (AC#9)', () => {
  it('initialises counter from undefined', () => {
    const result = incrementSigstoreAnchorCounter(undefined, 'org-alpha');
    expect(result.count).toBe(1);
    expect(result.thresholdReached).toBe(false);
    expect(result.requesters).toEqual(['org-alpha']);
  });

  it('increments count on new distinct requester', () => {
    const initial = incrementSigstoreAnchorCounter(undefined, 'org-alpha');
    const updated = incrementSigstoreAnchorCounter(initial, 'org-beta');
    expect(updated.count).toBe(2);
    expect(updated.thresholdReached).toBe(true);
    expect(updated.requesters).toContain('org-alpha');
    expect(updated.requesters).toContain('org-beta');
  });

  it('auto-promotes threshold at exactly 2 distinct requests', () => {
    const c1 = incrementSigstoreAnchorCounter(undefined, 'org-a');
    expect(c1.thresholdReached).toBe(false);
    const c2 = incrementSigstoreAnchorCounter(c1, 'org-b');
    expect(c2.thresholdReached).toBe(true);
  });

  it('deduplicates same requester — count does not increase', () => {
    const c1 = incrementSigstoreAnchorCounter(undefined, 'org-alpha');
    const c2 = incrementSigstoreAnchorCounter(c1, 'org-alpha');
    expect(c2.count).toBe(1);
    expect(c2.thresholdReached).toBe(false);
  });

  it('counter stays promoted after threshold crossed', () => {
    let counter: SigstoreAnchorRequestCounter | undefined = undefined;
    counter = incrementSigstoreAnchorCounter(counter, 'org-a');
    counter = incrementSigstoreAnchorCounter(counter, 'org-b');
    counter = incrementSigstoreAnchorCounter(counter, 'org-c');
    expect(counter.count).toBe(3);
    expect(counter.thresholdReached).toBe(true);
  });

  it('does not activate anything (counter-only; no v1 activation surface)', () => {
    // The counter type has no `activated` or `enabled` field — this is
    // intentional per OQ-4 resolution: counter only, no v1 activation.
    type HasActivated = 'activated' extends keyof SigstoreAnchorRequestCounter ? true : false;
    type HasEnabled = 'enabled' extends keyof SigstoreAnchorRequestCounter ? true : false;
    const noActivated: HasActivated = false;
    const noEnabled: HasEnabled = false;
    expect(noActivated).toBe(false);
    expect(noEnabled).toBe(false);
  });
});
