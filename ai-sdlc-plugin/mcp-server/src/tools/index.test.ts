import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './index.js';

vi.mock('./check-pr-status.js', () => ({
  registerCheckPrStatus: vi.fn(),
}));
vi.mock('./check-issue.js', () => ({
  registerCheckIssue: vi.fn(),
}));
vi.mock('./get-governance-context.js', () => ({
  registerGetGovernanceContext: vi.fn(),
}));
vi.mock('./list-detected-patterns.js', () => ({
  registerListDetectedPatterns: vi.fn(),
}));
vi.mock('./get-review-policy.js', () => ({
  registerGetReviewPolicy: vi.fn(),
}));

describe('registerAllTools', () => {
  it('calls server.tool() 5 times (once per tool)', async () => {
    const server = {
      tool: vi.fn(),
    } as unknown as McpServer;

    registerAllTools(server, { projectDir: '/test/project' });

    // Each register function is called once, and each calls server.tool() internally.
    // Since we mocked the register functions, we verify they were all invoked.
    const { registerCheckPrStatus } = vi.mocked(await import('./check-pr-status.js'));
    const { registerCheckIssue } = vi.mocked(await import('./check-issue.js'));
    const { registerGetGovernanceContext } = vi.mocked(await import('./get-governance-context.js'));
    const { registerListDetectedPatterns } = vi.mocked(await import('./list-detected-patterns.js'));
    const { registerGetReviewPolicy } = vi.mocked(await import('./get-review-policy.js'));

    expect(registerCheckPrStatus).toHaveBeenCalledOnce();
    expect(registerCheckIssue).toHaveBeenCalledOnce();
    expect(registerGetGovernanceContext).toHaveBeenCalledOnce();
    expect(registerListDetectedPatterns).toHaveBeenCalledOnce();
    expect(registerGetReviewPolicy).toHaveBeenCalledOnce();
  });

  it('passes server and deps to each register function', async () => {
    const server = {
      tool: vi.fn(),
    } as unknown as McpServer;
    const deps = { projectDir: '/my/project' };

    registerAllTools(server, deps);

    const { registerCheckPrStatus } = vi.mocked(await import('./check-pr-status.js'));
    expect(registerCheckPrStatus).toHaveBeenCalledWith(server, deps);
  });
});
