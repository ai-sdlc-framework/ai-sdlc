/**
 * Hermetic tests for RFC-0043 Phase 2 — Zod boundary schema (AISDLC-498)
 *
 * AC#10 coverage:
 *   - Schema round-trip: write report → validate → mutate → re-validate fails
 *   - Tamper rejection: malformed / missing / extra fields rejected
 *   - Strict Zod: extra/injected keys REJECTED at every object boundary
 *   - Zod↔JSON-schema agreement: AJV validates the same inputs as Zod
 *   - No confidence-score / cveDetected / complexityDelta fields (AC#4)
 *   - Decision Catalog Stage A counter (AC#9)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import _Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

// Handle CJS default export interop (mirrors reference/src/core/validation.ts)
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

// ── AJV helper ───────────────────────────────────────────────────────────────

const _dirname = fileURLToPath(new URL('.', import.meta.url));
// From pipeline-cli/src/pipeline/ → up 3 levels = worktree root
const SCHEMA_PATH = join(_dirname, '../../../spec/schemas/untrusted-pr-report.v1.schema.json');

function buildAjvValidator() {
  // AJV 2020-12 without format plugins — format: 'date-time' is advisory in
  // JSON Schema 2020-12 (format assertions are opt-in). We skip ajv-formats to
  // avoid adding a devDependency that isn't in pipeline-cli's package.json.
  // The structural properties (required, additionalProperties, enum, const) that
  // matter for the Zod↔JSON-schema agreement test all work without it.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  return ajv.compile(schema);
}

const ajvValidate = buildAjvValidator();
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

  it('rejects when promptInjectionDetected is omitted (required security signal)', () => {
    // promptInjectionDetected is REQUIRED in both Zod and the JSON schema.
    // Omitting it could mask an injection attempt — the sandbox must always
    // emit an explicit boolean, never rely on a default.
    const data = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: { approved: true, findings: [] }, // omit promptInjectionDetected
      },
    };
    const result = UntrustedPrReportSchema.safeParse(data);
    expect(result.success).toBe(false);
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

// ── Strict boundary: extra/injected keys REJECTED (finding #1) ───────────────

describe('UntrustedPrReportSchema — strict boundary rejects extra/injected keys', () => {
  it('rejects an extra key at the root level (e.g. injected "override")', () => {
    const tampered = { ...VALID_REPORT, override: true };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/override/i);
  });

  it('rejects an injected "__proto__" key at root level', () => {
    const tampered = { ...VALID_REPORT, __proto__: { isAdmin: true } };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects an injected "signature" key at root level (spoofed attestation field)', () => {
    const tampered = { ...VALID_REPORT, signature: 'AAAA' };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/signature/i);
  });

  it('rejects an extra key injected into the trust object', () => {
    const tampered = {
      ...VALID_REPORT,
      trust: { ...VALID_REPORT.trust, injected: 'evil' },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/injected/i);
  });

  it('rejects an extra key injected into a ReviewerVerdict (nested)', () => {
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          ...VALID_REPORT.reviewers.code,
          approved: false, // attacker tries to flip verdict
          extraKey: 'payload',
        },
      },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/extraKey/i);
  });

  it('rejects an extra key injected into a Finding (deeply nested)', () => {
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          approved: false,
          findings: [{ severity: 'major', message: 'real finding', injected: 'payload' }],
          promptInjectionDetected: false,
        },
      },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/injected/i);
  });

  it('rejects an extra key injected into the consensus object', () => {
    const tampered = {
      ...VALID_REPORT,
      consensus: { ...VALID_REPORT.consensus, override: 'approve-anyway' },
    };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/override/i);
  });
});

// ── Zod↔JSON-schema agreement via AJV (finding #3) ───────────────────────────

describe('Zod↔JSON-schema agreement (AJV)', () => {
  it('VALID_REPORT passes the JSON schema via AJV', () => {
    const valid = ajvValidate(VALID_REPORT);
    expect(valid).toBe(true);
    if (!valid) {
      throw new Error(`AJV validation failed: ${JSON.stringify(ajvValidate.errors)}`);
    }
  });

  it('a report with wrong schemaVersion is rejected by both Zod AND AJV', () => {
    const tampered = { ...VALID_REPORT, schemaVersion: 'untrusted-pr-report.v2' };
    // Zod
    const zodResult = validateReport(tampered);
    expect(zodResult.valid).toBe(false);
    // AJV
    const ajvResult = ajvValidate(tampered);
    expect(ajvResult).toBe(false);
  });

  it('a report with an extra root key is rejected by Zod (strict) AND AJV (additionalProperties:false)', () => {
    const tampered = { ...VALID_REPORT, extra: 'injected' };
    // Zod
    const zodResult = validateReport(tampered);
    expect(zodResult.valid).toBe(false);
    // AJV
    const ajvResult = ajvValidate(tampered);
    expect(ajvResult).toBe(false);
  });

  it('a report with an extra ReviewerVerdict key is rejected by both Zod AND AJV', () => {
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: { ...VALID_REPORT.reviewers.code, surprise: true },
      },
    };
    // Zod
    const zodResult = validateReport(tampered);
    expect(zodResult.valid).toBe(false);
    // AJV
    const ajvResult = ajvValidate(tampered);
    expect(ajvResult).toBe(false);
  });

  it('a report missing promptInjectionDetected is rejected by both Zod AND AJV', () => {
    const { reviewers } = VALID_REPORT;
    const { promptInjectionDetected: _omit, ...codeWithout } = reviewers.code;
    const tampered = {
      ...VALID_REPORT,
      reviewers: { ...reviewers, code: codeWithout },
    };
    // Zod
    const zodResult = validateReport(tampered);
    expect(zodResult.valid).toBe(false);
    // AJV
    const ajvResult = ajvValidate(tampered);
    expect(ajvResult).toBe(false);
  });

  it('a report with invalid headSha (non-hex) is rejected by both Zod AND AJV', () => {
    const tampered = { ...VALID_REPORT, headSha: 'Z'.repeat(40) };
    // Zod
    const zodResult = validateReport(tampered);
    expect(zodResult.valid).toBe(false);
    // AJV
    const ajvResult = ajvValidate(tampered);
    expect(ajvResult).toBe(false);
  });
});

// ── AC#4: No confidence-score / cveDetected / complexityDelta ───────────────

describe('UntrustedPrReportSchema — no forbidden fields (AC#4)', () => {
  it('schema does NOT have top-level confidenceScore field', () => {
    // Verify that the inferred type does not include these fields.
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

  it('report with a forbidden field (confidenceScore) is REJECTED (not stripped) in strict mode', () => {
    // With .strict(), extra keys like confidenceScore are REJECTED rather than
    // silently stripped. This prevents an attacker from embedding a field whose
    // presence could influence downstream logic in a non-Zod consumer.
    const tampered = { ...VALID_REPORT, confidenceScore: 0.99 };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('Expected invalid');
    expect(result.error).toMatch(/confidenceScore/i);
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
