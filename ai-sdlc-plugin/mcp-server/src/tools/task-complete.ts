import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { applyTaskEdit } from '../lib/backlog-frontmatter.js';
import { locateTaskFile } from './task-edit.js';

/**
 * MCP tool: `task_complete` — drop-in replacement for
 * `mcp__backlog__task_complete` that preserves unknown frontmatter keys
 * (AISDLC-73).
 *
 * Flips `status: Done`, optionally appends a `## Final Summary` section,
 * then physically moves the file from `backlog/tasks/` to
 * `backlog/completed/`. Like the upstream tool, but it does NOT
 * re-serialise unknown frontmatter keys (the bug).
 */
export function registerTaskComplete(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'task_complete',
    'Mark a Backlog.md task Done and move it from backlog/tasks/ to backlog/completed/, preserving unknown frontmatter keys. AISDLC-73 fix.',
    {
      id: z.string().describe('Task ID, e.g. "AISDLC-68" (case insensitive)'),
      finalSummary: z
        .string()
        .optional()
        .describe('Markdown content for the "## Final Summary" section.'),
      updatedDate: z
        .union([z.string(), z.boolean()])
        .optional()
        .describe('Override the auto-stamped `updated_date` value (string), or `false` to skip.'),
    },
    async ({ id, finalSummary, updatedDate }) => {
      try {
        const located = locateTaskFile(deps.projectDir, id);
        if (!located) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task ${id} not found under ${join(deps.projectDir, 'backlog')}/{tasks,completed}/`,
              },
            ],
            isError: true,
          };
        }

        // Idempotent: if it's already in completed/, just touch the
        // status + summary (no rename).
        if (located.bucket === 'completed') {
          const before = readFileSync(located.path, 'utf-8');
          const after = applyTaskEdit(before, {
            status: 'Done',
            finalSummary,
            updatedDate,
          });
          if (after !== before) writeFileSync(located.path, after, 'utf-8');
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  `# task_complete: ${id} (already in backlog/completed/)`,
                  `Path: ${located.path}`,
                  after === before ? 'No changes (idempotent no-op)' : 'Status / summary refreshed',
                ].join('\n'),
              },
            ],
          };
        }

        // 1) Apply the edit (status: Done + optional summary), then
        // 2) move the file. Doing it in this order keeps the operation
        // atomic from the caller's perspective — if the rename fails
        // (e.g. EACCES on completed/), the source file is left in the
        // updated state and the next retry will pick it up.
        const before = readFileSync(located.path, 'utf-8');
        const after = applyTaskEdit(before, {
          status: 'Done',
          finalSummary,
          updatedDate,
        });
        if (after !== before) writeFileSync(located.path, after, 'utf-8');

        const completedDir = join(deps.projectDir, 'backlog', 'completed');
        if (!existsSync(completedDir)) mkdirSync(completedDir, { recursive: true });

        const filename = basename(located.path);
        const destPath = join(completedDir, filename);

        // Refuse to clobber an existing file in completed/.
        if (existsSync(destPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Refusing to clobber existing file at ${destPath}. Resolve manually.`,
              },
            ],
            isError: true,
          };
        }

        // Ensure the parent of the destination exists (the dirname call
        // is defensive — completedDir was just mkdir'd, but if the user
        // passed an unusual project layout we still want to create it).
        mkdirSync(dirname(destPath), { recursive: true });
        renameSync(located.path, destPath);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `# task_complete: ${id}`,
                `Moved: ${located.path}`,
                `   → : ${destPath}`,
                `Status: Done`,
                finalSummary !== undefined
                  ? `Final Summary set (${finalSummary.length} chars)`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error completing task ${id}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
