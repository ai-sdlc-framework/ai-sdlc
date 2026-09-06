/**
 * Hermetic tests for RFC-0046 Phase 3 (AISDLC-590) — opt-in trigger +
 * CI-provenance helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  isIsolatedReviewRequested,
  computeCiProvenance,
  ISOLATED_REVIEW_LABEL,
  ISOLATED_REVIEW_ENV_VAR,
} from './isolated-review-trigger.js';

describe('isIsolatedReviewRequested — opt-in gate (RFC-0046 OQ-5: opt-in default)', () => {
  it('returns false for a routine PR with no label and no env override (cost-guard default)', () => {
    expect(isIsolatedReviewRequested({ labels: [], env: {} })).toBe(false);
  });

  it('returns false when labels/env are entirely omitted', () => {
    expect(isIsolatedReviewRequested({})).toBe(false);
  });

  it('returns true when the PR carries the isolated-review label', () => {
    expect(isIsolatedReviewRequested({ labels: [ISOLATED_REVIEW_LABEL], env: {} })).toBe(true);
  });

  it('returns true alongside unrelated labels', () => {
    expect(
      isIsolatedReviewRequested({ labels: ['bug', ISOLATED_REVIEW_LABEL, 'p1'], env: {} }),
    ).toBe(true);
  });

  it('returns false for an unrelated label', () => {
    expect(isIsolatedReviewRequested({ labels: ['isolated-reviews-plz'], env: {} })).toBe(false);
  });

  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    it(`returns true when ${ISOLATED_REVIEW_ENV_VAR}=${JSON.stringify(truthy)}`, () => {
      expect(
        isIsolatedReviewRequested({ labels: [], env: { [ISOLATED_REVIEW_ENV_VAR]: truthy } }),
      ).toBe(true);
    });
  }

  for (const falsy of ['0', 'false', 'no', 'off', '']) {
    it(`returns false when ${ISOLATED_REVIEW_ENV_VAR}=${JSON.stringify(falsy)}`, () => {
      expect(
        isIsolatedReviewRequested({ labels: [], env: { [ISOLATED_REVIEW_ENV_VAR]: falsy } }),
      ).toBe(false);
    });
  }
});

describe('computeCiProvenance — RFC-0046 OQ-2 re-derivable anchor derivation', () => {
  it("returns deployment:'local' when GITHUB_ACTIONS is unset (operator/coordinator machine)", () => {
    expect(computeCiProvenance({})).toEqual({ deployment: 'local' });
  });

  it("returns deployment:'local' when GITHUB_ACTIONS is set to a non-'true' value", () => {
    expect(computeCiProvenance({ GITHUB_ACTIONS: 'false' })).toEqual({ deployment: 'local' });
  });

  it("returns deployment:'ci' with runId + workflowRef when GITHUB_ACTIONS='true'", () => {
    expect(
      computeCiProvenance({
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '123456',
        GITHUB_WORKFLOW_REF: 'org/repo/.github/workflows/isolated-review-gate.yml@refs/heads/main',
      }),
    ).toEqual({
      deployment: 'ci',
      runId: '123456',
      workflowRef: 'org/repo/.github/workflows/isolated-review-gate.yml@refs/heads/main',
    });
  });

  it("omits runId/workflowRef when absent even under deployment:'ci'", () => {
    expect(computeCiProvenance({ GITHUB_ACTIONS: 'true' })).toEqual({ deployment: 'ci' });
  });

  it('is case-insensitive-safe: only the literal lowercase "true" (GitHub-set convention) counts', () => {
    // GitHub Actions always sets this to the literal string 'true' — we do not
    // lowercase-normalize this one (unlike the opt-in label/env truthy check)
    // because GITHUB_ACTIONS is a platform-controlled signal, not adopter input.
    expect(computeCiProvenance({ GITHUB_ACTIONS: 'True' })).toEqual({ deployment: 'ci' });
  });
});
