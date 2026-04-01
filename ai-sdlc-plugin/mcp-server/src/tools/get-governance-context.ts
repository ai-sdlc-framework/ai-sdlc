import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';

export function registerGetGovernanceContext(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_governance_context',
    'Return current agent-role.yaml constraints and governance configuration',
    {
      _placeholder: z.string().optional().describe('No parameters needed'),
    },
    async () => {
      const agentRolePath = join(deps.projectDir, '.ai-sdlc', 'agent-role.yaml');

      if (!existsSync(agentRolePath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No .ai-sdlc/agent-role.yaml found in project. AI-SDLC governance is not configured for this repository.',
            },
          ],
        };
      }

      try {
        const yaml = readFileSync(agentRolePath, 'utf-8');
        return {
          content: [
            {
              type: 'text' as const,
              text: `# Agent Role Configuration\n\n\`\`\`yaml\n${yaml}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reading agent-role.yaml: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
