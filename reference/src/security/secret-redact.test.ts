import { describe, it, expect } from 'vitest';
import { redactSecrets, SECRET_PATTERNS } from './secret-redact.js';
import * as barrel from '../index.js';

describe('secret-redact (reference location)', () => {
  it('redacts a known token and passes empty input through', () => {
    expect(redactSecrets(`token ${'sk-' + 'a'.repeat(30)} end`)).toBe(
      'token [REDACTED:OPENAI] end',
    );
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });

  it('is exported from the package barrel', () => {
    expect(barrel.redactSecrets).toBe(redactSecrets);
    expect(barrel.SECRET_PATTERNS).toBe(SECRET_PATTERNS);
  });
});

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; // 40 chars, documented example
const ID = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('AWS secret access keys', () => {
  it('redacts the value after a secret-named key (env, ini, JSON, quoted)', () => {
    expect(redactSecrets(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET} ok`)).toBe(
      'AWS_SECRET_ACCESS_KEY=[REDACTED:AWS_SECRET_KEY] ok',
    );
    expect(redactSecrets(`aws_secret_access_key = ${AWS_SECRET}`)).toBe(
      'aws_secret_access_key = [REDACTED:AWS_SECRET_KEY]',
    );
    expect(redactSecrets(`{"SecretAccessKey": "${AWS_SECRET}", "x": 1}`)).toBe(
      '{"SecretAccessKey": "[REDACTED:AWS_SECRET_KEY]", "x": 1}',
    );
  });

  it('redacts a 40-char token adjacent to an access key id, in either order', () => {
    expect(redactSecrets(`${ID} ${AWS_SECRET}`)).toBe(
      '[REDACTED:AWS_ACCESS_KEY] [REDACTED:AWS_SECRET_KEY]',
    );
    expect(redactSecrets(`${AWS_SECRET},${ID}`)).toBe(
      '[REDACTED:AWS_SECRET_KEY],[REDACTED:AWS_ACCESS_KEY]',
    );
    expect(redactSecrets(`ASIA${'B'.repeat(16)}\n${AWS_SECRET}`)).toBe(
      '[REDACTED:AWS_ACCESS_KEY]\n[REDACTED:AWS_SECRET_KEY]',
    );
  });

  it('leaves look-alikes unchanged', () => {
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    expect(redactSecrets(`commit ${sha} done`)).toBe(`commit ${sha} done`);
    expect(redactSecrets(`see ${AWS_SECRET} in the docs`)).toBe(`see ${AWS_SECRET} in the docs`);
    expect(redactSecrets('secret: abcDEF123/short==')).toBe('secret: abcDEF123/short==');
    expect(redactSecrets(`${ID} ${sha}`)).toBe(`[REDACTED:AWS_ACCESS_KEY] ${sha}`);
    expect(redactSecrets(`${sha} ${ID}`)).toBe(`${sha} [REDACTED:AWS_ACCESS_KEY]`);
  });

  it('does not redact a 41-char value after a secret-named key as an AWS key', () => {
    expect(redactSecrets(`secret_id: ${AWS_SECRET}A`)).toBe(`secret_id: ${AWS_SECRET}A`);
  });
});

describe('URL userinfo credentials', () => {
  it('redacts the password and keeps scheme, user and host', () => {
    expect(redactSecrets('clone https://alice:hunter2@example.com/repo.git now')).toBe(
      'clone https://alice:[REDACTED:URL_PASSWORD]@example.com/repo.git now',
    );
  });

  it('handles percent-encoded passwords and a raw @ inside the password', () => {
    expect(redactSecrets('postgres://bob:p%40ss%2Fw0rd@db:5432/x')).toBe(
      'postgres://bob:[REDACTED:URL_PASSWORD]@db:5432/x',
    );
    expect(redactSecrets('https://bob:p@ss@host/x')).toBe(
      'https://bob:[REDACTED:URL_PASSWORD]@host/x',
    );
  });

  it('redacts a token-shaped user (with or without a password)', () => {
    const tok = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    expect(redactSecrets(`https://${tok}@host/x`)).toBe(
      'https://[REDACTED:URL_CREDENTIALS]@host/x',
    );
    expect(redactSecrets(`https://${tok}:pw@host/x`)).toBe(
      'https://[REDACTED:URL_CREDENTIALS]@host/x',
    );
  });

  it('keeps a plain user without a password (documented decision)', () => {
    expect(redactSecrets('ssh://git@github.com/org/repo')).toBe('ssh://git@github.com/org/repo');
    expect(redactSecrets('https://token@host')).toBe('https://token@host');
  });

  it('handles multiple URLs and IPv6 hosts', () => {
    expect(redactSecrets('a http://u:p1@h1/ b https://v:p2@[::1]:8080/x c')).toBe(
      'a http://u:[REDACTED:URL_PASSWORD]@h1/ b https://v:[REDACTED:URL_PASSWORD]@[::1]:8080/x c',
    );
    expect(redactSecrets('http://[::1]:8080/path')).toBe('http://[::1]:8080/path');
  });

  it('leaves URLs without userinfo unchanged, including @ in path or query', () => {
    for (const u of [
      'https://example.com/a@b',
      'https://example.com/?email=a@b.c',
      'https://example.com:8080/x#a@b',
      'https://example.com',
      'see https://example.com/x and mail me@example.com',
      'https://u:@host/',
    ]) {
      expect(redactSecrets(u)).toBe(u);
    }
  });
});

