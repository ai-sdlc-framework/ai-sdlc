import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCodeScanningAlerts,
  parseDependabotAlerts,
  dedupeAlerts,
  assignIds,
  renderTask,
  taskFileName,
  plan,
  listOpenAlerts,
  alertMarker,
} from './security-findings-to-tasks.mjs';

test('parses code scanning alerts into codeql and scorecard sources', () => {
  const out = parseCodeScanningAlerts([
    {
      number: 1,
      tool: { name: 'CodeQL' },
      rule: { security_severity_level: 'high', description: 'xss' },
      html_url: 'u1',
    },
    {
      number: 2,
      tool: { name: 'Scorecard' },
      rule: { id: 'Pinned-Dependencies', severity: 'warning' },
      html_url: 'u2',
    },
  ]);
  assert.deepEqual(
    out.map((a) => [a.source, a.number, a.severity]),
    [
      ['codeql', 1, 'high'],
      ['scorecard', 2, 'warning'],
    ],
  );
  assert.deepEqual(parseCodeScanningAlerts(null), []);
});

test('parses dependabot alerts', () => {
  const [a] = parseDependabotAlerts([
    {
      number: 94,
      security_advisory: { severity: 'moderate', summary: 'bad' },
      dependency: { package: { name: 'foo' } },
      html_url: 'u',
    },
  ]);
  assert.equal(a.source, 'dependabot');
  assert.equal(a.severity, 'moderate');
  assert.match(a.summary, /foo: bad/);
});

test('dedupes against open and completed tasks and assigns ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog/completed'), { recursive: true });
  writeFileSync(join(root, 'backlog/tasks/aisdlc-5 - a.md'), `x ${alertMarker('dependabot', 94)}`);
  writeFileSync(join(root, 'backlog/completed/aisdlc-9 - b.md'), `x ${alertMarker('codeql', 1)}`);
  const alerts = [
    { source: 'dependabot', number: 94, severity: 'moderate', summary: 's', url: '' },
    { source: 'codeql', number: 1, severity: 'high', summary: 's', url: '' },
    { source: 'codeql', number: 2, severity: 'high', summary: 's', url: '' },
  ];
  const planned = plan(alerts, root);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].taskId, 'AISDLC-10');
  assert.equal(dedupeAlerts(alerts, '').length, 3);
  assert.equal(assignIds(alerts, 0)[2].taskId, 'AISDLC-3');
});

test('renders task body with label, source, number, severity, URL', () => {
  const a = {
    source: 'dependabot',
    number: 94,
    severity: 'moderate',
    summary: "it's é",
    url: 'https://x/94',
    taskId: 'AISDLC-7',
  };
  const t = renderTask(a, '2026-10-27');
  assert.match(t, /- security-finding/);
  assert.match(t, /Alert number: 94/);
  assert.match(t, /Severity: moderate/);
  assert.match(t, /URL: https:\/\/x\/94/);
  assert.match(t, /security-alert:dependabot:94/);
  assert.match(t, /priority: medium/);
  assert.match(taskFileName(a), /^aisdlc-7 - dependabot-94-it-s/);
  assert.match(renderTask({ ...a, severity: 'weird' }, 'd'), /priority: low/);
});

test('listOpenAlerts merges both endpoints', () => {
  const calls = [];
  const fake = (args) => {
    calls.push(args[3]);
    return args[3].includes('code-scanning')
      ? [[{ number: 1, tool: { name: 'CodeQL' }, rule: {} }]]
      : [[{ number: 2 }]];
  };
  const out = listOpenAlerts('o/r', fake);
  assert.equal(out.length, 2);
  assert.equal(calls.length, 2);
});
