import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { writeDemoTaskFile } from '../__test-helpers/next-step-fixtures.js';
import { buildFinalSummary } from '../steps/10-finalize.js';
import type { TaskSpec } from '../types.js';
import {
  checkAcceptanceCriteria,
  markTaskDone,
  renderDoneTask,
  setFinalSummary,
} from './task-done.js';

describe('checkAcceptanceCriteria', () => {
  const body = [
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    '- [ ] #1 one',
    '- [ ] #2 two',
    '- [ ] three (no marker)',
    '<!-- AC:END -->',
    '## Other',
    '- [ ] #1 not an AC',
  ];

  it('ticks only the requested indices inside the AC section', () => {
    const out = checkAcceptanceCriteria(body, [2]);
    expect(out[2]).toBe('- [ ] #1 one');
    expect(out[3]).toBe('- [x] #2 two');
    expect(out[7]).toBe('- [ ] #1 not an AC');
  });

  it('numbers markerless criteria by position', () => {
    expect(checkAcceptanceCriteria(body, [3])[4]).toBe('- [x] three (no marker)');
  });

  it('is a no-op for an empty index list', () => {
    expect(checkAcceptanceCriteria(body, [])).toBe(body);
  });
});

describe('setFinalSummary', () => {
  it('appends a section when none exists', () => {
    expect(setFinalSummary(['a', ''], 'S1\nS2')).toEqual([
      'a',
      '',
      '## Final Summary',
      '',
      'S1',
      'S2',
      '',
    ]);
  });

  it('drops trailing blank lines of the summary so the file ends in one newline (AISDLC-1430)', () => {
    expect(setFinalSummary(['a'], 'S1\n')).toEqual(['a', '', '## Final Summary', '', 'S1', '']);
  });

  it('replaces an existing section and keeps what follows', () => {
    const out = setFinalSummary(['## Final Summary', '', 'old', '', '## Next', 'x'], 'new');
    expect(out).toEqual(['## Final Summary', '', 'new', '', '## Next', 'x']);
  });
});

describe('renderDoneTask / markTaskDone', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpProject();
  });
  afterEach(() => cleanupTmpProject(dir));

  it('flips status, ticks ACs, writes the summary and preserves unknown frontmatter keys', () => {
    const file = writeDemoTaskFile(dir);
    const raw = readFileSync(file, 'utf8');
    const out = renderDoneTask(raw, {
      acceptanceCriteriaCheck: [1, 2],
      finalSummary: '## Summary\nok',
    });
    expect(out).toContain('status: Done');
    expect(out).toContain("permittedExternalPaths:\n  - '../x/'");
    expect(out).toContain('- [x] #1 First');
    expect(out).toContain('- [x] #2 Second');
    expect(out).toMatch(/## Final Summary\n\n## Summary\nok\n/);
  });

  it('moves the file to backlog/completed/', () => {
    const file = writeDemoTaskFile(dir);
    mkdirSync(join(dir, 'backlog', 'completed'), { recursive: true });
    const dest = markTaskDone(file, { acceptanceCriteriaCheck: [1], finalSummary: 'x' });
    expect(existsSync(file)).toBe(false);
    expect(dest).toBe(join(dir, 'backlog', 'completed', 'aisdlc-900 - demo-task.md'));
    expect(readFileSync(dest, 'utf8')).toContain('status: Done');
  });

  it('writes a completed file that passes prettier --check with a buildFinalSummary summary (AISDLC-1430)', async () => {
    const clean = [
      '---',
      'id: AISDLC-901',
      'title: demo',
      'status: In Progress',
      '---',
      '',
      '## Description',
      '',
      'Demo.',
      '',
      '## Acceptance Criteria',
      '',
      '<!-- AC:BEGIN -->',
      '',
      '- [ ] #1 a',
      '',
      '<!-- AC:END -->',
      '',
    ].join('\n');
    expect(await format(clean, { parser: 'markdown' })).toBe(clean);
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    const file = join(dir, 'backlog', 'tasks', 'aisdlc-901 - demo.md');
    writeFileSync(file, clean, 'utf8');
    const task: TaskSpec = {
      id: 'AISDLC-901',
      title: 'demo',
      status: 'In Progress',
      acceptanceCriteria: ['a'],
      acceptanceCriteriaChecked: [false],
      description: 'Demo.',
      rawBody: '',
      filePath: file,
    };
    const { finalSummary, acceptanceCriteriaCheck } = buildFinalSummary({
      taskId: 'AISDLC-901',
      workDir: dir,
      worktreePath: dir,
      task,
      developerReturn: {
        summary: 'shipped X',
        filesChanged: ['a.ts'],
        commitSha: 'abc1234',
        verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
        acceptanceCriteriaMet: [1],
        notes: 'none',
        followups: ['AISDLC-5'],
      },
      verdict: {
        approved: true,
        decision: 'APPROVED',
        counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        verdicts: [],
        harnessNote: '',
        summary: 'APPROVED',
      },
      iterations: 1,
      prOpenedByPipeline: true,
    });
    const dest = markTaskDone(file, { acceptanceCriteriaCheck, finalSummary });
    const out = readFileSync(dest, 'utf8');
    expect(out).toContain('- [x] #1 a');
    expect(out).toContain('## Final Summary');
    expect(await format(out, { parser: 'markdown' })).toBe(out);
  });
});
