import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskClassOf } from '../routing/task-class.js';
import { backfillTaskClass } from './backfill.js';
import {
  extractLabels,
  priorityDirection,
  readHoldDecisions,
  renderLabelsJsonl,
} from './extract.js';
import { deriveTaskClass, parseTaskFrontmatter } from './task-file.js';
import { renderCellsText, type Scorecard, type ScorecardRow } from '../usage/scorecard.js';

const fmOf = (extra: string): string => `---\nid: T-1\nstatus: Done\n${extra}\n---\nbody`;

describe('task class derivation', () => {
  it('uses labels, references, and frontmatter class', () => {
    expect(taskClassOf(fmOf('labels:\n  - bug'))).toBe('bug');
    expect(taskClassOf(fmOf('labels: [docs]'))).toBe('chore');
    expect(taskClassOf(fmOf('labels:\n  - feature'))).toBe('feature');
    expect(taskClassOf(fmOf('labels:\n  - x\nreferences:\n  - a/b.ts'))).toBe('feature');
    expect(taskClassOf(fmOf('labels:\n  - x\nreferences:\n  - docs/a.md'))).toBe('chore');
    expect(taskClassOf(fmOf('class: bug\nlabels:\n  - docs'))).toBe('bug');
    expect(taskClassOf(undefined)).toBe('uncategorized');
    expect(taskClassOf('no frontmatter')).toBe('uncategorized');
  });
  it('explains uncategorized', () => {
    expect(deriveTaskClass(parseTaskFrontmatter(fmOf('labels:\n  - x'))).reason).toMatch(/labels/);
    expect(deriveTaskClass(parseTaskFrontmatter(fmOf(''))).reason).toMatch(/no labels/);
    expect(deriveTaskClass(undefined).reason).toMatch(/frontmatter/);
  });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'labels-'));
  mkdirSync(join(d, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(d, 'backlog', 'completed'), { recursive: true });
  return d;
}
const git = (d: string, ...a: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
    { cwd: d, stdio: 'ignore' },
  );
};
const commit = (d: string, date: string): void => {
  git(d, 'add', '-A');
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'x',
      '--date',
      date,
    ],
    { cwd: d, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: date } },
  );
};

