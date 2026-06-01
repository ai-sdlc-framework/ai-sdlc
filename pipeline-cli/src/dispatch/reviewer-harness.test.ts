/**
 * Hermetic unit tests for the reviewer-harness selector (AISDLC-483).
 *
 * AC-5: asserts that with no override env vars set, the selection logic
 * resolves:
 *   - code-reviewer  → code-reviewer-codex  (codex harness)
 *   - test-reviewer  → test-reviewer-codex  (codex harness)
 *   - security       → security-reviewer    (claude-code, opus)
 *   - developer      → developer            (claude-code, sonnet)
 *
 * Also covers:
 *   - AI_SDLC_REVIEWER_HARNESS=claude forces Claude-native agents for
 *     code/test, leaves security + developer unchanged.
 *   - resolveReviewerByClassifierName maps 'testing'/'critic'/'security'
 *     correctly.
 *   - Unknown classifier names produce a safe fallback (no panic).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveReviewer,
  resolveReviewerByClassifierName,
  REVIEWER_HARNESS_ENV,
} from './reviewer-harness.js';

// Capture + restore the env var around each test so tests don't bleed.
const ORIGINAL_ENV = process.env[REVIEWER_HARNESS_ENV];

beforeEach(() => {
  delete process.env[REVIEWER_HARNESS_ENV];
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[REVIEWER_HARNESS_ENV];
  } else {
    process.env[REVIEWER_HARNESS_ENV] = ORIGINAL_ENV;
  }
});

describe('resolveReviewer — default (no override)', () => {
  it('routes code review to code-reviewer-codex with codex harness', () => {
    const result = resolveReviewer('code');
    expect(result.agentName).toBe('code-reviewer-codex');
    expect(result.harness).toBe('codex');
  });

  it('routes test review to test-reviewer-codex with codex harness', () => {
    const result = resolveReviewer('test');
    expect(result.agentName).toBe('test-reviewer-codex');
    expect(result.harness).toBe('codex');
  });

  it('routes security review to security-reviewer with claude-code harness at opus', () => {
    const result = resolveReviewer('security');
    expect(result.agentName).toBe('security-reviewer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('opus');
  });

  it('routes developer to developer with claude-code harness at sonnet', () => {
    const result = resolveReviewer('developer');
    expect(result.agentName).toBe('developer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('sonnet');
  });
});

describe('resolveReviewer — AI_SDLC_REVIEWER_HARNESS=claude override (via env)', () => {
  beforeEach(() => {
    process.env[REVIEWER_HARNESS_ENV] = 'claude';
  });

  it('forces code review to claude-native code-reviewer', () => {
    const result = resolveReviewer('code');
    expect(result.agentName).toBe('code-reviewer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('sonnet');
  });

  it('forces test review to claude-native test-reviewer', () => {
    const result = resolveReviewer('test');
    expect(result.agentName).toBe('test-reviewer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('sonnet');
  });

  it('does NOT change security-reviewer (always claude-native)', () => {
    const result = resolveReviewer('security');
    expect(result.agentName).toBe('security-reviewer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('opus');
  });

  it('does NOT change developer (always claude-native sonnet)', () => {
    const result = resolveReviewer('developer');
    expect(result.agentName).toBe('developer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('sonnet');
  });
});

describe('resolveReviewer — explicit overrideHarness parameter', () => {
  it('explicit claude override takes precedence over env var (no env set)', () => {
    const result = resolveReviewer('code', 'claude');
    expect(result.agentName).toBe('code-reviewer');
    expect(result.harness).toBe('claude-code');
  });

  it('explicit empty string restores default even when env var is set', () => {
    process.env[REVIEWER_HARNESS_ENV] = 'claude';
    // Explicitly passing empty string should... hmm, the resolver reads env when
    // overrideHarness is undefined. An explicit '' would read as falsy but not
    // undefined — let's verify the behaviour is "use default" when not 'claude'.
    const result = resolveReviewer('code', '');
    expect(result.agentName).toBe('code-reviewer-codex');
    expect(result.harness).toBe('codex');
  });

  it('unknown override value is treated as default (codex)', () => {
    const result = resolveReviewer('test', 'something-else');
    expect(result.agentName).toBe('test-reviewer-codex');
    expect(result.harness).toBe('codex');
  });
});

describe('resolveReviewerByClassifierName — default (no override)', () => {
  it("maps 'critic' to code-reviewer-codex", () => {
    const result = resolveReviewerByClassifierName('critic');
    expect(result.agentName).toBe('code-reviewer-codex');
    expect(result.harness).toBe('codex');
  });

  it("maps 'testing' to test-reviewer-codex", () => {
    const result = resolveReviewerByClassifierName('testing');
    expect(result.agentName).toBe('test-reviewer-codex');
    expect(result.harness).toBe('codex');
  });

  it("maps 'security' to security-reviewer (claude-code, opus)", () => {
    const result = resolveReviewerByClassifierName('security');
    expect(result.agentName).toBe('security-reviewer');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('opus');
  });

  it('unknown classifier name falls back to claude-code with given name as agentName', () => {
    const result = resolveReviewerByClassifierName('custom-review');
    expect(result.agentName).toBe('custom-review');
    expect(result.harness).toBe('claude-code');
    expect(result.model).toBe('sonnet');
  });
});

describe('resolveReviewerByClassifierName — AI_SDLC_REVIEWER_HARNESS=claude override', () => {
  beforeEach(() => {
    process.env[REVIEWER_HARNESS_ENV] = 'claude';
  });

  it("maps 'critic' to claude-native code-reviewer", () => {
    const result = resolveReviewerByClassifierName('critic');
    expect(result.agentName).toBe('code-reviewer');
    expect(result.harness).toBe('claude-code');
  });

  it("maps 'testing' to claude-native test-reviewer", () => {
    const result = resolveReviewerByClassifierName('testing');
    expect(result.agentName).toBe('test-reviewer');
    expect(result.harness).toBe('claude-code');
  });

  it('security is unaffected by override', () => {
    const result = resolveReviewerByClassifierName('security');
    expect(result.agentName).toBe('security-reviewer');
    expect(result.model).toBe('opus');
  });
});
