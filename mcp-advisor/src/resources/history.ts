import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findRelevantEpisodes } from '@ai-sdlc/orchestrator';
import type { ServerDeps } from '../types.js';

export function registerHistoryResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'history',
    'ai-sdlc://context/history',
    { description: 'Episodic memory relevant to the active session or recent work' },
    async () => {
      const activeSession = deps.sessions.getActive();
      const issueNumber = activeSession?.linkedIssue ?? undefined;
      const episodes = findRelevantEpisodes(deps.store, { issueNumber });
      return {
        contents: [
          {
            uri: 'ai-sdlc://context/history',
            text: JSON.stringify(episodes, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );
}
