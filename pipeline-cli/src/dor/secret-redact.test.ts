/**
 * Secret redaction tests (AISDLC-122).
 *
 * Each named pattern gets a positive case (matching token is replaced)
 * and a negative case (similar-but-non-matching string is unchanged).
 * The high-entropy catch-all is asserted last because it overlaps with
 * the more specific patterns by design.
 *
 * Test fixtures use OBVIOUSLY FAKE tokens (`sk-test-...`, `ghp_aaa...`,
 * `AKIAIOSFODNN7EXAMPLEE`, etc.) — any real-looking token in this file
 * would be flagged by GitHub secret scanning and rotated upstream.
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERNS } from './secret-redact.js';

describe('redactSecrets', () => {
  it('returns empty string for null / undefined / empty input', () => {
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets('')).toBe('');
  });

  it('returns the input unchanged when nothing matches', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('nothing to see here, move along')).toBe(
      'nothing to see here, move along',
    );
  });

  describe('OpenAI keys', () => {
    it('redacts classic sk- keys', () => {
      const input = 'token: sk-test1234567890abcdef1234567890 — done';
      expect(redactSecrets(input)).toBe('token: [REDACTED:OPENAI] — done');
    });

    it('redacts project-scoped sk-proj- keys with the OPENAI_PROJECT marker', () => {
      const input = 'key=sk-proj-abcdef_1234-567890ABCDEF1234567890 next';
      expect(redactSecrets(input)).toBe('key=[REDACTED:OPENAI_PROJECT] next');
    });

    it('does not match short sk- prefixes (<20 char body)', () => {
      const input = 'sk-short';
      expect(redactSecrets(input)).toBe('sk-short');
    });
  });

  describe('GitHub PATs', () => {
    it('redacts classic ghp_ tokens (exactly 36 chars body)', () => {
      const input = `auth: ghp_${'a'.repeat(36)} done`;
      expect(redactSecrets(input)).toBe('auth: [REDACTED:GITHUB_PAT] done');
    });

    it('redacts fine-grained github_pat_ tokens (82 chars body)', () => {
      const input = `auth: github_pat_${'A'.repeat(82)} done`;
      expect(redactSecrets(input)).toBe('auth: [REDACTED:GITHUB_PAT_FINE] done');
    });

    it('does not match wrong-length ghp_ prefixes', () => {
      const input = 'ghp_short';
      expect(redactSecrets(input)).toBe('ghp_short');
    });
  });

  describe('AWS access keys', () => {
    it('redacts AKIA-prefixed access keys', () => {
      const input = 'aws: AKIAIOSFODNN7EXAMPLE done';
      expect(redactSecrets(input)).toBe('aws: [REDACTED:AWS_ACCESS_KEY] done');
    });

    it('does not match similar-but-shorter prefixes', () => {
      const input = 'AKIA-short';
      expect(redactSecrets(input)).toBe('AKIA-short');
    });
  });

  describe('JWTs', () => {
    it('redacts well-formed three-segment JWTs', () => {
      const jwt = `eyJ${'a'.repeat(15)}.eyJ${'b'.repeat(15)}.${'c'.repeat(15)}`;
      const input = `bearer ${jwt} ok`;
      expect(redactSecrets(input)).toBe('bearer [REDACTED:JWT] ok');
    });

    it('does not match two-segment strings as JWTs', () => {
      const input = `eyJ${'a'.repeat(15)}.eyJ${'b'.repeat(15)}`; // 2 segments
      // No JWT match (needs 3 segments). The dot keeps it from being a
      // single 40+ run, and each segment is < 40 chars, so the
      // high-entropy catch-all also stays quiet.
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('high-entropy catch-all', () => {
    it('replaces unknown 40+ char alphanumeric runs', () => {
      const input = `random=${'a'.repeat(50)} done`;
      expect(redactSecrets(input)).toBe('random=[REDACTED:HIGH-ENTROPY] done');
    });

    it('leaves shorter strings alone', () => {
      const input = `random=${'a'.repeat(20)} done`;
      expect(redactSecrets(input)).toBe(`random=${'a'.repeat(20)} done`);
    });
  });

  it('redacts multiple distinct secrets in one string', () => {
    const input = [
      `OpenAI: sk-test1234567890abcdef1234567890`,
      `GitHub: ghp_${'a'.repeat(36)}`,
      `AWS: AKIAIOSFODNN7EXAMPLE`,
    ].join(' | ');
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:OPENAI]');
    expect(out).toContain('[REDACTED:GITHUB_PAT]');
    expect(out).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(out).not.toContain('sk-test');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('AKIA');
  });

  it('exports a non-empty registry of patterns', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SECRET_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.regex.flags).toContain('g');
    }
  });
});
