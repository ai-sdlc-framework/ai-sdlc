import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';

export function registerCheckIssue(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'check_issue',
    'Get issue details, labels, and linked PRs for triage context',
    {
      issueNumber: z.number().describe('Issue number'),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'repo must be in owner/name format')
        .optional()
        .describe('Repository in owner/repo format'),
    },
    async ({ issueNumber, repo }) => {
      try {
        const issueJson = execFileSync(
          'gh',
          [
            'issue',
            'view',
            String(issueNumber),
            ...(repo ? ['--repo', repo] : []),
            '--json',
            'title,body,state,labels,author,assignees,comments,createdAt',
          ],
          { encoding: 'utf-8', cwd: deps.projectDir, timeout: 15000 },
        );
        const issue = JSON.parse(issueJson);

        const labels = (issue.labels || []).map((l: { name: string }) => l.name).join(', ');
        const assignees = (issue.assignees || []).map((a: { login: string }) => a.login).join(', ');
        const commentCount = (issue.comments || []).length;

        const summary = [
          `# Issue #${issueNumber}: ${issue.title}`,
          `State: ${issue.state}`,
          `Author: ${issue.author?.login || 'unknown'}`,
          `Labels: ${labels || 'none'}`,
          `Assignees: ${assignees || 'none'}`,
          `Comments: ${commentCount}`,
          `Created: ${issue.createdAt}`,
          '',
          '## Body',
          issue.body || '(empty)',
        ].join('\n');

        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching issue #${issueNumber}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
