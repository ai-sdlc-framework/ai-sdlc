import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';

export function registerGetReviewPolicy(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_review_policy',
    'Return the review policy calibration document for review agents',
    {
      _placeholder: z.string().optional().describe('No parameters needed'),
    },
    async () => {
      const policyPath = join(deps.projectDir, '.ai-sdlc', 'review-policy.md');

      if (!existsSync(policyPath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No .ai-sdlc/review-policy.md found. Review agents will use default calibration.',
            },
          ],
        };
      }

      try {
        const content = readFileSync(policyPath, 'utf-8');
        return {
          content: [{ type: 'text' as const, text: content }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reading review policy: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
