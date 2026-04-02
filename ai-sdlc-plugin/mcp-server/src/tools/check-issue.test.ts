import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckIssue } from './check-issue.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

describe('check_issue', () => {
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  beforeEach(() => {
    const server = {
      tool: vi.fn((_name, _desc, _schema, handler) => {
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerCheckIssue(server, { projectDir: '/test/project' });
  });

  it('returns formatted summary for a successful issue lookup', async () => {
    vi.mocked(child_process.execSync).mockReturnValue(
      JSON.stringify({
        title: 'Bug: login page crashes',
        state: 'OPEN',
        author: { login: 'carol' },
        labels: [{ name: 'bug' }, { name: 'priority:high' }],
        assignees: [{ login: 'dave' }, { login: 'eve' }],
        comments: [{ body: 'I can reproduce this' }, { body: 'Working on a fix' }],
        createdAt: '2026-03-15T10:00:00Z',
        body: 'The login page crashes when submitting empty form.',
      }),
    );

    const result = await registeredHandler({ issueNumber: 7 });
    const text = result.content[0].text;

    expect(text).toContain('Issue #7: Bug: login page crashes');
    expect(text).toContain('State: OPEN');
    expect(text).toContain('Author: carol');
    expect(text).toContain('Labels: bug, priority:high');
    expect(text).toContain('Assignees: dave, eve');
    expect(text).toContain('Comments: 2');
    expect(text).toContain('Created: 2026-03-15T10:00:00Z');
    expect(text).toContain('The login page crashes when submitting empty form.');
    expect(result.isError).toBeUndefined();
  });

  it('handles execSync error gracefully', async () => {
    vi.mocked(child_process.execSync).mockImplementation(() => {
      throw new Error('Could not resolve to an issue');
    });

    const result = await registeredHandler({ issueNumber: 999 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error fetching issue #999');
    expect(result.content[0].text).toContain('Could not resolve to an issue');
  });
});
