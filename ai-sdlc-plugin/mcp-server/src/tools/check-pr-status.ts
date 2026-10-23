import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';

export function registerCheckPrStatus(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'check_pr_status',
    'Get PR check status, reviews, and merge readiness',
    {
      prNumber: z.number().describe('Pull request number'),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'repo must be in owner/name format')
        .optional()
        .describe('Repository in owner/repo format'),
    },
    async ({ prNumber, repo }) => {
      try {
        const prJson = execFileSync(
          'gh',
          [
            'pr',
            'view',
            String(prNumber),
            ...(repo ? ['--repo', repo] : []),
            '--json',
            'title,state,headRefName,mergeable,statusCheckRollup,reviews,labels',
          ],
          { encoding: 'utf-8', cwd: deps.projectDir, timeout: 15000 },
        );
        const pr = JSON.parse(prJson);

        const checks = (pr.statusCheckRollup || []).map(
          (c: { name: string; conclusion: string; status: string }) =>
            `${c.conclusion === 'SUCCESS' ? 'PASS' : c.status === 'IN_PROGRESS' ? 'RUNNING' : 'FAIL'} ${c.name}`,
        );

        const reviews = (pr.reviews || []).map(
          (r: { state: string; author: { login: string } }) => `${r.state} by ${r.author.login}`,
        );

        const summary = [
          `# PR #${prNumber}: ${pr.title}`,
          `State: ${pr.state}`,
          `Branch: ${pr.headRefName}`,
          `Mergeable: ${pr.mergeable}`,
          '',
          '## Checks',
          checks.length > 0 ? checks.join('\n') : 'No checks',
          '',
          '## Reviews',
          reviews.length > 0 ? reviews.join('\n') : 'No reviews',
        ].join('\n');

        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching PR #${prNumber}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
