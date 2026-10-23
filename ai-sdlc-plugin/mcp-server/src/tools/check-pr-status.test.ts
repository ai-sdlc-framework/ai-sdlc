import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckPrStatus } from './check-pr-status.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

describe('check_pr_status', () => {
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

    registerCheckPrStatus(server, { projectDir: '/test/project' });
  });

  it('returns formatted summary for a successful PR status', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
      JSON.stringify({
        title: 'Add feature X',
        state: 'OPEN',
        headRefName: 'feature/x',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { name: 'ci/build', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'ci/lint', conclusion: 'FAILURE', status: 'COMPLETED' },
          { name: 'ci/deploy', conclusion: null, status: 'IN_PROGRESS' },
        ],
        reviews: [
          { state: 'APPROVED', author: { login: 'alice' } },
          { state: 'CHANGES_REQUESTED', author: { login: 'bob' } },
        ],
        labels: [],
      }),
    );

    const result = await registeredHandler({ prNumber: 42 });
    const text = result.content[0].text;

    expect(text).toContain('PR #42: Add feature X');
    expect(text).toContain('State: OPEN');
    expect(text).toContain('Branch: feature/x');
    expect(text).toContain('Mergeable: MERGEABLE');
    expect(text).toContain('PASS ci/build');
    expect(text).toContain('FAIL ci/lint');
    expect(text).toContain('RUNNING ci/deploy');
    expect(text).toContain('APPROVED by alice');
    expect(text).toContain('CHANGES_REQUESTED by bob');
    expect(result.isError).toBeUndefined();
  });

  it('handles execFileSync error gracefully', async () => {
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = await registeredHandler({ prNumber: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error fetching PR #99');
    expect(result.content[0].text).toContain('gh: command not found');
  });

  it('passes an exact argument array with --repo when repo is given', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify({ title: 'T' }));
    await registeredHandler({ prNumber: 5, repo: 'owner/name' });
    const call = vi.mocked(child_process.execFileSync).mock.calls[0];
    expect(call[0]).toBe('gh');
    expect(call[1]).toEqual([
      'pr',
      'view',
      '5',
      '--repo',
      'owner/name',
      '--json',
      'title,state,headRefName,mergeable,statusCheckRollup,reviews,labels',
    ]);
  });

  it('omits --repo when repo is not given', async () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify({ title: 'T' }));
    await registeredHandler({ prNumber: 5 });
    const args = vi.mocked(child_process.execFileSync).mock.calls[0][1] as string[];
    expect(args).not.toContain('--repo');
  });

  it.each(['foo/bar; echo pwned', '$(id)'])('refuses malicious repo %s before spawning', (repo) => {
    const parsed = z.object(registeredSchema).safeParse({ prNumber: 5, repo });
    expect(parsed.success).toBe(false);
    expect(child_process.execFileSync).not.toHaveBeenCalled();
  });

  it('accepts owner/name', () => {
    expect(z.object(registeredSchema).safeParse({ prNumber: 5, repo: 'owner/name' }).success).toBe(
      true,
    );
  });
});
