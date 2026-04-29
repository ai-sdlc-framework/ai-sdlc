import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskEdit, locateTaskFile } from './task-edit.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

describe('task_edit MCP tool', () => {
  let projectDir: string;
  let handler: Handler;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-73-task-edit-'));
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });

    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskEdit(server, { projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('flips status while preserving permittedExternalPaths (AC #1, AC #2)', async () => {
    const taskPath = join(
      projectDir,
      'backlog',
      'tasks',
      'aisdlc-68 - documentation-consolidation.md',
    );
    const original = [
      '---',
      'id: AISDLC-68',
      'title: Documentation consolidation',
      'status: To Do',
      'permittedExternalPaths:',
      "  - '../ai-sdlc-io/'",
      '---',
      '',
      '## Description',
      '',
      'Consolidate docs.',
      '',
    ].join('\n');
    writeFileSync(taskPath, original, 'utf-8');

    const result = await handler({ id: 'AISDLC-68', status: 'In Progress' });

    expect(result.isError).toBeUndefined();
    const after = readFileSync(taskPath, 'utf-8');
    expect(after).toContain('status: In Progress');
    // The bug we're fixing — must still be there.
    expect(after).toContain('permittedExternalPaths:');
    expect(after).toContain("  - '../ai-sdlc-io/'");
    // And the response surfaces the preservation for caller verification.
    expect(result.content[0].text).toContain('permittedExternalPaths preserved');
  });

  it('checks ACs and writes a Final Summary (AC #3 path)', async () => {
    const taskPath = join(projectDir, 'backlog', 'tasks', 'aisdlc-99 - sample.md');
    writeFileSync(
      taskPath,
      [
        '---',
        'id: AISDLC-99',
        'status: In Progress',
        'customField: keep-me',
        '---',
        '',
        '## Acceptance Criteria',
        '- [ ] #1 First',
        '- [ ] #2 Second',
        '',
      ].join('\n'),
      'utf-8',
    );

    await handler({
      id: 'aisdlc-99',
      status: 'Done',
      acceptanceCriteriaCheck: [1, 2],
      finalSummary: 'All done.',
    });

    const after = readFileSync(taskPath, 'utf-8');
    expect(after).toContain('status: Done');
    expect(after).toContain('customField: keep-me');
    expect(after).toContain('- [x] #1 First');
    expect(after).toContain('- [x] #2 Second');
    expect(after).toContain('## Final Summary');
    expect(after).toContain('All done.');
  });

  it('returns isError when the task is not found', async () => {
    const result = await handler({ id: 'AISDLC-9999', status: 'Done' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('is a no-op when no fields would change (idempotent)', async () => {
    const taskPath = join(projectDir, 'backlog', 'tasks', 'aisdlc-1 - x.md');
    const original = ['---', 'id: AISDLC-1', 'status: To Do', '---', '', 'Body.', ''].join('\n');
    writeFileSync(taskPath, original, 'utf-8');

    const result = await handler({ id: 'AISDLC-1' });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(taskPath, 'utf-8')).toBe(original);
    expect(result.content[0].text).toContain('No changes');
  });
});

describe('locateTaskFile', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-73-locate-'));
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('locates open tasks under backlog/tasks/', () => {
    const path = join(projectDir, 'backlog', 'tasks', 'aisdlc-42 - example.md');
    writeFileSync(path, 'x');
    expect(locateTaskFile(projectDir, 'AISDLC-42')).toEqual({ path, bucket: 'tasks' });
  });

  it('locates completed tasks under backlog/completed/', () => {
    const path = join(projectDir, 'backlog', 'completed', 'aisdlc-42 - example.md');
    writeFileSync(path, 'x');
    expect(locateTaskFile(projectDir, 'aisdlc-42')).toEqual({ path, bucket: 'completed' });
  });

  it('returns undefined for unknown ids', () => {
    expect(locateTaskFile(projectDir, 'AISDLC-9999')).toBeUndefined();
  });
});
