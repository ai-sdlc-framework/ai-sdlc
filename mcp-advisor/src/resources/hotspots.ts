import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export function registerHotspotsResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'hotspots',
    'ai-sdlc://context/hotspots',
    { description: 'Top file hotspots by churn rate and complexity — files that need extra care' },
    async () => {
      const hotspots = deps.store.getHotspots(deps.repoPath, 20);
      return {
        contents: [{
          uri: 'ai-sdlc://context/hotspots',
          text: JSON.stringify(hotspots, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
