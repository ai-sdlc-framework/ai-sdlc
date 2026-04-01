import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetGovernanceContext } from './get-governance-context.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

describe('get_governance_context', () => {
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  beforeEach(() => {
    const server = {
      tool: vi.fn((_name, _desc, _schema, handler) => {
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerGetGovernanceContext(server, { projectDir: '/test/project' });
  });

  it('returns yaml content when agent-role.yaml exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: AgentRole\n',
    );

    const result = await registeredHandler({});
    expect(result.content[0].text).toContain('Agent Role Configuration');
    expect(result.content[0].text).toContain('ai-sdlc.io/v1alpha1');
  });

  it('returns not-found message when file missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await registeredHandler({});
    expect(result.content[0].text).toContain('not configured');
  });

  it('returns error when file read fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await registeredHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EACCES');
  });
});
