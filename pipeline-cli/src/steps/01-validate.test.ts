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

  it('refuses Needs Clarification with a pointer to the DoR comment marker (RFC-0011 §7.3)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-4-NC',
      title: 'unready',
      status: 'Needs Clarification',
    });
    const r = await validateTask({ taskId: 'AISDLC-4-NC', workDir: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Needs Clarification/);
    expect(r.reason).toMatch(/Definition-of-Ready/);
    expect(r.reason).toMatch(/ai-sdlc:dor-comment/);
    // Returns the parsed task so callers can render a richer refusal.
    expect(r.task?.id).toBe('AISDLC-4-NC');
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

  // AISDLC-180 — js-yaml-backed parser handles block-scalar titles correctly.
  it('parseSimpleYaml decodes folded block-scalar (>-) titles to the unwrapped string', () => {
    const yaml =
      `id: AISDLC-178.1\n` +
      `title: >-\n` +
      `  Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder\n` +
      `  panes\n` +
      `status: To Do\n`;
    const parsed = parseSimpleYaml(yaml);
    expect(parsed.id).toBe('AISDLC-178.1');
    // The legacy line-based parser would have captured `>-` here; js-yaml
    // unwraps the folded scalar into a single-line string with single spaces
    // joining wrapped lines.
    expect(parsed.title).toBe(
      'Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder panes',
    );
    expect(parsed.status).toBe('To Do');
  });

  it('parseSimpleYaml decodes literal block-scalar (|-) titles preserving line breaks', () => {
    const yaml = `title: |-\n  line one\n  line two\n`;
    const parsed = parseSimpleYaml(yaml);
    expect(parsed.title).toBe('line one\nline two');
  });

  it('parseSimpleYaml returns {} for empty input rather than throwing', () => {
    expect(parseSimpleYaml('')).toEqual({});
    expect(parseSimpleYaml('   \n  \n')).toEqual({});
  });

  it('parseSimpleYaml throws on malformed YAML', () => {
    // Tab indentation in a list — js-yaml rejects this with a clear error.
    expect(() => parseSimpleYaml('foo:\n\t- bad\n')).toThrow(/YAML parse error/);
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
