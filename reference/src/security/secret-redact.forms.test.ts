import { describe, expect, it } from 'vitest';
import { redactSecrets } from './secret-redact.js';

// Fixtures only ever contain fake secrets (AISDLC-630.3).
const cases: Array<[string, string, string]> = [
  // 1. colon forms
  ['yaml colon', 'POSTGRES_PASSWORD: hunter2', 'POSTGRES_PASSWORD: [REDACTED:COLON_SECRET]'],
  [
    'json colon',
    '{"password":"hunter2","user":"bob"}',
    '{"password":"[REDACTED:COLON_SECRET]","user":"bob"}',
  ],
  ['json spaced', '{"db_token": "abc def"}', '{"db_token": "[REDACTED:COLON_SECRET]"}'],
  // 2. headers
  ['bearer', 'Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [REDACTED:AUTH_HEADER]'],
  [
    'basic',
    'curl -H "Authorization: Basic dXNlcjpwdw==" x',
    'curl -H "Authorization: Basic [REDACTED:AUTH_HEADER]" x',
  ],
  ['x-api-key', 'X-Api-Key: abc123', 'X-Api-Key: [REDACTED:COLON_SECRET]'],
  [
    'cookie',
    'Cookie: theme=dark; sessionid=abc123; lang=en',
    'Cookie: theme=dark; sessionid=[REDACTED:COOKIE]; lang=en',
  ],
  // 3. flags
  [
    '--password x',
    'mytool --password hunter2 --verbose',
    'mytool --password [REDACTED:FLAG_SECRET] --verbose',
  ],
  [
    '--password "x y"',
    'mytool --password "hun ter" go',
    'mytool --password "[REDACTED:FLAG_SECRET]" go',
  ],
  ['--password=x', 'mytool --password=hunter2', 'mytool --password=[REDACTED:ENV_SECRET]'],
  ['mysql -p x', 'mysql -u root -p hunter2 db', 'mysql -u root -p [REDACTED:DB_PASSWORD] db'],
  ['mysql -px', 'mysql -u root -phunter2 db', 'mysql -u root -p[REDACTED:DB_PASSWORD] db'],
  ['curl -u', 'curl -u bob:hunter2 https://h/x', 'curl -u [REDACTED:USER_CREDENTIALS] https://h/x'],
  ['--user', 'tool --user bob:hunter2 go', 'tool --user [REDACTED:USER_CREDENTIALS] go'],
  // 4. APIKEY names
  ['APIKEY=', 'APIKEY=abc123', 'APIKEY=[REDACTED:ENV_SECRET]'],
  ['apiKey=', 'apiKey=abc123', 'apiKey=[REDACTED:ENV_SECRET]'],
  ['api-key=', 'api-key=abc123', 'api-key=[REDACTED:ENV_SECRET]'],
  ['apiKey colon', '"apiKey": "abc123"', '"apiKey": "[REDACTED:COLON_SECRET]"'],
  ['--api-key x', 'tool --api-key abc123', 'tool --api-key [REDACTED:FLAG_SECRET]'],
  // 5. URL credentials
  [
    'url raw slash',
    'https://bob:pa/ss@host.example/p',
    'https://bob:[REDACTED:URL_PASSWORD]@host.example/p',
  ],
  [
    'url raw hash',
    'postgres://bob:pa#ss@host:5432/db',
    'postgres://bob:[REDACTED:URL_PASSWORD]@host:5432/db',
  ],
  ['url raw query', 'https://bob:p?ss@host', 'https://bob:[REDACTED:URL_PASSWORD]@host'],
  ['url @ in user', 'https://us@er:hunter2@host/p', 'https://us@er:[REDACTED:URL_PASSWORD]@host/p'],
  // 6. multi-token values
  ['multi token', 'TOKEN=Bearer abc def\nNEXT=1', 'TOKEN=[REDACTED:ENV_SECRET]\nNEXT=1'],
  ['multi stops at KEY=', 'TOKEN=Bearer abc A=b', 'TOKEN=[REDACTED:ENV_SECRET] A=b'],
];

const negatives: Array<[string, string]> = [
  ['non-secret colon key', 'POSTGRES_USER: bob'],
  ['non-secret json key', '{"username":"bob"}'],
  ['header without credential', 'Accept: application/json'],
  ['authorization without scheme', 'Authorization: none'],
  ['non-auth cookies', 'Cookie: theme=dark; lang=en'],
  ['set-cookie attributes', 'Set-Cookie: theme=dark; Path=/; Secure'],
  ['non-secret flag', 'mytool --passenger x --verbose'],
  ['psql port flag', 'psql -p 5432 db'],
  ['curl user without password', 'curl -u bob https://h/x'],
  ['non-secret key (monkey)', 'MONKEY=abc'],
  ['url without userinfo', 'https://example.com/a@b'],
  ['url with port and @ in path', 'https://host:8080/a@b.example'],
  ['url with query @', 'https://h/?e=a@b'],
  ['multi token non-scheme', 'NAME=a b c'],
];

describe('AISDLC-630.3 secret forms', () => {
  it.each(cases)('redacts %s', (_n, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(redactSecrets(expected)).toBe(expected);
  });
  it.each(negatives)('leaves %s unchanged', (_n, input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});
