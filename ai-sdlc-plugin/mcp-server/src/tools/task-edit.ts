import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { applyTaskEdit, readFrontmatterScalar } from '../lib/backlog-frontmatter.js';

/**
 * MCP tool: `task_edit` — drop-in replacement for `mcp__backlog__task_edit`
 * that preserves unknown frontmatter keys (AISDLC-73).
 *
 * The upstream tool re-serialises the YAML frontmatter from its known
 * schema and silently strips unrecognised keys. That breaks
 * `permittedExternalPaths` (used by `/ai-sdlc execute` for cross-repo
 * write allowlists) on every status flip. This tool mutates only the
 * specific lines / sections the caller asks about; everything else is
 * passed through verbatim.
 */
export function registerTaskEdit(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'task_edit',
    'Edit a Backlog.md task file (status, AC checks, final summary) while preserving unknown frontmatter keys (e.g. permittedExternalPaths). AISDLC-73 fix.',
    {
      id: z.string().describe('Task ID, e.g. "AISDLC-68" (case insensitive)'),
      status: z
        .string()
        .optional()
        .describe('New status value. Common values: "To Do", "In Progress", "Done", "Draft".'),
      acceptanceCriteriaCheck: z
        .array(z.number().int().positive())
        .optional()
        .describe(
          'AC indices (1-based, matching the `#N` markers in the AC list) to flip from `[ ]` to `[x]`.',
        ),
      finalSummary: z
        .string()
        .optional()
        .describe(
          'Markdown content for the "## Final Summary" section. Replaces the section if it exists, otherwise appends it.',
        ),
      updatedDate: z
        .union([z.string(), z.boolean()])
        .optional()
        .describe(
          'Override the auto-stamped `updated_date` frontmatter value. Pass a string for an explicit timestamp, `false` to skip stamping. Defaults to "now" whenever any other field changes.',
        ),
    },
    async ({ id, status, acceptanceCriteriaCheck, finalSummary, updatedDate }) => {
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

        const { path } = located;
        const before = readFileSync(path, 'utf-8');
        const after = applyTaskEdit(before, {
          status,
          acceptanceCriteriaCheck,
          finalSummary,
          updatedDate,
        });

        if (after !== before) {
          writeFileSync(path, after, 'utf-8');
        }

        const summaryParts = [`# task_edit: ${id}`, `Path: ${path}`];
        if (status !== undefined) summaryParts.push(`Status → ${status}`);
        if (acceptanceCriteriaCheck && acceptanceCriteriaCheck.length > 0) {
          summaryParts.push(`Checked ACs: ${acceptanceCriteriaCheck.join(', ')}`);
        }
        if (finalSummary !== undefined)
          summaryParts.push(`Final Summary updated (${finalSummary.length} chars)`);
        if (after === before) summaryParts.push('No changes (no-op)');

        // Surface preserved unknown keys so callers can verify the fix.
        const preserved = readFrontmatterScalar(after, 'permittedExternalPaths');
        if (preserved !== undefined) {
          summaryParts.push(`permittedExternalPaths preserved: ${preserved}`);
        }

        return { content: [{ type: 'text' as const, text: summaryParts.join('\n') }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error editing task ${id}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── Internals (exported for tests) ─────────────────────────────────────

export interface LocatedTask {
  path: string;
  /** `tasks` for open tasks, `completed` for archived. */
  bucket: 'tasks' | 'completed';
}

/**
 * Resolve a task ID (e.g. `AISDLC-68`) to a file under
 * `<projectDir>/backlog/{tasks,completed}/`. Matches case-insensitively
 * against the filename prefix (Backlog.md filenames look like
 * `aisdlc-68 - <slug>.md`).
 */
export function locateTaskFile(projectDir: string, id: string): LocatedTask | undefined {
  const idLower = id.toLowerCase();
  const buckets: Array<{ dir: string; bucket: 'tasks' | 'completed' }> = [
    { dir: join(projectDir, 'backlog', 'tasks'), bucket: 'tasks' },
    { dir: join(projectDir, 'backlog', 'completed'), bucket: 'completed' },
  ];
  for (const { dir, bucket } of buckets) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const lower = entry.toLowerCase();
      if (lower.startsWith(`${idLower} `) || lower.startsWith(`${idLower}.`)) {
        return { path: join(dir, entry), bucket };
      }
    }
  }
  return undefined;
}
