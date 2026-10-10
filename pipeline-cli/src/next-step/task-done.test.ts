import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { writeDemoTaskFile } from '../__test-helpers/next-step-fixtures.js';
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
});
