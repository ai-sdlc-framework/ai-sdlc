/**
 * RFC-0043 Phase 2 — Stage 4 Clean-Room Signer: Zod boundary schema (AISDLC-498)
 *
 * This is the trust boundary that Stage-4 enforces BEFORE any key is touched.
 * The sandbox (Stages 2-3) emits an unsigned report artifact; the clean-room
 * signer reads it, Zod-validates it here, and ONLY THEN proceeds to build the
 * RFC-0042 v6 Merkle attestation.
 *
 * ## Deliberate divergence from the feature request
 *
 * NO top-level `confidenceScore`, `complexityDelta`, or `cveDetected` fields.
 * AI-SDLC's review policy is severity-gated, not confidence-scored:
 *   - Blocking is determined by `critical`/`major` findings.
 *   - `cveDetected` is subsumed by a `critical` security finding.
 *   - Introducing a parallel scoring vocabulary would fork the verdict contract.
 * This schema stays aligned with what reviewers already emit.
 *
 * ## Alignment with JSON Schema
 *
 * This Zod definition is the runtime boundary mirror of
 * `spec/schemas/untrusted-pr-report.v1.schema.json`. Any change to either
 * MUST be reflected in the other — both are tested in report-validator.test.ts.
 *
 * @module pipeline/report-validator
 */

import { z } from 'zod';

// ── Shared sub-schemas ────────────────────────────────────────────────────────

/**
 * A single finding from a reviewer.
 *
 * Severity vocabulary is deliberately aligned with the existing AI-SDLC
 * reviewer verdict contract — NOT with the feature-request's PASSED/FAILED
 * or confidence-score vocabulary.
 *
 * `.strict()` ensures unknown keys (e.g. injected `signature`, `override`,
 * `__proto__`) are REJECTED, not silently stripped. This is the trust boundary.
 */
const FindingSchema = z
  .object({
    severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
    message: z.string().min(1),
    path: z.string().optional(),
  })
  .strict();

/**
 * Single reviewer verdict.
 *
 * `promptInjectionDetected` is a **required** security signal (aligned with
 * the JSON schema `required` list). The sandbox MUST always emit a boolean —
 * omitting it could mask an injection attempt that slipped through. Callers
 * must explicitly pass `false` rather than relying on a default.
 *
 * `.strict()` rejects unknown keys at the trust boundary.
 */
const ReviewerVerdictSchema = z
  .object({
    approved: z.boolean(),
    findings: z.array(FindingSchema),
    promptInjectionDetected: z.boolean(),
  })
  .strict();

// ── Root report schema ────────────────────────────────────────────────────────

/**
 * Boundary schema for the Stage-4 clean-room signer.
 *
 * The signer calls `UntrustedPrReportSchema.parse(artifact)` BEFORE resolving
 * the signing key. A tampered, malformed, or schema-mismatched report is
 * rejected here with a Zod parse error — the key is never touched.
 *
 * Field coverage matches `spec/schemas/untrusted-pr-report.v1.schema.json`:
 *   schemaVersion, prNumber, headSha, baseSha, generatedAt,
 *   trust.{classification, reason},
 *   astGate.{outcome, offendingPaths},
 *   differentialTest.{upstreamSuitePassed, newTestsPassed, newCodeCoveragePct},
 *   reviewers.{code, test, security},
 *   consensus.{approved, blockingFindings}
 */
