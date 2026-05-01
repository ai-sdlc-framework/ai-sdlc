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

  describe('Anthropic keys', () => {
    it('redacts sk-ant-api03- keys with the ANTHROPIC marker', () => {
      const input = `key=sk-ant-api03-${'a'.repeat(20)} next`;
      expect(redactSecrets(input)).toBe('key=[REDACTED:ANTHROPIC] next');
    });

    it('redacts sk-ant-admin01- keys with the ANTHROPIC marker', () => {
      const input = `admin=sk-ant-admin01-${'b'.repeat(25)} done`;
      expect(redactSecrets(input)).toBe('admin=[REDACTED:ANTHROPIC] done');
    });

    it('does not match unknown sk-ant- variants', () => {
      // `sk-ant-foo-...` is not one of the documented suffixes.
      const input = `sk-ant-foo-${'a'.repeat(20)}`;
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('Slack tokens', () => {
    it('redacts xoxb- bot tokens', () => {
      const input = `token=xo${'xb'}-${'A'.repeat(12)}-${'B'.repeat(12)}-${'c'.repeat(24)} end`;
      expect(redactSecrets(input)).toBe('token=[REDACTED:SLACK] end');
    });

    it('redacts xoxp- user tokens', () => {
      const input = `slack: xoxp-${'a'.repeat(40)} ok`;
      expect(redactSecrets(input)).toBe('slack: [REDACTED:SLACK] ok');
    });

    it('does not match xox- short prefixes (< 10 char body)', () => {
      // `xoxb-aaa` is 5 chars short of the 10-char body floor.
      const input = 'xoxb-aaa';
      expect(redactSecrets(input)).toBe('xoxb-aaa');
    });
  });

  describe('Stripe keys', () => {
    it('redacts sk_live_ secret keys', () => {
      const input = `key=sk_live_${'a'.repeat(24)} done`;
      expect(redactSecrets(input)).toBe('key=[REDACTED:STRIPE_LIVE_SECRET] done');
    });

    it('redacts pk_live_ publishable keys', () => {
      const input = `pub=pk_live_${'b'.repeat(24)} done`;
      expect(redactSecrets(input)).toBe('pub=[REDACTED:STRIPE_LIVE_PUBLISHABLE] done');
    });

    it('redacts whsec_ webhook signing secrets', () => {
      const input = `sig=whsec_${'c'.repeat(24)} done`;
      expect(redactSecrets(input)).toBe('sig=[REDACTED:STRIPE_WEBHOOK] done');
    });

    it('does not match short sk_live_ prefixes', () => {
      const input = 'sk_live_short';
      expect(redactSecrets(input)).toBe('sk_live_short');
    });

    it('does not match sk_test_ keys (only sk_live_ is in the registry)', () => {
      const input = `sk_test_${'a'.repeat(24)}`;
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('GCP API keys', () => {
    it('redacts AIza-prefixed keys (exactly 35-char body)', () => {
      const input = `gcp=AIza${'a'.repeat(35)} done`;
      expect(redactSecrets(input)).toBe('gcp=[REDACTED:GCP_API_KEY] done');
    });

    it('does not match wrong-length AIza prefixes', () => {
      // 34-char body is one short of the documented 35.
      const input = `AIza${'a'.repeat(34)}`;
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('SendGrid keys', () => {
    it('redacts three-segment SG. keys (22.43)', () => {
      const input = `sg=SG.${'a'.repeat(22)}.${'b'.repeat(43)} done`;
      expect(redactSecrets(input)).toBe('sg=[REDACTED:SENDGRID] done');
    });

    it('does not match wrong-segment-length SG. tokens with the SENDGRID marker', () => {
      // 21/43 — first segment is 1 short of the documented 22, so the
      // SENDGRID pattern should NOT match. The 43-char trailing segment
      // is still ≥ 40 chars so the HIGH-ENTROPY catch-all may redact it
      // (defense in depth — that's a feature, not a bug); we just assert
      // the SENDGRID-specific marker is absent.
      const input = `SG.${'a'.repeat(21)}.${'b'.repeat(43)}`;
      const out = redactSecrets(input);
      expect(out).not.toContain('[REDACTED:SENDGRID]');
      expect(out.startsWith(`SG.${'a'.repeat(21)}.`)).toBe(true);
    });
  });

  describe('Twilio account SIDs', () => {
    it('redacts AC + 32 hex chars', () => {
      const input = `twilio=AC${'a'.repeat(32)} done`;
      expect(redactSecrets(input)).toBe('twilio=[REDACTED:TWILIO_SID] done');
    });

    it('does not match AC + non-hex chars', () => {
      // Uppercase letters are NOT in the [a-f0-9] hex class.
      const input = `AC${'A'.repeat(32)}`;
      expect(redactSecrets(input)).toBe(input);
    });

    it('does not match AC + wrong-length hex', () => {
      // 31 hex chars is one short of the documented 32.
      const input = `AC${'a'.repeat(31)}`;
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('Mailgun keys', () => {
    it('redacts key- + 32 hex chars', () => {
      const input = `mg=key-${'a'.repeat(32)} done`;
      expect(redactSecrets(input)).toBe('mg=[REDACTED:MAILGUN] done');
    });

    it('does not match key- + wrong-length hex', () => {
      const input = `key-${'a'.repeat(31)}`;
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

  describe('idempotency — markers must not re-match on a second pass', () => {
    // One real-shaped fake token per registered pattern. The expected
    // output of `redactSecrets(input)` is the marker; the property under
    // test is `redactSecrets(redactSecrets(input)) === redactSecrets(input)`.
    // If a marker like `[REDACTED:ANTHROPIC]` accidentally matched any
    // pattern, the second pass would mutate it.
    const fixtures: Array<{ name: string; input: string }> = [
      { name: 'ANTHROPIC', input: `sk-ant-api03-${'a'.repeat(20)}` },
      { name: 'OPENAI_PROJECT', input: `sk-proj-${'a'.repeat(20)}` },
      { name: 'OPENAI', input: `sk-${'a'.repeat(20)}` },
      {
        name: 'SLACK',
        input: `xo${'xb'}-${'A'.repeat(12)}-${'B'.repeat(12)}-${'c'.repeat(24)}`,
      },
      { name: 'STRIPE_LIVE_SECRET', input: `sk_live_${'a'.repeat(24)}` },
      { name: 'STRIPE_LIVE_PUBLISHABLE', input: `pk_live_${'a'.repeat(24)}` },
      { name: 'STRIPE_WEBHOOK', input: `whsec_${'a'.repeat(24)}` },
      { name: 'GCP_API_KEY', input: `AIza${'a'.repeat(35)}` },
      { name: 'SENDGRID', input: `SG.${'a'.repeat(22)}.${'b'.repeat(43)}` },
      { name: 'TWILIO_SID', input: `AC${'a'.repeat(32)}` },
      { name: 'MAILGUN', input: `key-${'a'.repeat(32)}` },
      { name: 'GITHUB_PAT_FINE', input: `github_pat_${'A'.repeat(82)}` },
      { name: 'GITHUB_PAT', input: `ghp_${'a'.repeat(36)}` },
      { name: 'AWS_ACCESS_KEY', input: 'AKIAIOSFODNN7EXAMPLE' },
      {
        name: 'JWT',
        input: `eyJ${'a'.repeat(15)}.eyJ${'b'.repeat(15)}.${'c'.repeat(15)}`,
      },
      { name: 'HIGH-ENTROPY', input: `${'a'.repeat(50)}` },
    ];

    for (const fx of fixtures) {
      it(`is idempotent for ${fx.name}`, () => {
        const once = redactSecrets(fx.input);
        const twice = redactSecrets(once);
        expect(twice).toBe(once);
        // Defense in depth: confirm the once-redacted output actually
        // changed (otherwise idempotency is vacuously true on a no-op).
        expect(once).not.toBe(fx.input);
        expect(once).toContain(`[REDACTED:${fx.name}]`);
      });
    }
  });
});