describe('extractLabels', () => {
  it('yields priority direction from git history and all four signals', () => {
    const d = repo();
    git(d, 'init', '-q');
    const f = join(d, 'backlog', 'completed', 'T-1 - a.md');
    const mk = (status: string, prio: string): string =>
      `---\nid: T-1\nstatus: ${status}\ncreated_date: '2026-01-01'\npriority: ${prio}\nlabels:\n  - bug\n---\n`;
    writeFileSync(f, mk('To Do', 'low'));
    commit(d, '2026-01-01T00:00:00Z');
    writeFileSync(f, mk('To Do', 'critical'));
    commit(d, '2026-01-02T00:00:00Z');
    writeFileSync(f, mk('In Progress', 'critical'));
    commit(d, '2026-01-11T00:00:00Z');
    writeFileSync(f, mk('Done', 'critical'));
    commit(d, '2026-01-12T00:00:00Z');
    writeFileSync(
      join(d, 'backlog', 'tasks', 'T-2 - b.md'),
      '---\nid: T-2\nstatus: To Do\nblocked:\n  reason: x\n---\n',
    );
    writeFileSync(
      join(d, 'backlog', 'completed', 'T-3 - c.md'),
      '---\nid: T-3\nstatus: Withdrawn\n---\n',
    );
    writeFileSync(
      join(d, 'backlog', 'tasks', 'T-4 - open.md'),
      '---\nid: T-4\nstatus: To Do\n---\n',
    );
    mkdirSync(join(d, '.ai-sdlc', '_decisions', 'events'), { recursive: true });
    writeFileSync(
      join(d, '.ai-sdlc', '_decisions', 'events', 'a.json'),
      JSON.stringify({ type: 'decision-opened', decisionId: 'DEC-9', summary: 'park T-2 for now' }),
    );
    writeFileSync(join(d, '.ai-sdlc', '_decisions', 'events', 'bad.json'), '{');
    writeFileSync(join(d, '.ai-sdlc', '_decisions', 'events', 'note.txt'), 'x');

    const rows = extractLabels(d);
    expect(rows.map((r) => r.taskId)).toEqual(['T-1', 'T-3', 'T-2']);
    const t1 = rows[0];
    expect(t1.outcome).toBe('landed');
    expect(t1.priorityEdit).toEqual({ direction: 'up', from: 'low', to: 'critical' });
    expect(t1.queueAge.days).toBe(10);
    expect(t1.queueAge.ratio).toBe(1);
    expect(rows[1].outcome).toBe('abandoned');
    expect(rows[2].outcome).toBe('parked');
    expect(rows[2].holdDecisions).toEqual(['DEC-9']);
    const jsonl = renderLabelsJsonl(rows).trim().split('\n');
    expect(jsonl).toHaveLength(4);
    expect(JSON.parse(jsonl[0]).rule).toMatch(/Recording only/);
    expect(readHoldDecisions(join(d, 'nowhere')).size).toBe(0);
  });
  it('direction down, none, and git failure', () => {
    expect(priorityDirection(['critical', 'low']).direction).toBe('down');
    expect(priorityDirection(['low', 'low']).direction).toBe('none');
    expect(priorityDirection([]).direction).toBe('none');
    const d = repo();
    writeFileSync(join(d, 'backlog', 'tasks', 'T-9 - x.md'), '---\nid: T-9\nblocked: {}\n---\n');
    const rows = extractLabels(d); // not a git repo
    expect(rows[0].queueAge.days).toBeNull();
  });
});

describe('backfillTaskClass', () => {
  it('rewrites and reports reasons', () => {
    const d = repo();
    writeFileSync(join(d, 'backlog', 'tasks', 'T-1 - a.md'), fmOf('labels:\n  - bug'));
    writeFileSync(join(d, 'backlog', 'tasks', 'T-2 - b.md'), fmOf(''));
    const log = join(d, 'a.jsonl');
    const rec = (taskId: string, taskClass = 'uncategorized'): string =>
      JSON.stringify({ taskId, taskClass, role: 'developer' });
    writeFileSync(
      log,
      [
        rec('T-1'),
        rec('T-1'),
        rec('T-2'),
        rec('T-404'),
        rec(''),
        rec('T-5', 'bug'),
        'garbage',
      ].join('\n'),
    );
    const dry = backfillTaskClass(log, d, { dryRun: true });
    expect(dry.rewritten).toBe(2);
    expect(readFileSync(log, 'utf8')).toContain('uncategorized');
    const r = backfillTaskClass(log, d);
    expect(r).toMatchObject({ rows: 6, rewritten: 2, stillUncategorized: 3 });
    expect(Object.keys(r.reasons).sort()).toEqual([
      'no labels or references',
      'row has no task id',
      'task file not found',
    ]);
    expect(readFileSync(log, 'utf8').split('\n')[0]).toContain('"bug"');
    expect(backfillTaskClass(join(d, 'missing'), d).rows).toBe(0);
  });
});

describe('renderCellsText', () => {
  const row = (tasks: number, approved: number | null): ScorecardRow =>
    ({ role: 'developer', model: 'm', taskClass: 'bug', tasks, approved }) as ScorecardRow;
  it('prints counts and one gate line', () => {
    const card = { rows: [row(3, 2), row(200, 150), row(5, null)] } as Scorecard;
    const out = renderCellsText(card).trim().split('\n');
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(
      'Phase 3 gate (200 per cell): 1 of 2 cells ready, largest cell 200/200 (closed).',
    );
    expect(renderCellsText({ rows: [row(200, 1)] } as Scorecard)).toContain('(open)');
  });
});