describe('.env-style assignments', () => {
  it('redacts only the value, for every keyword and case', () => {
    for (const name of [
      'MY_SECRET',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      'ROOT_PASSWD',
      'STRIPE_API_KEY',
      'SSH_PRIVATE_KEY',
      'GCP_CREDENTIAL',
      'authToken',
      'db_password',
    ]) {
      expect(redactSecrets(`${name}=hunter2`)).toBe(`${name}=[REDACTED:ENV_SECRET]`);
    }
  });

  it('handles export, spacing, quotes, comments and multi-line text', () => {
    expect(redactSecrets('export API_TOKEN=abc123 # note')).toBe(
      'export API_TOKEN=[REDACTED:ENV_SECRET] # note',
    );
    expect(redactSecrets('DB_PASSWORD = "two words here"')).toBe(
      'DB_PASSWORD = "[REDACTED:ENV_SECRET]"',
    );
    expect(redactSecrets("X_SECRET='it\\'s'")).toBe("X_SECRET='[REDACTED:ENV_SECRET]'");
    expect(redactSecrets('A=1\nDB_PASSWORD=p1\nB=2\nAPI_KEY=k2 # c\nC=3')).toBe(
      'A=1\nDB_PASSWORD=[REDACTED:ENV_SECRET]\nB=2\nAPI_KEY=[REDACTED:ENV_SECRET] # c\nC=3',
    );
    expect(redactSecrets('TOKEN="unterminated value here\nnext=1')).toBe(
      'TOKEN=[REDACTED:ENV_SECRET]\nnext=1',
    );
  });

  it('keeps a specific-shape marker instead of the generic one', () => {
    expect(redactSecrets(`GH_TOKEN=ghp_${'a'.repeat(36)}`)).toBe('GH_TOKEN=[REDACTED:GITHUB_PAT]');
  });

  it('leaves non-secret names, empty values and comparisons unchanged', () => {
    for (const t of [
      'KEY=value',
      'MONKEY=1',
      'PUBLIC_KEY=abc',
      'SSH_KEY=abc',
      'NAME=value',
      'TOKEN=',
      'TOKEN=   \nnext',
      'PASSWORD=""',
      'if TOKEN == x',
      'the token was rotated',
    ]) {
      expect(redactSecrets(t)).toBe(t);
    }
  });
});

describe('registry hardening', () => {
  it('is idempotent for the new shapes', () => {
    const input = [
      `aws_secret_access_key=${AWS_SECRET}`,
      `${ID} ${AWS_SECRET}`,
      'https://u:p%40x@h/ https://a1b2c3d4e5f6a7b8c9d0e1f2@h/',
      'export DB_PASSWORD="a b" TOKEN=x',
    ].join('\n');
    const once = redactSecrets(input);
    expect(once).not.toContain(AWS_SECRET);
    expect(redactSecrets(once)).toBe(once);
  });

  it('stays fast on long adversarial inputs (no catastrophic backtracking)', () => {
    const n = 200_000;
    const inputs = [
      'secret'.repeat(n / 6),
      'secret_' + ' '.repeat(n),
      'a://'.repeat(n / 4),
      'http://' + 'a'.repeat(n),
      'http://' + 'a:'.repeat(n / 2),
      'TOKEN="' + 'a\\'.repeat(n / 2),
      'TOKEN=' + ' '.repeat(n),
      'TOKEN="x '.repeat(n / 9),
      'AKIA' + 'A'.repeat(n),
      'a'.repeat(n),
    ];
    const start = Date.now();
    for (const i of inputs) redactSecrets(i);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
