import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { pickProjectRoot } from './task-edit.js';
import {
  computeNextFreeBlock,
  findUnscannedRequiredSources,
  prefetchOrigin,
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
      allowUnscannedSources: z
        .boolean()
        .optional()
        .describe(
          'Allocate even when a required source (git-refs) could not be scanned. ' +
            'Defaults to false: without git-refs the scan cannot see unmerged or remote ' +
            'branches, so allocating risks handing out an ID that is already taken. ' +
            'Set true ONLY for a repo with no git history yet.',
        ),
    },
    async ({ prefix, count, fetch, allowUnscannedSources }) => {
      try {
        const projectDir = pickProjectRoot(deps.projectDir);
        if (typeof projectDir !== 'string') return projectDir; // error result

        const resolvedPrefix = prefix ?? DEFAULT_TASK_ID_PREFIX;
        const lockRoot = resolveParentRepoRoot(projectDir) ?? projectDir;

        // AISDLC-559 review (MAJOR): fetch OUTSIDE the lock. A slow `git fetch`
        // inside the critical section could outrun the stale threshold, letting
        // a second caller steal the lock — producing the two-holders race the
        // lock exists to prevent.
        if (fetch) prefetchOrigin(projectDir);

        const lock = await acquireTaskIdLock(lockRoot);
        let scan;
        try {
          scan = scanClaimedTaskIds({ projectDir, prefix: resolvedPrefix, fetch: false });
        } finally {
          lock.release();
        }

        // AISDLC-559 review (CRITICAL): fail CLOSED. Previously a failed
        // git-refs scan was reported as advisory text below a confidently
        // allocated ID — so the one source covering unmerged and remote
        // branches could silently drop out and the tool would hand back a
        // number that is already claimed. That is the exact bug this tool exists
        // to prevent, so refuse unless the caller explicitly accepts the risk.
        const unscanned = findUnscannedRequiredSources(scan.sourceReports);
        if (unscanned.length > 0 && !allowUnscannedSources) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `# next_task_id: REFUSED — cannot guarantee a free ID\n\n` +
                  unscanned
                    .map((r) => `- ${r.source}: NOT scanned (${r.detail ?? 'unknown reason'})`)
                    .join('\n') +
                  `\n\nWithout git-refs this scan cannot see IDs claimed on unmerged or ` +
                  `remote branches, so any ID returned could already be taken.\n` +
                  `Fix the underlying cause, or pass allowUnscannedSources: true if this ` +
                  `repo genuinely has no git history yet.`,
              },
            ],
          };
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
