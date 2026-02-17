import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export function registerCodebaseProfileResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'codebase-profile',
    'ai-sdlc://context/codebase-profile',
    { description: 'Latest codebase complexity profile including score, modules, patterns, and hotspots' },
    async () => {
      const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
      const data = profile ?? { message: 'No codebase profile available. Run analysis first.' };
      return {
        contents: [{
          uri: 'ai-sdlc://context/codebase-profile',
          text: JSON.stringify(data, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
