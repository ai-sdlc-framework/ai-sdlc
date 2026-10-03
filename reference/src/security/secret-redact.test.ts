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

describe('AWS secret access keys: realistic layouts', () => {
  const R = '[REDACTED:AWS_SECRET_KEY]';
  const cases: Array<[string, string, string]> = [
    [
      'IAM console label',
      `Secret Access Key: ${AWS_SECRET} (copy now)`,
      `Secret Access Key: ${R} (copy now)`,
    ],
    [
      'aws configure transcript',
      `AWS Secret Access Key [None]: ${AWS_SECRET}\nDefault region`,
      `AWS Secret Access Key [None]: ${R}\nDefault region`,
    ],
    [
      'aws configure set (whitespace separator)',
      `aws configure set aws_secret_access_key ${AWS_SECRET} --profile x`,
      `aws configure set aws_secret_access_key ${R} --profile x`,
    ],
    [
      'backtick-quoted value',
      `secret_access_key: \`${AWS_SECRET}\` ok`,
      `secret_access_key: \`${R}\` ok`,
    ],
    [
      'STS XML',
      `<SecretAccessKey>${AWS_SECRET}</SecretAccessKey><Expiration>x</Expiration>`,
      `<SecretAccessKey>${R}</SecretAccessKey><Expiration>x</Expiration>`,
    ],
    [
      'Hadoop name/value XML',
      `<name>fs.s3a.secret.key</name><value>${AWS_SECRET}</value>`,
      `<name>fs.s3a.secret.key</name><value>${R}</value>`,
    ],
    ['dotted fs.s3a.secret.key', `fs.s3a.secret.key=${AWS_SECRET}`, `fs.s3a.secret.key=${R}`],
    ['dotted aws.secret.key', `aws.secret.key=${AWS_SECRET}`, `aws.secret.key=${R}`],
    ['Go short declaration', `awsSecret := "${AWS_SECRET}"`, `awsSecret := "${R}"`],
    ['PHP/Ruby hash rocket', `'secret' => '${AWS_SECRET}',`, `'secret' => '${R}',`],
    [
      'markdown table with backticks',
      `| \`${ID}\` | \`${AWS_SECRET}\` |`,
      `| \`[REDACTED:AWS_ACCESS_KEY]\` | \`${R}\` |`,
    ],
    ['id=value', `${ID}=${AWS_SECRET} tail`, `[REDACTED:AWS_ACCESS_KEY]=${R} tail`],
    ['value=id', `${AWS_SECRET}=${ID}`, `${R}=[REDACTED:AWS_ACCESS_KEY]`],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts: ${name}`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  it('still leaves a bare 40-char token and a SHA after a secret word unchanged', () => {
    expect(redactSecrets(`token ${AWS_SECRET} here`)).toBe(`token ${AWS_SECRET} here`);
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    expect(redactSecrets(`fix secret leak in commit ${sha}`)).toBe(
      `fix secret leak in commit ${sha}`,
    );
    expect(redactSecrets(`name=${AWS_SECRET}`)).toBe(`name=${AWS_SECRET}`);
  });

  it('does not redact a 41-char or longer base64 run after a secret name', () => {
    expect(redactSecrets(`Secret Access Key: ${AWS_SECRET}A`)).toBe(
      `Secret Access Key: ${AWS_SECRET}A`,
    );
    expect(redactSecrets(`<SecretAccessKey>${AWS_SECRET}Z</SecretAccessKey>`)).toBe(
      `<SecretAccessKey>${AWS_SECRET}Z</SecretAccessKey>`,
    );
  });
});

describe('.env-style assignments: PASS, PWD and dashed names', () => {
  it('redacts PASS / PWD names (value only)', () => {
    for (const name of ['DB_PASS', 'MAIL_PASS', 'MYSQL_PWD', 'PASS', 'pwd']) {
      expect(redactSecrets(`${name}=hunter2`)).toBe(`${name}=[REDACTED:ENV_SECRET]`);
    }
  });

  it('leaves PASSENGER / BYPASS / COMPASS style words unchanged', () => {
    for (const t of [
      'PASSENGER=3',
      'PASSENGER_COUNT=3',
      'BYPASS=1',
      'COMPASS=north',
      'PASSTHROUGH=1',
      'PWDX=1',
      'bypass_cache=1',
    ]) {
      expect(redactSecrets(t)).toBe(t);
    }
  });

  it('redacts secret-key=x and --secret-key=x (value only)', () => {
    expect(redactSecrets('secret-key=abc')).toBe('secret-key=[REDACTED:ENV_SECRET]');
    expect(redactSecrets('run --secret-key=abc now')).toBe(
      'run --secret-key=[REDACTED:ENV_SECRET] now',
    );
    expect(redactSecrets('app.secret.token=abc')).toBe('app.secret.token=[REDACTED:ENV_SECRET]');
  });
});

/**
 * Growth-ratio probe for ReDoS checks: times `run(n)` and `run(4n)`, each as the
 * minimum over `reps` runs (the minimum discards GC pauses and CPU contention, so
 * the check holds under coverage and under load), and returns t(4n) / t(n).
 * Work linear in the input gives about 4, quadratic work about 16. The result is
 * a ratio, so it does not depend on machine speed or on coverage instrumentation.
 */
function growthRatio(run: (n: number) => void, n: number, reps = 3): number {
  const best = (size: number): number => {
    let min = Infinity;
    for (let i = 0; i < reps; i++) {
      const start = performance.now();
      run(size);
      min = Math.min(min, performance.now() - start);
    }
    return min;
  };
  run(n); // warm-up: compile the regexes before measuring
  return best(4 * n) / best(n);
}

/** Midway (geometrically) between linear (~4) and quadratic (~16) growth for a 4x input. */
const LINEAR_GROWTH_LIMIT = 8;

describe('ReDoS: changed regexes stay linear on adversarial input', () => {
  it('flags a known-quadratic pattern (the growth-ratio check can fail)', () => {
    // /\s+$/ on a whitespace run that is not at the end restarts at every position.
    const quadratic = (n: number): void => {
      /\s+$/.test(' '.repeat(n) + 'x');
    };
    expect(growthRatio(quadratic, 3_000)).toBeGreaterThan(LINEAR_GROWTH_LIMIT);
  });

  // Formerly: 'handles 200k-char secret/whitespace/bracket/backtick runs' (absolute 5000 ms bound).
  it('grows linearly on secret/whitespace/bracket/backtick runs', { timeout: 60_000 }, () => {
    const run = (n: number): void => {
      const inputs = [
        'secret'.repeat(n / 6),
        'secret '.repeat(n / 7),
        'secret_' + ' '.repeat(n),
        'secret' + '['.repeat(n),
        'secret' + '`'.repeat(n),
        'secret:' + '`'.repeat(n),
        'secret</a>' + ' '.repeat(n),
        'secret</a><b>'.repeat(n / 13),
        'secret ' + 'A'.repeat(n),
        AKIA_RUN(n),
        'PASS'.repeat(n / 4),
        'PASS_' + '-'.repeat(n),
        'secret-'.repeat(n / 7),
        '--secret-key='.repeat(n / 13),
      ];
      for (const i of inputs) redactSecrets(i);
    };
    expect(growthRatio(run, 12_500)).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});

