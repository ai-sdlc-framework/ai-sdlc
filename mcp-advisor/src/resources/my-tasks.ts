import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export function registerMyTasksResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'my-tasks',
    'ai-sdlc://context/my-tasks',
    { description: 'Recent pipeline runs and task history' },
    async () => {
      const runs = deps.store.getPipelineRuns(undefined, 50);
      return {
        contents: [
          {
            uri: 'ai-sdlc://context/my-tasks',
            text: JSON.stringify(runs, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );
}
