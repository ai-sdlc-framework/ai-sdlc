import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: vi.fn().mockImplementation(() => ({
      tool: vi.fn(),
    })),
  };
});

vi.mock('./tools/index.js', () => ({
  registerAllTools: vi.fn(),
}));

import { createPluginMcpServer } from './server.js';
import { registerAllTools } from './tools/index.js';

describe('createPluginMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with a server property', () => {
    const result = createPluginMcpServer();
    expect(result).toHaveProperty('server');
    expect(result.server).toBeDefined();
  });

  it('calls registerAllTools with the server and deps', () => {
    createPluginMcpServer();
    expect(registerAllTools).toHaveBeenCalledTimes(1);
    expect(registerAllTools).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectDir: expect.any(String) }),
    );
  });

  it('creates an McpServer with correct name and version', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    createPluginMcpServer();
    expect(McpServer).toHaveBeenCalledWith({
      name: 'ai-sdlc-plugin',
      version: '0.7.0',
    });
  });
});
