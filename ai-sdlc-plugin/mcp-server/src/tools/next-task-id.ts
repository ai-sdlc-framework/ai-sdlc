import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { pickProjectRoot } from './task-edit.js';
import {
  computeNextFreeBlock,
  resolveParentRepoRoot,
  scanClaimedTaskIds,
  DEFAULT_TASK_ID_PREFIX,
  DEFAULT_STALE_FETCH_THRESHOLD_MS,
} from '../lib/task-id-scanner.js';
import { acquireTaskIdLock } from '../lib/task-id-lock.js';

/**
 * MCP tool: `next_task_id` — worktree-aware backlog task ID allocator
 * (AISDLC-559).
 *
 * Unlike a naive "look at the highest ID in this project dir" allocator,
 * this scans all 3 sources documented in `../lib/task-id-scanner.ts` (git
 * refs across every branch/remote/tag, sibling worktree filesystems, and
 * the current working tree) so parallel sessions across worktrees don't
 * collide. It reports which sources it scanned and how many IDs each found
 * — an allocator that silently scanned fewer sources than it claims is
 * exactly the failure mode this tool exists to fix.
 */
export function registerNextTaskId(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'next_task_id',
    'Allocate the next free backlog task ID (or a contiguous block of N), scanning ALL git refs + sibling worktree filesystems + the current worktree — not just the current project dir. Reports which sources were scanned. AISDLC-559.',
    {
      prefix: z
        .string()
        .optional()
        .describe(`Task ID prefix, e.g. "AISDLC". Defaults to "${DEFAULT_TASK_ID_PREFIX}".`),
      count: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Number of contiguous IDs to allocate. Defaults to 1.'),
      fetch: z
        .boolean()
        .optional()
        .describe(
          'Run `git fetch origin` before scanning to refresh remote-tracking refs. ' +
            'Defaults to false — this tool never fetches silently.',
        ),
    },
    async ({ prefix, count, fetch }) => {
      try {
        const projectDir = pickProjectRoot(deps.projectDir);
        if (typeof projectDir !== 'string') return projectDir; // error result

        const resolvedPrefix = prefix ?? DEFAULT_TASK_ID_PREFIX;
        const lockRoot = resolveParentRepoRoot(projectDir) ?? projectDir;

        const lock = await acquireTaskIdLock(lockRoot);
        let scan;
        try {
          scan = scanClaimedTaskIds({ projectDir, prefix: resolvedPrefix, fetch });
        } finally {
          lock.release();
        }

        const majors = computeNextFreeBlock(scan.claimed, count ?? 1);
        const allocated = majors.map((n) => `${resolvedPrefix}-${n}`);

        const lines: string[] = [
          '# next_task_id',
          `Allocated: ${allocated.join(', ')}`,
          '',
          '## Sources scanned',
        ];
        for (const r of scan.sourceReports) {
          lines.push(
            r.scanned
              ? `- ${r.source}: scanned, ${r.idsFound} id(s) found`
              : `- ${r.source}: NOT scanned (${r.detail ?? 'unknown reason'})`,
          );
        }

        lines.push('', '## Freshness');
        if (scan.freshness.ageMs !== undefined) {
          const ageSec = Math.round(scan.freshness.ageMs / 1000);
          lines.push(
            scan.freshness.stale
              ? `⚠ STALE — last fetch was ${ageSec}s ago (threshold ${Math.round(
                  DEFAULT_STALE_FETCH_THRESHOLD_MS / 1000,
                )}s). Remote-tracking refs (open PRs on other machines) may be missing from this scan. Pass fetch: true to refresh.`
              : `Last fetch: ${ageSec}s ago — fresh.`,
          );
        } else {
          lines.push(
            '⚠ STALE — could not determine last fetch time (no FETCH_HEAD found, or not a git repo). ' +
              'Remote-tracking refs may be missing from this scan. Pass fetch: true to refresh.',
          );
        }
        if (scan.freshness.fetched) {
          lines.push('A `git fetch origin` was performed as part of this call.');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error allocating next task ID: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
