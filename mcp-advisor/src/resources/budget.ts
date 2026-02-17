import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export function registerBudgetResource(server: McpServer, deps: ServerDeps): void {
  server.resource(
    'budget',
    'ai-sdlc://context/budget',
    { description: 'Current cost budget status and per-agent breakdown' },
    async () => {
      const budgetStatus = deps.costTracker.getBudgetStatus();
      const costByAgent = deps.costTracker.getCostByAgent();
      const data = { budgetStatus, costByAgent };
      return {
        contents: [{
          uri: 'ai-sdlc://context/budget',
          text: JSON.stringify(data, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