function AKIA_RUN(n: number): string {
  return ('AKIA' + 'A'.repeat(16) + '=').repeat(n / 21);
}

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

  // Formerly: 'stays fast on long adversarial inputs (no catastrophic backtracking)' (absolute 5000 ms bound).
  it(
    'grows linearly on long adversarial inputs (no catastrophic backtracking)',
    { timeout: 60_000 },
    () => {
      const run = (n: number): void => {
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
        for (const i of inputs) redactSecrets(i);
      };
      expect(growthRatio(run, 12_500)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    },
  );
});

describe('AWS secret access keys: masked prompts, multi-line and structured layouts', () => {
  const R = '[REDACTED:AWS_SECRET_KEY]';
  const A = '[REDACTED:AWS_ACCESS_KEY]';
  const cases: Array<[string, string, string]> = [
    [
      'masked aws configure re-run prompt',
      `AWS Access Key ID [****************MPLE]: ${ID}\nAWS Secret Access Key [****************EKEY]: ${AWS_SECRET}\nDefault region name [None]:`,
      `AWS Access Key ID [****************MPLE]: ${A}\nAWS Secret Access Key [****************EKEY]: ${R}\nDefault region name [None]:`,
    ],
    [
      'IAM console copy, label and value on separate lines',
      `Access key\n${ID}\nSecret access key\n${AWS_SECRET}\nDone`,
      `Access key\n${A}\nSecret access key\n${R}\nDone`,
    ],
    [
      'IAM console copy with CRLF',
      `Secret access key\r\n${AWS_SECRET}\r\nDone`,
      `Secret access key\r\n${R}\r\nDone`,
    ],
    [
      'shell paste of aws configure get',
      `$ aws configure get aws_secret_access_key\n${AWS_SECRET}\n$ echo ok`,
      `$ aws configure get aws_secret_access_key\n${R}\n$ echo ok`,
    ],
    [
      'YAML key with the value on the next line',
      `creds:\n  SecretAccessKey:\n    ${AWS_SECRET}\n  region: x`,
      `creds:\n  SecretAccessKey:\n    ${R}\n  region: x`,
    ],
    [
      'env assignment with the value on the next line',
      `aws_secret_access_key =\n${AWS_SECRET}\nnext`,
      `aws_secret_access_key =\n${R}\nnext`,
    ],
    [
      'create-access-key text row (id, timestamp, secret)',
      `ACCESSKEY\t${ID}\t2026-10-01T12:00:00+00:00\t${AWS_SECRET}\tActive\tbob`,
      `ACCESSKEY\t${A}\t2026-10-01T12:00:00+00:00\t${R}\tActive\tbob`,
    ],
    [
      'assume-role text row (id, Z timestamp, secret)',
      `CREDENTIALS\tASIA${'B'.repeat(16)}\t2026-10-01T12:00:00Z\t${AWS_SECRET}\tFwoGZXIvYXdz`,
      `CREDENTIALS\t${A}\t2026-10-01T12:00:00Z\t${R}\tFwoGZXIvYXdz`,
    ],
    [
      'padded markdown table',
      `| ${ID}${' '.repeat(12)} | ${AWS_SECRET} |`,
      `| ${A}${' '.repeat(12)} | ${R} |`,
    ],
    [
      'padded markdown table, secret first',
      `| ${AWS_SECRET}${' '.repeat(12)} | ${ID} |`,
      `| ${R}${' '.repeat(12)} | ${A} |`,
    ],
    [
      'JSON embedded in a JSON string',
      '{\\"msg\\":\\"{\\\\\\"SecretAccessKey\\\\\\":\\\\\\"' + AWS_SECRET + '\\\\\\"}\\"}',
      '{\\"msg\\":\\"{\\\\\\"SecretAccessKey\\\\\\":\\\\\\"' + R + '\\\\\\"}\\"}',
    ],
    [
      'single-level escaped JSON',
      `x={\\"SecretAccessKey\\":\\"${AWS_SECRET}\\"} y`,
      `x={\\"SecretAccessKey\\":\\"${R}\\"} y`,
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts: ${name}`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  it('keeps the [None] prompt form working with surrounding text intact', () => {
    expect(redactSecrets(`AWS Secret Access Key [None]: ${AWS_SECRET}\nnext`)).toBe(
      `AWS Secret Access Key [None]: ${R}\nnext`,
    );
  });

  it('does not over-match a line ending in secret followed by a SHA or prose', () => {
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    const upperSha = sha.toUpperCase();
    for (const t of [
      `rotate the secret\n${sha}\nnext`,
      `rotate the secret\r\n${upperSha}\r\nnext`,
      `rotate the secret\n  ${sha} merged`,
      'rotate the secret\nthen restart the service and check the logs',
      `rotate the secret\n\n${AWS_SECRET}`,
      `Secret access key:\n\n${AWS_SECRET}`,
      `secret\n${AWS_SECRET}A`,
    ]) {
      expect(redactSecrets(t)).toBe(t);
    }
  });

  it('keeps a bare id-less 40-char token after a non-secret line unchanged', () => {
    expect(redactSecrets(`Access key\n${AWS_SECRET}\nSecret`)).toBe(
      `Access key\n${AWS_SECRET}\nSecret`,
    );
  });
});

describe('idempotence over markers that contain SECRET', () => {
  it('does not treat our own markers as a secret label on a second pass', () => {
    const X = AWS_SECRET;
    const inputs = [
      `TOKEN=abc ${X}`,
      `sk_live_${'a'.repeat(24)} ${X}`,
      `aws_secret_access_key=${X} ${X}`,
      `PASSWORD=x\n${X}`,
    ];
    for (const i of inputs) {
      const once = redactSecrets(i);
      expect(redactSecrets(once)).toBe(once);
    }
    expect(redactSecrets(`TOKEN=abc ${AWS_SECRET} tail`)).toBe(
      `TOKEN=[REDACTED:ENV_SECRET] ${AWS_SECRET} tail`,
    );
    expect(redactSecrets(`TOKEN=[REDACTED:ENV_SECRET] ${AWS_SECRET} tail`)).toBe(
      `TOKEN=[REDACTED:ENV_SECRET] ${AWS_SECRET} tail`,
    );
  });
});

describe('.env-style assignments: dotted and long name tails', () => {
  it('redacts names whose tail needs the dot or is long', () => {
    expect(redactSecrets('secret.key=abc rest')).toBe('secret.key=[REDACTED:ENV_SECRET] rest');
    expect(redactSecrets('my.secret.value=abc rest')).toBe(
      'my.secret.value=[REDACTED:ENV_SECRET] rest',
    );
    expect(redactSecrets('SECRET_ACCESS_KEY_FOR_PROD_ENV=x rest')).toBe(
      'SECRET_ACCESS_KEY_FOR_PROD_ENV=[REDACTED:ENV_SECRET] rest',
    );
  });
});

describe('ReDoS: round 3 regexes stay linear on adversarial input', () => {
  // Formerly: 'handles 200k-char newline, bracket, star, backslash and timestamp runs' (absolute 5000 ms bound).
  it(
    'grows linearly on newline, bracket, star, backslash and timestamp runs',
    { timeout: 60_000 },
    () => {
      const run = (n: number): void => {
        const TS = '2026-10-01T12:00:00+00:00';
        const inputs = [
          'secret' + '\n '.repeat(n / 2),
          'secret\r\n'.repeat(n / 8),
          'secret:' + '\n '.repeat(n / 2),
          'secret ' + '\n'.repeat(n),
          'secret[' + ']'.repeat(n),
          'secret' + '['.repeat(n),
          'secret' + '*'.repeat(n),
          'secret [' + '*'.repeat(n) + ']: ',
          'secret' + '\\'.repeat(n),
          'secret\\"'.repeat(n / 8),
          '[REDACTED:' + 'A_'.repeat(n / 2) + 'secret',
          '[REDACTED:ENV_SECRET]'.repeat(n / 21),
          ('AKIA' + 'A'.repeat(16) + ' ' + TS + ' ').repeat(n / 46),
          'AKIA' + 'A'.repeat(16) + ' '.repeat(n),
          'AKIA' + 'A'.repeat(16) + ' ' + TS + ' '.repeat(n),
          'A'.repeat(40) + ' '.repeat(n) + 'AKIA' + 'A'.repeat(16),
          ('A'.repeat(40) + ' ').repeat(n / 41),
        ];
        for (const i of inputs) redactSecrets(i);
      };
      expect(growthRatio(run, 12_500)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    },
  );
});
