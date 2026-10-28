#!/usr/bin/env node
/**
 * AISDLC-940: turn open CodeQL, Dependabot and Scorecard alerts into backlog tasks.
 *
 * Usage:
 *   node scripts/security-findings-to-tasks.mjs --dry-run   # list alerts + the task id each would get
 *   node scripts/security-findings-to-tasks.mjs             # write task files and open one filing PR
 *
 * Idempotent: an alert whose marker (`security-alert:<source>:<number>`) appears in any
 * file under backlog/tasks or backlog/completed is skipped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function alertMarker(source, number) {
  return `security-alert:${source}:${number}`;
}

/** Normalise raw REST payloads into { source, number, severity, summary, url }. */
export function parseCodeScanningAlerts(raw) {
  return (Array.isArray(raw) ? raw : []).map((a) => {
    const tool = String(a?.tool?.name ?? '').toLowerCase();
    const source = tool === 'scorecard' ? 'scorecard' : 'codeql';
    return {
      source,
      number: a.number,
      severity: a?.rule?.security_severity_level ?? a?.rule?.severity ?? 'unknown',
      summary: a?.rule?.description ?? a?.rule?.id ?? 'code scanning alert',
      url: a.html_url ?? '',
    };
  });
}

export function parseDependabotAlerts(raw) {
  return (Array.isArray(raw) ? raw : []).map((a) => ({
    source: 'dependabot',
    number: a.number,
    severity: a?.security_advisory?.severity ?? a?.security_vulnerability?.severity ?? 'unknown',
    summary:
      `${a?.dependency?.package?.name ?? 'dependency'}: ` +
      (a?.security_advisory?.summary ?? 'vulnerable dependency'),
    url: a.html_url ?? '',
  }));
}

export function readExistingText(root) {
  let text = '';
  for (const dir of ['backlog/tasks', 'backlog/completed']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.md')) text += readFileSync(join(abs, f), 'utf8') + '\n';
    }
  }
  return text;
}

export function dedupeAlerts(alerts, existingText) {
  return alerts.filter((a) => !existingText.includes(alertMarker(a.source, a.number)));
}

export function maxTaskNumber(root) {
  let max = 0;
  for (const dir of ['backlog/tasks', 'backlog/completed']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      const m = f.match(/^aisdlc-(\d+)/i);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

export function assignIds(alerts, startAfter) {
  return alerts.map((a, i) => ({ ...a, taskId: `AISDLC-${startAfter + 1 + i}` }));
}

const ASCII = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const PRIORITY = { critical: 'high', high: 'high', moderate: 'medium', medium: 'medium' };
const REFERENCES = {
  codeql: '.github/workflows/codeql.yml',
  scorecard: '.github/workflows/scorecard.yml',
  dependabot: '.github/dependabot.yml',
};

export function slugify(s) {
  return (
    ASCII(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'alert'
  );
}

export function taskFileName(a) {
  return `${a.taskId.toLowerCase()} - ${slugify(`${a.source}-${a.number}-${a.summary}`)}.md`;
}

export function renderTask(a, today) {
  const title = ASCII(
    `Security finding: ${a.source} alert #${a.number} (${a.severity}) ${a.summary}`,
  )
    .replace(/'/g, "''")
    .slice(0, 160);
  const priority = PRIORITY[String(a.severity).toLowerCase()] ?? 'low';
  return `---
id: ${a.taskId}
title: '${title}'
status: To Do
assignee: []
created_date: '${today}'
labels:
  - security-finding
priority: ${priority}
dispatchable: true
dependencies: []
references:
  - ${REFERENCES[a.source]}
---

## Description

Open ${a.source} alert on \`main\`, filed by \`scripts/security-findings-to-tasks.mjs\`.

- Source: ${a.source}
- Alert number: ${a.number}
- Severity: ${a.severity}
- URL: ${a.url}
- Summary: ${ASCII(a.summary)}

Marker: ${alertMarker(a.source, a.number)}

Complete this task with a fix PR, or without a code change by adding a \`dismissal:\`
frontmatter block (\`reason\`, \`by\`, \`date\`); see docs/operations/security-findings.md.

## Acceptance criteria

1. The alert is fixed by a merged PR, or dismissed with a recorded \`dismissal:\` block.
`;
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

export function listOpenAlerts(repo, ghJson = gh) {
  const cs = ghJson([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/code-scanning/alerts?state=open&per_page=100`,
  ]).flat();
  const dep = ghJson([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/dependabot/alerts?state=open&per_page=100`,
  ]).flat();
  return [...parseCodeScanningAlerts(cs), ...parseDependabotAlerts(dep)];
}

export function plan(alerts, root) {
  return assignIds(dedupeAlerts(alerts, readExistingText(root)), maxTaskNumber(root));
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

export function main(argv, root = process.cwd()) {
  const dryRun = argv.includes('--dry-run');
  const repo =
    process.env.GITHUB_REPOSITORY ||
    run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const planned = plan(listOpenAlerts(repo), root);
  if (planned.length === 0) {
    console.log('No unfiled security alerts.');
    return 0;
  }
  for (const a of planned) {
    console.log(`${a.taskId}\t${a.source}\t#${a.number}\t${a.severity}\t${ASCII(a.summary)}`);
  }
  if (dryRun) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const files = [];
  for (const a of planned) {
    const f = join('backlog/tasks', taskFileName(a));
    writeFileSync(join(root, f), renderTask(a, today));
    files.push(f);
  }
  const branch = `chore/security-findings-${today}-${Date.now()}`;
  run('git', ['checkout', '-b', branch]);
  run('git', ['add', '--', ...files]);
  run('git', [
    'commit',
    '-m',
    `chore(docs): file ${planned.length} security finding task(s) (AISDLC-940)`,
  ]);
  run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  const body = `Files ${planned.length} backlog task(s) for open security alerts:\n\n${planned
    .map((a) => `- ${a.taskId}: ${a.source} #${a.number} (${a.severity}) ${a.url}`)
    .join('\n')}\n`;
  console.log(
    run('gh', [
      'pr',
      'create',
      '--title',
      `chore(docs): file ${planned.length} security finding task(s)`,
      '--body',
      body,
    ]),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[security-findings] ${err?.message ?? err}`);
    process.exit(1);
  }
}
