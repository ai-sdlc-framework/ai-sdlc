import { describe, it, expect } from 'vitest';
import { redactSecrets } from './secret-redact.js';

/**
 * Rule-order independence. A rule whose match context an earlier rule can
 * rewrite into a `[REDACTED:...]` marker (URL user, env-name tail, label tail,
 * AWS id adjacency) must still redact its own secret. The generated suite below
 * combines every marker-producing "earlier" shape with every "later" shape, so
 * the next variant is caught here rather than in review.
 */

const hex = (n: number, seed: string): string => {
  let out = '';
  let i = 0;
  while (out.length < n) out += '0123456789abcdef'[(seed.charCodeAt(i++ % seed.length) + i) % 16];
  return out;
};

// "Earlier" shapes: each is replaced by a marker before the later rules run.
const EARLIER: Record<string, string> = {
  akia: 'AKIAIOSFODNN7EXAMPLE',
  asia: 'ASIAIOSFODNN7EXAMPLE',
  twilioSid: 'AC' + hex(32, 'sid'),
  ghp: 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5',
  stripe: 'sk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7',
  anthropic: 'sk-ant-api03-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ',
  openai: 'sk-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ',
  slack: 'xoxb-' + '1234567890-aB3dE5gH7jK9',
  mailgun: 'key-' + hex(32, 'mg'),
};

const AWS40 = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AWS40_ENC = 'wJalrXUtnFEMI%2FK7MDENG%2FbPxRfiCYEXAMPLEKEY';
const TWILIO_TOKEN = hex(32, 'tok');

// "Later" secrets with a distinctive substring that must never survive.
const PASSWORDS: Array<{ value: string; leak: string }> = [
  { value: 'hunter2-Zq9xLmN', leak: 'hunter2-Zq9xLmN' },
  { value: AWS40_ENC, leak: 'K7MDENG' },
  { value: AWS40, leak: 'K7MDENG' },
  { value: TWILIO_TOKEN, leak: TWILIO_TOKEN },
  { value: 'p%40ss%3Aw0rd%2Fenc', leak: 'w0rd' },
];

interface Case {
  name: string;
  input: string;
  leak: string;
}

function generate(): Case[] {
  const cases: Case[] = [];
  const add = (name: string, input: string, leak: string) => cases.push({ name, input, leak });
  for (const [en, e] of Object.entries(EARLIER)) {
    for (const scheme of ['https', 's3a', 'postgres']) {
      for (const [i, p] of PASSWORDS.entries()) {
        // A raw `/` ends a URL password (documented residual gap); the raw AWS
        // secret is still caught when an access key id anchors it (rule (b)).
        if (p.value === AWS40 && en !== 'akia' && en !== 'asia') continue;
        add(
          `url ${scheme} ${en} user pw#${i}`,
          `${scheme}://${e}:${p.value}@host.example/p`,
          p.leak,
        );
        add(`url ${en} user pw#${i} in prose`, `clone ${scheme}://${e}:${p.value}@h/x now`, p.leak);
      }
    }
    // env assignment: marker in the name tail, as the value prefix, as a neighbour
    for (const kw of ['SECRET', 'TOKEN', 'PASSWORD', 'API_KEY']) {
      add(`env ${kw}_${en} name`, `${kw}_${e}=tailvalue9Zx`, 'tailvalue9Zx');
      add(`env ${kw} value prefix ${en}`, `${kw}=${e}-tailvalue9Zx`, 'tailvalue9Zx');
      add(`env ${kw} neighbour ${en}`, `${e} ${kw}=tailvalue9Zx`, 'tailvalue9Zx');
      add(`env ${kw} quoted ${en}`, `${kw}_${e}="tail value9Zx"`, 'value9Zx');
      add(`env ${kw} unterminated dq ${en}`, `${kw}="${e}-tailvalue9Zx more`, 'tailvalue9Zx');
      add(`env ${kw} unterminated sq ${en}`, `${kw}='${e}-tailvalue9Zx`, 'tailvalue9Zx');
    }
    // AWS 40-char secret: label forms with an earlier shape in the label tail
    const labels = [
      'aws_secret_access_key = ',
      'SecretAccessKey: ',
      'Secret Access Key\n  ',
      '||  SecretAccessKey |  ',
      '| Secret Access Key | ',
      `secret ${e} = `,
      `secret_${e}: `,
    ];
    for (const l of labels) {
      for (const [sn, s] of [
        ['raw', AWS40],
        ['pw-lookalike', 'Zq9xLmN2pQ4rS6tU8vW0xY2zA4bC6dE8fG0hJ2kL'],
      ] as const) {
        add(`aws label ${JSON.stringify(l)} ${en} ${sn}`, `${l}${s}`, s.slice(5, 30));
      }
    }
    // AWS id adjacency (only AKIA/ASIA ids anchor rules (b) and (c))
    if (en === 'akia' || en === 'asia') {
      for (const sep of [' ', ': ', '\t', ' | ', ',', '="']) {
        add(`id-first sep ${JSON.stringify(sep)} ${en}`, `${e}${sep}${AWS40}`, 'K7MDENG');
        add(`secret-first sep ${JSON.stringify(sep)} ${en}`, `${AWS40}${sep}${e}`, 'K7MDENG');
        add(`prefixed id-first ${en}`, `${EARLIER.twilioSid} ${e}${sep}${AWS40}`, 'K7MDENG');
      }
      add(`id-first timestamp ${en}`, `${e} 2026-10-01T12:00:00Z ${AWS40}`, 'K7MDENG');
      add(`id in table ${en}`, `| ${e} | ${AWS40} |`, 'K7MDENG');
      add(`id split lines ${en}`, `AccessKeyId: ${e}\nSecretAccessKey:\n  ${AWS40}`, 'K7MDENG');
    }
  }
  return cases;
}

