import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTaskFile, parseSimpleYaml, parseTaskFile, validateTask } from './01-validate.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('Step 1 — validateTask', () => {
  it('happy path — To Do task with ACs is OK', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'demo', status: 'To Do' });
    const r = await validateTask({ taskId: 'AISDLC-1', workDir: tmp });
    expect(r.ok).toBe(true);
    expect(r.task?.id).toBe('AISDLC-1');
    expect(r.task?.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('happy path — In Progress with some unchecked ACs is OK', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-2',
      title: 'two',
      status: 'In Progress',
      acceptanceCriteria: ['a', 'b'],
      acceptanceCriteriaChecked: [true, false],
    });
    const r = await validateTask({ taskId: 'AISDLC-2', workDir: tmp });
    expect(r.ok).toBe(true);
  });

  it('refuses Done', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-3', title: 'done', status: 'Done' });
    const r = await validateTask({ taskId: 'AISDLC-3', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already shipped/);
  });

  it('refuses Draft', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-4', title: 'draft', status: 'Draft' });
    const r = await validateTask({ taskId: 'AISDLC-4', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Draft/);
  });

  it('refuses unknown statuses', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-5', title: 'weird', status: 'Blocked' });
    const r = await validateTask({ taskId: 'AISDLC-5', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected status/);
  });

  it('refuses tasks without acceptance criteria', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-6', title: 'noacs', status: 'To Do', acceptanceCriteria: [] });
    const r = await validateTask({ taskId: 'AISDLC-6', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no acceptance criteria/);
  });

  it('refuses stale-Done shape (In Progress with all ACs ticked)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-7',
      title: 'stale',
      status: 'In Progress',
      acceptanceCriteria: ['a', 'b'],
      acceptanceCriteriaChecked: [true, true],
    });
    const r = await validateTask({ taskId: 'AISDLC-7', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale-Done/);
  });

  it('returns missing-file reason when no task exists', async () => {
    const r = await validateTask({ taskId: 'AISDLC-999', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no task file/);
  });

  it('returns parse-failure reason for malformed frontmatter', async () => {
    const bad = join(tmp, 'backlog', 'tasks', 'aisdlc-8 - bad.md');
    writeFileSync(bad, 'no frontmatter here\n', 'utf8');
    const r = await validateTask({ taskId: 'AISDLC-8', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing YAML frontmatter/);
  });

  it('handles double-quoted titles', async () => {
    const path = join(tmp, 'backlog', 'tasks', 'aisdlc-9 - q.md');
    writeFileSync(
      path,
      `---\nid: AISDLC-9\ntitle: "double quoted"\nstatus: To Do\n---\n\n## Acceptance Criteria\n- [ ] #1 a\n`,
      'utf8',
    );
    const r = await validateTask({ taskId: 'AISDLC-9', workDir: tmp });
    expect(r.ok).toBe(true);
    expect(r.task?.title).toBe('double quoted');
  });
});

describe('Step 1 — helpers', () => {
  it('findTaskFile returns null when tasks/ missing', () => {
    expect(findTaskFile('AISDLC-1', '/no/such/path')).toBeNull();
  });

  it('findTaskFile is case-insensitive', () => {
    writeTaskFile(tmp, { id: 'AISDLC-10', title: 'case', status: 'To Do' });
    expect(findTaskFile('aisdlc-10', tmp)).not.toBeNull();
    expect(findTaskFile('AISDLC-10', tmp)).not.toBeNull();
  });

  it('parseSimpleYaml handles scalar + list mix', () => {
    const yaml = `id: AISDLC-1\ntitle: 'q'\nrefs:\n  - a\n  - b\n`;
    const parsed = parseSimpleYaml(yaml);
    expect(parsed.id).toBe('AISDLC-1');
    expect(parsed.title).toBe('q');
    expect(parsed.refs).toEqual(['a', 'b']);
  });

  it('parseSimpleYaml ignores comments', () => {
    const yaml = `# top comment\nid: X\n# another\n`;
    expect(parseSimpleYaml(yaml).id).toBe('X');
  });

  it('parseTaskFile picks up permittedExternalPaths', () => {
    const path = writeTaskFile(tmp, {
      id: 'AISDLC-11',
      title: 'ext',
      status: 'To Do',
      permittedExternalPaths: ['../sibling/'],
    });
    const parsed = parseTaskFile(path);
    expect(parsed.permittedExternalPaths).toEqual(['../sibling/']);
  });
});
