import { describe, it, expect } from 'vitest';
import { redactJsonValue } from './redact-json.js';

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('redactJsonValue (secret shapes)', () => {
  it('redacts nested values of all three shapes plus key-adjacent AWS secrets', () => {
    const state = {
      title: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
      nested: {
        url: 'https://alice:hunter2@example.com/r.git',
        list: ['export DB_PASSWORD="a b c"', { note: 'KEY=value stays' }],
      },
      aws_secret_access_key: AWS_SECRET,
      other: { commit: 'a'.repeat(20) + '1'.repeat(20), n: 3, ok: true, none: null },
    };
    const out = JSON.stringify(redactJsonValue(state));
    expect(out).not.toContain(AWS_SECRET);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('a b c');
    expect(out).toContain('"aws_secret_access_key":"[REDACTED:AWS_SECRET_KEY]"');
    expect(out).toContain('KEY=value stays');
    expect(out).toContain('"n":3');
    expect(out).toContain('a'.repeat(20) + '1'.repeat(20));
  });

  it('only treats a secret-named key as AWS-adjacent for 40-char base64 values', () => {
    expect(redactJsonValue({ secret_name: 'prod-db' })).toEqual({ secret_name: 'prod-db' });
    expect(redactJsonValue({ title: AWS_SECRET })).toEqual({ title: AWS_SECRET });
  });

  it('redacts secrets that appear in object keys', () => {
    const out = JSON.stringify(redactJsonValue({ [`TOKEN=abc`]: 'v' }));
    expect(out).toBe('{"TOKEN=[REDACTED:ENV_SECRET]":"v"}');
  });
});

describe('redactJsonValue (ids and secrets in separate values)', () => {
  const ID = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const R = '[REDACTED:AWS_SECRET_KEY]';

  it('redacts a 40-char secret next to an access key id in an array', () => {
    expect(redactJsonValue({ creds: [ID, AWS_SECRET], note: 'ok' })).toEqual({
      creds: ['[REDACTED:AWS_ACCESS_KEY]', R],
      note: 'ok',
    });
  });

  it('redacts a 40-char secret under a sibling key of an access key id', () => {
    expect(redactJsonValue({ accessKeyId: ID, key: AWS_SECRET, region: 'x' })).toEqual({
      accessKeyId: '[REDACTED:AWS_ACCESS_KEY]',
      key: R,
      region: 'x',
    });
  });

  it('redacts array elements under a secret-named key', () => {
    expect(redactJsonValue({ secrets: [AWS_SECRET, 'prod-db'], other: 1 })).toEqual({
      secrets: [R, 'prod-db'],
      other: 1,
    });
  });

  it('keeps 40-hex SHAs and id-less 40-char tokens unchanged', () => {
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    expect(redactJsonValue({ secret_commit: sha, secrets: [sha] })).toEqual({
      secret_commit: sha,
      secrets: [sha],
    });
    expect(redactJsonValue({ key: AWS_SECRET, list: [AWS_SECRET] })).toEqual({
      key: AWS_SECRET,
      list: [AWS_SECRET],
    });
    expect(redactJsonValue({ accessKeyId: ID, key: sha })).toEqual({
      accessKeyId: '[REDACTED:AWS_ACCESS_KEY]',
      key: sha,
    });
  });
});
