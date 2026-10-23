import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckIssue } from './check-issue.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

describe('check_issue', () => {
  let registeredSchema: Record<string, z.ZodTypeAny>;
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = {
      tool: vi.fn((_name, _desc, schema, handler) => {
        registeredSchema = schema;
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerCheckIssue(server, { projectDir: '/test/project' });
  });

  it('returns formatted summary for a successful issue lookup', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
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

  it('handles execFileSync error gracefully', async () => {
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw new Error('Could not resolve to an issue');
    });

    const result = await registeredHandler({ issueNumber: 999 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error fetching issue #999');
    expect(result.content[0].text).toContain('Could not resolve to an issue');
  });

  it('passes an exact argument array with --repo when repo is given', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify({ title: 'T' }));
    await registeredHandler({ issueNumber: 5, repo: 'owner/name' });
    const call = vi.mocked(child_process.execFileSync).mock.calls[0];
    expect(call[0]).toBe('gh');
    expect(call[1]).toEqual([
      'issue',
      'view',
      '5',
      '--repo',
      'owner/name',
      '--json',
      'title,body,state,labels,author,assignees,comments,createdAt',
    ]);
  });

  it('omits --repo when repo is not given', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify({ title: 'T' }));
    await registeredHandler({ issueNumber: 5 });
    const args = vi.mocked(child_process.execFileSync).mock.calls[0][1] as string[];
    expect(args).not.toContain('--repo');
  });

  it.each(['foo/bar; echo pwned', '$(id)'])('refuses malicious repo %s before spawning', (repo) => {
    const parsed = z.object(registeredSchema).safeParse({ issueNumber: 5, repo });
    expect(parsed.success).toBe(false);
    expect(child_process.execFileSync).not.toHaveBeenCalled();
  });

  it('accepts owner/name', () => {
    expect(
      z.object(registeredSchema).safeParse({ issueNumber: 5, repo: 'owner/name' }).success,
    ).toBe(true);
  });
});
