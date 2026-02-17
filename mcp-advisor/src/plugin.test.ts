/**
 * MCP advisor plugin registration tests.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { McpAdvisorPlugin } from './plugin.js';
import { createMcpServer } from './server.js';

describe('McpAdvisorPlugin', () => {
  function makeDb() {
    return new Database(':memory:');
  }

  it('register() is called with server and deps', async () => {
    const plugin: McpAdvisorPlugin = {
      name: 'test-plugin',
      register: vi.fn(),
    };

    const { deps } = await createMcpServer({ db: makeDb(), plugins: [plugin] });

    expect(plugin.register).toHaveBeenCalledOnce();
    const [server, passedDeps] = (plugin.register as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(server).toBeDefined();
    expect(passedDeps).toBe(deps);
  });

  it('plugin can register a custom tool via server.tool()', async () => {
    const plugin: McpAdvisorPlugin = {
      name: 'tool-plugin',
      register(server, _deps) {
        server.tool('my_custom_tool', 'A custom tool', {}, async () => ({
          content: [{ type: 'text' as const, text: 'hello' }],
        }));
      },
    };

    // Should not throw
    const { server } = await createMcpServer({ db: makeDb(), plugins: [plugin] });
    expect(server).toBeDefined();
  });

  it('plugin can register a custom resource via server.resource()', async () => {
    const plugin: McpAdvisorPlugin = {
      name: 'resource-plugin',
      register(server, _deps) {
        server.resource('custom-data', 'ai-sdlc://custom/data', async () => ({
          contents: [{ uri: 'ai-sdlc://custom/data', text: '{}' }],
        }));
      },
    };

    const { server } = await createMcpServer({ db: makeDb(), plugins: [plugin] });
    expect(server).toBeDefined();
  });

  it('multiple plugins all get registered', async () => {
    const order: string[] = [];

    const pluginA: McpAdvisorPlugin = {
      name: 'alpha',
      register: vi.fn(() => { order.push('alpha'); }),
    };
    const pluginB: McpAdvisorPlugin = {
      name: 'beta',
      register: vi.fn(() => { order.push('beta'); }),
    };

    await createMcpServer({ db: makeDb(), plugins: [pluginA, pluginB] });

    expect(pluginA.register).toHaveBeenCalledOnce();
    expect(pluginB.register).toHaveBeenCalledOnce();
    expect(order).toEqual(['alpha', 'beta']);
  });
});