export const UntrustedPrReportSchema = z
  .object({
    /** Pinned identifier — must be exact literal to prevent cross-version forgery. */
    schemaVersion: z.literal('untrusted-pr-report.v1'),
    prNumber: z.number().int().positive(),
    /** 40-hex-char commit SHA at the PR head. */
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
    /** 40-hex-char commit SHA of the merge base. */
    baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
    /** ISO 8601 timestamp when the sandbox produced this report. */
    generatedAt: z.string().datetime(),
    /** Stage 0 trust classification result. */
    trust: z
      .object({
        classification: z.enum(['untrusted', 'trusted']),
        reason: z.string().min(1),
      })
      .strict(),
    /** Stage 1 deterministic diff / AST gate result. */
    astGate: z
      .object({
        outcome: z.enum(['pass', 'abort-protected-path']),
        offendingPaths: z.array(z.string()),
      })
      .strict(),
    /** Stage 2 OpenShell differential testing results. */
    differentialTest: z
      .object({
        upstreamSuitePassed: z.boolean(),
        newTestsPassed: z.boolean(),
        newCodeCoveragePct: z.number().min(0).max(100),
      })
      .strict(),
    /** Stage 3 hardened 3-reviewer matrix verdicts. */
    reviewers: z
      .object({
        code: ReviewerVerdictSchema,
        test: ReviewerVerdictSchema,
        security: ReviewerVerdictSchema,
      })
      .strict(),
    /** Aggregated consensus across all three reviewers. */
    consensus: z
      .object({
        approved: z.boolean(),
        blockingFindings: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

// ── Inferred types ────────────────────────────────────────────────────────────

/** Inferred TypeScript type for a validated untrusted-PR report. */
export type UntrustedPrReport = z.infer<typeof UntrustedPrReportSchema>;

/** Inferred type for a single reviewer verdict. */
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

/** Inferred type for a single finding. */
export type Finding = z.infer<typeof FindingSchema>;

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Result of validating an untrusted-PR report artifact.
 *
 * On success: `{ valid: true, report: UntrustedPrReport }`.
 * On failure: `{ valid: false, error: string }` — the error is safe to log
 * and include in rejection reasons (no key material, no secrets).
 */
export type ReportValidationResult =
  | { valid: true; report: UntrustedPrReport }
  | { valid: false; error: string };

/**
 * Validate an untrusted-PR report artifact against the Zod boundary schema.
 *
 * This is the entry point called by the clean-room signer BEFORE any key
 * is resolved or touched. Returns a discriminated union so callers can
 * handle the tamper-rejection path cleanly without try/catch.
 *
 * @example
 * ```ts
 * const result = validateReport(JSON.parse(artifactJson));
 * if (!result.valid) {
 *   // Reject — do NOT proceed to key resolution
 *   throw new Error(`[clean-room-signer] Report rejected: ${result.error}`);
 * }
 * const report = result.report;
 * // ... proceed to build Merkle tree + sign
 * ```
 */
export function validateReport(data: unknown): ReportValidationResult {
  const parsed = UntrustedPrReportSchema.safeParse(data);
  if (parsed.success) {
    return { valid: true, report: parsed.data };
  }
  // Flatten Zod errors into a concise single-line string for signer logs.
  const messages = parsed.error.errors
    .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
    .join('; ');
  return { valid: false, error: messages };
}

// ── Decision Catalog — OQ-4 Stage A counter (AC#9) ───────────────────────────

/**
 * Decision summary for `untrusted-pr-sigstore-anchor-request`.
 *
 * OQ-4 resolution: operator-key Merkle ONLY for v1. This Stage A counter
 * tracks distinct adopter requests for cross-org verifiability (Sigstore/
 * Rekor). Auto-promote at ≥2 distinct adopter requests → trigger follow-on RFC.
 * No v1 activation surface — counter tracking only.
 *
 * RFC-0035 G0 non-blocking pipeline contract: events route through the
 * Decision Catalog for operator review. Callers use this constant to open
 * a Decision via `cli-decisions add`.
 *
 * The string value MUST NOT contain internal tracker IDs (AISDLC-NNN) per
 * the adopter-facing-strings gate.
 */
export const SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY = 'untrusted-pr-sigstore-anchor-request';

/**
 * RFC-0035 Stage A counter entry shape for the Sigstore-anchor request.
 *
 * Auto-promote threshold: ≥2 distinct adopter requests for cross-org
 * verifiability. When the threshold is crossed the Decision Catalog
 * routes a follow-on RFC proposal to the operator.
 *
 * No v1 activation surface — counter tracking only (OQ-4 resolution).
 */
export interface SigstoreAnchorRequestCounter {
  /** Count of distinct adopter organizations requesting Sigstore anchoring. */
  count: number;
  /**
   * Whether the auto-promote threshold (≥2 distinct requests) has been
   * reached. When true, the Decision Catalog routes a follow-on RFC.
   */
  thresholdReached: boolean;
  /**
   * Distinct adopter identifiers (org names, emails, or any non-sensitive
   * handle) that have requested Sigstore anchoring.
   */
  requesters: string[];
}

/**
 * Increment a Sigstore anchor request counter.
 *
 * Returns the updated counter. Callers persist this to the Decision Catalog
 * via `cli-decisions add`. The auto-promote threshold is ≥2 distinct requests.
 *
 * @param existing - Current counter state, or undefined for first request.
 * @param requester - Opaque non-sensitive requester identifier (org name etc.).
 */
export function incrementSigstoreAnchorCounter(
  existing: SigstoreAnchorRequestCounter | undefined,
  requester: string,
): SigstoreAnchorRequestCounter {
  const prev = existing ?? { count: 0, thresholdReached: false, requesters: [] };
  // Deduplicate: same requester submitting again doesn't increment count.
  if (prev.requesters.includes(requester)) {
    return prev;
  }
  const requesters = [...prev.requesters, requester];
  const count = requesters.length;
  const thresholdReached = count >= 2;
  return { count, thresholdReached, requesters };
}
