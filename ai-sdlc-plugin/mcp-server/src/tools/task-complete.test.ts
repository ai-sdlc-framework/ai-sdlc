import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskComplete } from './task-complete.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

describe('task_complete MCP tool', () => {
  let projectDir: string;
  let handler: Handler;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-73-task-complete-'));
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });

    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskComplete(server, { projectDir });
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('moves the file to completed/ and preserves unknown frontmatter (AC #4)', async () => {
    const filename = 'aisdlc-68 - documentation-consolidation.md';
    const sourcePath = join(projectDir, 'backlog', 'tasks', filename);
    const destPath = join(projectDir, 'backlog', 'completed', filename);
    writeFileSync(
      sourcePath,
      [
        '---',
        'id: AISDLC-68',
        'status: In Progress',
        'permittedExternalPaths:',
        "  - '../ai-sdlc-io/'",
        'customField: keep-me',
        '---',
        '',
        '## Description',
        '',
        'Body.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await handler({ id: 'AISDLC-68', finalSummary: 'Shipped.' });
    expect(result.isError).toBeUndefined();

    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(destPath)).toBe(true);

    const after = readFileSync(destPath, 'utf-8');
    expect(after).toContain('status: Done');
    // The bug we're fixing — must still be there post-move.
    expect(after).toContain('permittedExternalPaths:');
    expect(after).toContain("  - '../ai-sdlc-io/'");
    expect(after).toContain('customField: keep-me');
    expect(after).toContain('## Final Summary');
    expect(after).toContain('Shipped.');
  });

  it('refuses to clobber an existing file in completed/', async () => {
    const filename = 'aisdlc-1 - sample.md';
    writeFileSync(
      join(projectDir, 'backlog', 'tasks', filename),
      '---\nid: AISDLC-1\nstatus: In Progress\n---\n',
      'utf-8',
    );
    writeFileSync(join(projectDir, 'backlog', 'completed', filename), 'pre-existing', 'utf-8');

    const result = await handler({ id: 'AISDLC-1' });
    // The locate call finds the source bucket first, so we should attempt
    // to move and then bail. Either an explicit clobber-refusal OR an
    // error is acceptable; we just must not destroy the destination.
    expect(readFileSync(join(projectDir, 'backlog', 'completed', filename), 'utf-8')).toBe(
      'pre-existing',
    );
    expect(result.isError).toBe(true);
  });

  it('is idempotent when called on an already-completed task', async () => {
    const filename = 'aisdlc-1 - sample.md';
    const path = join(projectDir, 'backlog', 'completed', filename);
    const original = [
      '---',
      'id: AISDLC-1',
      'status: Done',
      'permittedExternalPaths:',
      "  - '../foo/'",
      '---',
      '',
      '## Final Summary',
      '',
      'Already done.',
      '',
    ].join('\n');
    writeFileSync(path, original, 'utf-8');

    const result = await handler({ id: 'AISDLC-1' });
    expect(result.isError).toBeUndefined();
    // File still in completed/ and the unknown frontmatter survives.
    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('permittedExternalPaths:');
    expect(after).toContain("  - '../foo/'");
    expect(after).toContain('status: Done');
    expect(result.content[0].text).toMatch(/already in backlog\/completed/);
  });

  it('returns isError when the task is not found', async () => {
    const result = await handler({ id: 'AISDLC-9999' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('creates backlog/completed/ if it does not exist', async () => {
    rmSync(join(projectDir, 'backlog', 'completed'), { recursive: true, force: true });
    const filename = 'aisdlc-7 - x.md';
    writeFileSync(
      join(projectDir, 'backlog', 'tasks', filename),
      '---\nid: AISDLC-7\nstatus: In Progress\n---\n',
      'utf-8',
    );

    const result = await handler({ id: 'AISDLC-7' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectDir, 'backlog', 'completed', filename))).toBe(true);
  });
});
