import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckPrStatus } from './check-pr-status.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

describe('check_pr_status', () => {
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  beforeEach(() => {
    const server = {
      tool: vi.fn((_name, _desc, _schema, handler) => {
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerCheckPrStatus(server, { projectDir: '/test/project' });
  });

  it('returns formatted summary for a successful PR status', async () => {
    vi.mocked(child_process.execSync).mockReturnValue(
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

  it('handles execSync error gracefully', async () => {
    vi.mocked(child_process.execSync).mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = await registeredHandler({ prNumber: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error fetching PR #99');
    expect(result.content[0].text).toContain('gh: command not found');
  });
});
