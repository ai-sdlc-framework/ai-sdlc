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
