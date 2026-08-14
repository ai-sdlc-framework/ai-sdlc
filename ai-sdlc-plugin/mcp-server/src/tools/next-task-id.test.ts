import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNextTaskId } from './next-task-id.js';

// AISDLC-559 review (CRITICAL): the allocator now fails CLOSED when the
// git-refs source cannot scan. These fixtures previously used bare mkdtemp
// dirs with no .git, so git-refs was genuinely unscanned in EVERY test while
// they all asserted success — the tool's core guarantee was never exercised.
// Make the fixtures real repos so the scan actually runs.
function initGitRepoForFixture(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'aisdlc-559-fixture@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'AISDLC-559 Fixture'], { cwd: dir });
}

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/**
 * Tests for AISDLC-559: `next_task_id` MCP tool.
 */
describe('next_task_id MCP tool (AISDLC-559)', () => {
  let projectDir: string;
  let handler: Handler;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-559-next-id-'));
    initGitRepoForFixture(projectDir);
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });

    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerNextTaskId(server, { projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('allocates AISDLC-1 when nothing is claimed', async () => {
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Allocated: AISDLC-1');
  });

  it('allocates the next free ID after the current max', async () => {
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-42 - existing.md'), 'x', 'utf-8');
    const result = await handler({});
    expect(result.content[0].text).toContain('Allocated: AISDLC-43');
  });

  it('allocates a contiguous block of N IDs', async () => {
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-100 - existing.md'), 'x', 'utf-8');
    const result = await handler({ count: 4 });
    expect(result.content[0].text).toContain(
      'Allocated: AISDLC-101, AISDLC-102, AISDLC-103, AISDLC-104',
    );
  });

  it('respects a custom prefix', async () => {
    const result = await handler({ prefix: 'PROJ' });
    expect(result.content[0].text).toContain('Allocated: PROJ-1');
  });

  it('reports which sources were scanned and how many IDs each found', async () => {
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-7 - existing.md'), 'x', 'utf-8');
    const result = await handler({});
    const text = result.content[0].text;
    expect(text).toContain('## Sources scanned');
    expect(text).toContain('git-refs');
    expect(text).toContain('sibling-worktrees');
    expect(text).toContain('current-worktree: scanned, 1 id(s) found');
  });

  it('warns loudly about freshness when FETCH_HEAD is missing (never fetched)', async () => {
    const result = await handler({});
    expect(result.content[0].text).toContain('## Freshness');
    expect(result.content[0].text).toMatch(/STALE/);
  });

  it('never fetches unless fetch: true is passed', async () => {
    const result = await handler({});
    expect(result.content[0].text).not.toContain('A `git fetch origin` was performed');
  });
});

describe('next_task_id — sees sibling worktree claims (AISDLC-559)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-559-next-id-sibling-'));
    initGitRepoForFixture(scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('allocates past an ID claimed only in a sibling worktree', async () => {
    const parent = join(scratch, 'parent-repo');
    const wtA = join(parent, '.worktrees', 'aisdlc-a');
    const wtB = join(parent, '.worktrees', 'aisdlc-b');
    mkdirSync(join(wtA, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(wtB, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(wtB, 'backlog', 'tasks', 'aisdlc-900 - sibling.md'), 'x', 'utf-8');

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerNextTaskId(server, { projectDir: wtA });

    const result = await handler({});
    expect(result.content[0].text).toContain('Allocated: AISDLC-901');
  });
});
