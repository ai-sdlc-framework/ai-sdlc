import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export function registerConventionsResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'conventions',
    'ai-sdlc://context/conventions',
    { description: 'Detected coding conventions: naming, testing, imports, structure, formatting' },
    async () => {
      const conventions = deps.store.getConventions();
      return {
        contents: [{
          uri: 'ai-sdlc://context/conventions',
          text: JSON.stringify(conventions, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
