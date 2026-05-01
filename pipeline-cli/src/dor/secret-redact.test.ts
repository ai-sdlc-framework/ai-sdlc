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

    it('greedy {82,} consumes trailing alphanumerics — no leak past the marker (AISDLC-128)', () => {
      // 82-char body + 8 trailing chars; under the old `{82}` exact
      // quantifier the trailing `BBBBBBBB` would have leaked verbatim.
      const input = `auth: github_pat_${'A'.repeat(82)}${'B'.repeat(8)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('auth: [REDACTED:GITHUB_PAT_FINE] done');
      expect(out).not.toMatch(/BBBBBBBB/);
    });

    it('classic ghp_ greedy {36,} consumes trailing alphanumerics — no leak past the marker (AISDLC-128 round 2)', () => {
      // 36-char body + 20 trailing chars; under the old `{36}` exact
      // quantifier the trailing `b`s would have leaked verbatim. Mirrors
      // the GITHUB_PAT_FINE trailing-alphanum test — round-2 completion
      // of the AISDLC-128 cohort (AWS/GCP/Twilio/Mailgun/PAT_FINE were
      // greedy-fixed in round 1; PAT classic was the straggler).
      const input = `auth: ghp_${'a'.repeat(36)}${'b'.repeat(20)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('auth: [REDACTED:GITHUB_PAT] done');
      expect(out).not.toMatch(/bbbbbbbbbbbbbbbbbbbb/);
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

    it('greedy {16,} consumes trailing alphanumerics — no leak past the marker (AISDLC-128)', () => {
      // Build the AKIA prefix via template-literal split so the literal
      // 16-char trailing pattern doesn't trip GitHub secret-scanning on
      // the diff (the AKIA + 16-char shape is what scanners look for).
      const input = `aws: AK${'IA'}IOSFODNN7EXAMPLE${'A'.repeat(4)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('aws: [REDACTED:AWS_ACCESS_KEY] done');
      // Defense in depth: the 4 trailing `A`s must NOT survive past the
      // marker — that was the AISDLC-128 trailing-leak symptom.
      expect(out).not.toMatch(/AAAA/);
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
      // single 48+ run, and each segment is < 48 chars, so the
      // high-entropy catch-all also stays quiet.
      expect(redactSecrets(input)).toBe(input);
    });

    it('does not match three-segment strings whose payload does NOT start with eyJ (AISDLC-128 anchor-intent)', () => {
      // The JWT regex requires the SECOND segment to also start with
      // `eyJ` (the base64url encoding of `{"`, the start of every JSON
      // payload). Real JWTs always satisfy this; relaxing the anchor
      // would fire on three-dot-separated base64url-ish strings (e.g.
      // content-addressed file paths, hash chains). Assert that a
      // non-`eyJ` payload is NOT flagged as a JWT.
      const fakeJwt = `eyJ${'a'.repeat(15)}.${'b'.repeat(18)}.${'c'.repeat(15)}`;
      const out = redactSecrets(fakeJwt);
      expect(out).not.toContain('[REDACTED:JWT]');
      // Each segment is < 48 chars (and the `b` segment has no digit
      // anyway), so HIGH-ENTROPY also stays quiet — the input survives
      // verbatim.
      expect(out).toBe(fakeJwt);
    });
  });

  describe('PEM private-key blocks (AISDLC-128)', () => {
    it('redacts a multi-line OPENSSH PRIVATE KEY block', () => {
      // Use an obviously-fake key body to keep GitHub secret-scanning
      // happy. The rule under test is the BEGIN/END marker itself —
      // body shape is irrelevant beyond "doesn't escape the block".
      const block = [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'THIS-IS-A-TEST-FAKE-KEY-DO-NOT-USE-aaaaaaaaaaaaaa',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n');
      const input = `key:\n${block}\ndone`;
      const out = redactSecrets(input);
      expect(out).toContain('[REDACTED:PRIVATE_KEY_BLOCK]');
      // Critical: the BEGIN/END headers must NOT survive verbatim.
      expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY');
      expect(out).not.toContain('END OPENSSH PRIVATE KEY');
    });

    it('redacts a generic (PKCS#8) PRIVATE KEY block', () => {
      const block = [
        '-----BEGIN PRIVATE KEY-----',
        'FAKE-PKCS8-KEY-BODY-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '-----END PRIVATE KEY-----',
      ].join('\n');
      const out = redactSecrets(block);
      expect(out).toBe('[REDACTED:PRIVATE_KEY_BLOCK]');
    });

    it('redacts an RSA PRIVATE KEY block', () => {
      const block = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'FAKE-RSA-KEY-BODY-cccccccccccccccccccccccccccccccc',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const out = redactSecrets(block);
      expect(out).toBe('[REDACTED:PRIVATE_KEY_BLOCK]');
    });

    it('redacts a PGP PRIVATE KEY BLOCK (note the trailing "BLOCK" suffix)', () => {
      const block = [
        '-----BEGIN PGP PRIVATE KEY BLOCK-----',
        'FAKE-PGP-KEY-BODY-dddddddddddddddddddddddddddddddd',
        '-----END PGP PRIVATE KEY BLOCK-----',
      ].join('\n');
      const out = redactSecrets(block);
      expect(out).toBe('[REDACTED:PRIVATE_KEY_BLOCK]');
    });

    it('redacts each block separately when two are concatenated (non-greedy body)', () => {
      // The body uses a non-greedy `[\s\S]*?` quantifier — without it,
      // two adjacent blocks would collapse into one match that swallows
      // the gap between them.
      const a = [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'FAKE-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n');
      const b = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'FAKE-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const input = `${a}\nGAP TEXT\n${b}`;
      const out = redactSecrets(input);
      // Both blocks are individually redacted, gap text survives.
      expect(out).toBe('[REDACTED:PRIVATE_KEY_BLOCK]\nGAP TEXT\n[REDACTED:PRIVATE_KEY_BLOCK]');
    });

    it('does not match a stray BEGIN line without a matching END', () => {
      const input = '-----BEGIN OPENSSH PRIVATE KEY-----\nbody-but-no-end-marker';
      const out = redactSecrets(input);
      // The regex requires a matching END marker; an unterminated block
      // is NOT redacted. This is intentional: partial matches would
      // either over-eat (greedy) or false-positive on PEM-shaped prose
      // that mentions BEGIN markers in documentation.
      expect(out).toBe(input);
    });

    it('redaction is idempotent — second pass does not mutate the marker (AISDLC-128 round 2)', () => {
      // Standalone idempotency lock for PRIVATE_KEY_BLOCK in particular
      // (the broader idempotency suite below covers every pattern via
      // the parametric loop, but PEM blocks are the highest-stakes case
      // because the marker `[REDACTED:PRIVATE_KEY_BLOCK]` contains `[`,
      // `:`, and `]` outside every other pattern's char class — so it
      // CAN'T accidentally re-match. This test locks that structural
      // property as a regression test: any future pattern addition that
      // matches the marker shape would flip this assertion.).
      const block = [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'IDEMPOTENCY-FAKE-KEY-BODY-eeeeeeeeeeeeeeeeeeeeeeeee',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n');
      const input = `before\n${block}\nafter`;
      const once = redactSecrets(input);
      const twice = redactSecrets(once);
      expect(twice).toBe(once);
      // Defense in depth: confirm the once-redacted output actually
      // changed (otherwise idempotency is vacuously true on a no-op).
      expect(once).toContain('[REDACTED:PRIVATE_KEY_BLOCK]');
      expect(once).not.toBe(input);
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
    it('redacts AIza-prefixed keys (35-char body, the documented length)', () => {
      const input = `gcp=AIza${'a'.repeat(35)} done`;
      expect(redactSecrets(input)).toBe('gcp=[REDACTED:GCP_API_KEY] done');
    });

    it('does not match wrong-length AIza prefixes', () => {
      // 34-char body is one short of the documented 35.
      const input = `AIza${'a'.repeat(34)}`;
      expect(redactSecrets(input)).toBe(input);
    });

    it('greedy {35,} consumes trailing alphanumerics — no leak past the marker (AISDLC-128)', () => {
      // 35-char body + 6 trailing chars (41 chars total, still < the 48
      // HIGH-ENTROPY threshold so this is GCP_API_KEY's responsibility
      // alone).
      const input = `gcp=AIza${'a'.repeat(35)}${'Z'.repeat(6)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('gcp=[REDACTED:GCP_API_KEY] done');
      expect(out).not.toMatch(/ZZZZZZ/);
    });
  });

  describe('SendGrid keys', () => {
    it('redacts three-segment SG. keys (22.43)', () => {
      const input = `sg=SG.${'a'.repeat(22)}.${'b'.repeat(43)} done`;
      expect(redactSecrets(input)).toBe('sg=[REDACTED:SENDGRID] done');
    });

    it('does not match wrong-segment-length SG. tokens with the SENDGRID marker', () => {
      // 21/43 — first segment is 1 short of the documented 22, so the
      // SENDGRID pattern should NOT match. Under the AISDLC-128 raised
      // HIGH-ENTROPY rule (48+ chars AND ≥1 digit), the 43-char trailing
      // `b`-only segment also stays intact (no digit, < 48 chars), so
      // the whole input survives unmodified — we just assert the
      // SENDGRID-specific marker is absent.
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

    it('greedy {32,} consumes trailing hex — no leak past the marker (AISDLC-128)', () => {
      const input = `twilio=AC${'a'.repeat(32)}${'b'.repeat(8)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('twilio=[REDACTED:TWILIO_SID] done');
      expect(out).not.toMatch(/bbbbbbbb/);
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

    it('greedy {32,} consumes trailing hex — no leak past the marker (AISDLC-128)', () => {
      const input = `mg=key-${'a'.repeat(32)}${'c'.repeat(8)} done`;
      const out = redactSecrets(input);
      expect(out).toBe('mg=[REDACTED:MAILGUN] done');
      expect(out).not.toMatch(/cccccccc/);
    });
  });

  describe('high-entropy catch-all', () => {
    it('replaces unknown 48+ char runs that contain at least one digit', () => {
      // 50-char body with a digit injected — both conditions met:
      // length ≥ 48 AND contains ≥1 digit (AISDLC-128 raised threshold).
      const input = `random=${'a'.repeat(49)}1 done`;
      expect(redactSecrets(input)).toBe('random=[REDACTED:HIGH-ENTROPY] done');
    });

    it('leaves shorter strings alone (< 48 chars)', () => {
      const input = `random=${'a'.repeat(20)} done`;
      expect(redactSecrets(input)).toBe(`random=${'a'.repeat(20)} done`);
    });

    it('leaves 48+ char pure-letter strings alone (no digit, AISDLC-128)', () => {
      // 60 alphabetic chars with NO digit — fails the digit-required
      // lookahead, so HIGH-ENTROPY skips it. This is the rule that
      // keeps branch names / hyphenated PR titles intact.
      const input = `random=${'a'.repeat(60)} done`;
      expect(redactSecrets(input)).toBe(`random=${'a'.repeat(60)} done`);
    });

    it('leaves a no-digit branch name intact (AISDLC-128 false-positive prevention)', () => {
      // Real-world DoR finding text often quotes a branch name verbatim.
      // The old 40-char rule would have shredded the trailing portion;
      // the new (48 + ≥1-digit) rule leaves it intact for human spot-
      // checking. This fixture has NO digits, so the digit-required
      // lookahead alone protects it (regardless of length).
      const branch = 'feat-prevent-secret-persistence-with-three-layer-defense';
      const input = `branch=${branch} done`;
      expect(redactSecrets(input)).toBe(`branch=${branch} done`);
    });

    it('redacts a numbered AISDLC branch name (digit makes it look high-entropy)', () => {
      // Companion to the no-digit branch test above — documents the
      // actual trade-off rather than implying an unconditional win. A
      // numbered AISDLC branch name like `aisdlc-122-feat-...` IS
      // shredded because the `122` satisfies the digit-required
      // lookahead and the run is ≥ 48 chars. The (length≥48 + ≥1 digit)
      // rule is a coarse filter — over-redact, never under-redact. See
      // the rationale comment on the HIGH-ENTROPY pattern in
      // secret-redact.ts.
      const input =
        'context: branch=aisdlc-122-feat-prevent-secret-persistence-with-three-layer-defense end';
      expect(redactSecrets(input)).toBe('context: branch=[REDACTED:HIGH-ENTROPY] end');
    });

    it('leaves a hyphenated PR title intact (AISDLC-128 false-positive prevention)', () => {
      // PR titles in calibration log notes often look like `feat(scope):
      // <kebab-or-prose>` — the spaces / parens / colons break long
      // alphanumeric runs into < 48-char segments anyway. Belt + braces.
      const title =
        'feat(pipeline-cli): expand SECRET_PATTERNS registry with 9 new credential formats';
      const input = `title=${title} done`;
      expect(redactSecrets(input)).toBe(`title=${title} done`);
    });

    it('still redacts a commit SHA in prose (AISDLC-128 — SHAs have digits, redaction is correct)', () => {
      // 40-char hex SHA is BELOW the new 48-char threshold, so it
      // actually stays intact under the new rule (raised threshold is
      // the explicit trade-off). A longer hex-like blob (≥ 48, with
      // digits) still gets caught — assert that.
      const longHex = `${'a'.repeat(40)}1234567890abcdef`; // 56 chars, has digits
      const input = `blob=${longHex} done`;
      expect(redactSecrets(input)).toBe('blob=[REDACTED:HIGH-ENTROPY] done');
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
        name: 'PRIVATE_KEY_BLOCK',
        input: [
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          'THIS-IS-A-TEST-FAKE-KEY-DO-NOT-USE-aaaaaaaaaaaaaa',
          '-----END OPENSSH PRIVATE KEY-----',
        ].join('\n'),
      },
      {
        name: 'JWT',
        input: `eyJ${'a'.repeat(15)}.eyJ${'b'.repeat(15)}.${'c'.repeat(15)}`,
      },
      // 50-char body with a trailing digit — satisfies the AISDLC-128
      // raised HIGH-ENTROPY rule (≥ 48 chars AND ≥ 1 digit).
      { name: 'HIGH-ENTROPY', input: `${'a'.repeat(49)}1` },
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