const CASES = generate();

describe('rule-order independence (generated cross-rule combinations)', () => {
  it('generates a meaningful number of cases', () => {
    expect(CASES.length).toBeGreaterThan(400);
  });

  it('never leaks the later secret, whatever earlier rule rewrote the context', () => {
    const failures = CASES.filter((c) => redactSecrets(c.input).includes(c.leak)).map(
      (c) => `${c.name}: ${redactSecrets(c.input)}`,
    );
    expect(failures).toEqual([]);
  });

  it('is idempotent over every generated case', () => {
    const failures = CASES.filter((c) => {
      const once = redactSecrets(c.input);
      return redactSecrets(once) !== once;
    }).map((c) => c.name);
    expect(failures).toEqual([]);
  });
});

describe('rule-order independence: explicit regression fixtures', () => {
  it('redacts a percent-encoded secret after an AWS id user', () => {
    const out = redactSecrets(`s3a://AKIAIOSFODNN7EXAMPLE:${AWS40_ENC}@bucket/p`);
    expect(out).not.toContain('K7MDENG');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('@bucket/p');
  });

  it('redacts a Twilio auth token after a Twilio SID user', () => {
    const sid = EARLIER.twilioSid;
    const out = redactSecrets(`https://${sid}:${TWILIO_TOKEN}@api.twilio.com/2010-04-01/Accounts`);
    expect(out).not.toContain(TWILIO_TOKEN);
    expect(out).not.toContain(sid);
    expect(out).toContain('@api.twilio.com/2010-04-01/Accounts');
  });

  it('keeps redacting a plain user:pass URL and leaves userinfo-free URLs alone', () => {
    expect(redactSecrets('https://user:pass@host')).toBe(
      'https://user:[REDACTED:URL_PASSWORD]@host',
    );
    for (const u of ['https://example.com/a@b', 'https://user@host', 'ssh://git@github.com/x']) {
      expect(redactSecrets(u)).toBe(u);
    }
  });
});

describe('AWS secrets in pipe-separated rows', () => {
  it('redacts the aws --output table row and the markdown key/value table', () => {
    const t1 = redactSecrets(`||  SecretAccessKey |  ${AWS40}   ||`);
    expect(t1).not.toContain('K7MDENG');
    expect(t1).toContain('SecretAccessKey');
    const t2 = redactSecrets(`| Secret Access Key | ${AWS40} |`);
    expect(t2).not.toContain('K7MDENG');
    expect(t2).toContain('| Secret Access Key |');
  });

  it('leaves non-secret rows, 40-hex SHAs and wrong-length values unchanged', () => {
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    for (const row of [
      `| Secret Access Key | ${sha} |`,
      `| Name | ${AWS40} |`,
      `||  AccessKeyId |  note ||`,
      `| Secret | not a key |`,
      `| Secret Access Key | ${AWS40}A |`,
      `| Secret Access Key | ${AWS40.slice(1)} |`,
    ]) {
      expect(redactSecrets(row)).toBe(row);
    }
  });
});

describe('ReDoS: marker-as-context alternations stay linear', () => {
  it('handles 200k-char marker, scheme and @ runs', () => {
    const n = 200_000;
    const M = '[REDACTED:';
    const inputs = [
      M.repeat(n / 10),
      'http://' + M.repeat(n / 10),
      'http://' + '[REDACTED:A]'.repeat(n / 12) + ':',
      'http://' + '[REDACTED:A]'.repeat(n / 12) + ':x@',
      '://'.repeat(n / 3),
      'a://'.repeat(n / 4),
      'a://u:'.repeat(n / 6),
      'a://u:x@'.repeat(n / 8),
      '@'.repeat(n),
      'a://' + '@'.repeat(n),
      'a://u:' + '@'.repeat(n),
      'TOKEN' + M.repeat(n / 10),
      'TOKEN_' + '[REDACTED:A]'.repeat(n / 12) + '=x',
      ('TOKEN=' + M).repeat(n / 16),
      'secret ' + '[REDACTED:A]'.repeat(n / 12),
      'secret|' + '|'.repeat(n),
      'secret' + ' |'.repeat(n / 2),
      ('|  SecretAccessKey |' + ' '.repeat(30)).repeat(n / 50),
    ];
    const start = Date.now();
    for (const i of inputs) redactSecrets(i);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
