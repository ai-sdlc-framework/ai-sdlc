import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { pickProjectRoot } from './task-edit.js';

/**
 * MCP tool: `task_create` — Pattern C-aware alternative to `mcp__backlog__task_create`.
 *
 * The upstream `mcp__backlog__task_create` tool writes to the project the MCP
 * server resolved at startup, which in a Pattern C setup (non-bare parent repo +
 * `.worktrees/<task-id>/` isolates) is the parent's read-only working tree.
 * Files written there are `git reset --hard`'d on the next dispatch, causing
 * silent work loss.
 *
 * This tool applies the same Pattern C routing as `task_edit` and `task_complete`
 * (AISDLC-216) so the new task file lands in the correct worktree (or the project
 * root for non-Pattern-C projects).
 *
 * Input schema mirrors `mcp__backlog__task_create`. (AISDLC-234)
 */
export function registerTaskCreate(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'task_create',
    'Create a new Backlog.md task file in the correct location — Pattern C-aware (writes to the active worktree, not the parent read-only tree). Mirrors mcp__backlog__task_create schema. AISDLC-234.',
    {
      id: z.string().describe('Task ID, e.g. "AISDLC-234" (must be unique in backlog/)'),
      title: z.string().describe('Human-readable task title'),
      description: z
        .string()
        .optional()
        .describe('Markdown body content for the task (placed after frontmatter)'),
      status: z.string().optional().describe('Initial status. Defaults to "To Do".'),
      priority: z
        .enum(['critical', 'high', 'medium', 'low'])
        .optional()
        .describe('Task priority level.'),
      labels: z.array(z.string()).optional().describe('List of label strings to attach.'),
      dependencies: z
        .array(z.string())
        .optional()
        .describe('List of task IDs this task depends on (e.g. ["AISDLC-100"]).'),
      references: z
        .array(z.string())
        .optional()
        .describe('List of file paths or URLs relevant to this task.'),
    },
    async ({ id, title, description, status, priority, labels, dependencies, references }) => {
      try {
        // Resolve the project root (Pattern C-aware). Prefer injected deps.projectDir
        // when it has a backlog/ dir (test-friendly), otherwise use the env+cwd
        // resolver which handles Pattern C routing (AISDLC-216).
        const projectDir = pickProjectRoot(deps.projectDir);
        if (typeof projectDir !== 'string') return projectDir; // error result

        const tasksDir = join(projectDir, 'backlog', 'tasks');

        // Ensure backlog/tasks/ exists.
        if (!existsSync(tasksDir)) {
          mkdirSync(tasksDir, { recursive: true });
        }

        // Refuse if a file for this task ID already exists (tasks/ or completed/)
        // so we don't silently clobber existing work.
        const existing = findExistingTaskFile(projectDir, id);
        if (existing) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Task ${id} already exists at ${existing}. ` +
                  `Use task_edit to modify it or choose a different ID.`,
              },
            ],
            isError: true,
          };
        }

        // Frontmatter validation: check references resolve (early failure, mirrors
        // the backlog-drift gate checks for newly created tasks).
        const badRefs = validateReferences(references ?? [], projectDir);
        if (badRefs.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `References validation failed for ${id}:\n` +
                  badRefs.map((r) => `  - ${r}`).join('\n') +
                  '\n\nFix the references or omit them, then retry.',
              },
            ],
            isError: true,
          };
        }

        const resolvedStatus = status ?? 'To Do';
        const slug = slugify(title);
        const filename = `${id.toLowerCase()} - ${slug}.md`;
        const filePath = join(tasksDir, filename);

        const content = buildTaskContent({
          id,
          title,
          description,
          status: resolvedStatus,
          priority,
          labels,
          dependencies,
          references,
        });

        writeFileSync(filePath, content, 'utf-8');

        const summaryParts = [
          `# task_create: ${id}`,
          `Path: ${filePath}`,
          `Title: ${title}`,
          `Status: ${resolvedStatus}`,
        ];
        if (priority) summaryParts.push(`Priority: ${priority}`);
        if (labels && labels.length > 0) summaryParts.push(`Labels: ${labels.join(', ')}`);
        if (dependencies && dependencies.length > 0)
          summaryParts.push(`Dependencies: ${dependencies.join(', ')}`);
        if (references && references.length > 0)
          summaryParts.push(`References: ${references.join(', ')}`);

        return { content: [{ type: 'text' as const, text: summaryParts.join('\n') }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating task ${id}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── Internals (exported for tests) ─────────────────────────────────────

/**
 * Convert a task title into a URL-safe ASCII slug for use in filenames.
 * Matches the style Backlog.md uses for its own file naming.
 */
export function slugify(title: string): string {
  return title
    .trim()
    .replace(/[^\w\s-]/g, '') // strip non-word chars except hyphens
    .replace(/\s+/g, '-') // spaces → hyphens
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-|-$/g, '') // strip leading/trailing hyphens
    .slice(0, 60); // reasonable filename length cap
}

/**
 * Check whether any task file for `id` already exists in backlog/tasks/ or
 * backlog/completed/. Returns the path if found, undefined otherwise.
 */
export function findExistingTaskFile(projectDir: string, id: string): string | undefined {
  const idLower = id.toLowerCase();
  const bucketDirs = [
    join(projectDir, 'backlog', 'tasks'),
    join(projectDir, 'backlog', 'completed'),
  ];
  for (const dir of bucketDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const lower = entry.toLowerCase();
      if (lower.startsWith(`${idLower} `) || lower.startsWith(`${idLower}.`)) {
        return join(dir, entry);
      }
    }
  }
  return undefined;
}

/**
 * Validate that `references` are resolvable paths within `projectDir`.
 * URLs (http/https) are accepted without filesystem checks.
 * Returns an array of error strings for each bad reference (empty = all good).
 *
 * This is a shallow check (existence only) matching the drift gate's
 * early-failure semantics for the create path. The full drift gate
 * (`backlog-drift`) runs on commit and catches deeper issues.
 */
export function validateReferences(references: string[], projectDir: string): string[] {
  const errors: string[] = [];
  for (const ref of references) {
    if (/^https?:\/\//i.test(ref)) continue; // URLs are always accepted
    const absPath = join(projectDir, ref);
    if (!existsSync(absPath)) {
      errors.push(`${ref} — file not found at ${absPath}`);
    }
  }
  return errors;
}

interface TaskCreateOptions {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  labels?: string[];
  dependencies?: string[];
  references?: string[];
}

/**
 * Build the full Markdown content for a new task file.
 *
 * The frontmatter format matches Backlog.md's own output so diffs are clean
 * and the drift gate parses it correctly.
 */
export function buildTaskContent(opts: TaskCreateOptions): string {
  const now = nowStamp();
  const lines: string[] = ['---', `id: ${opts.id}`, `title: ${formatYamlString(opts.title)}`];

  lines.push(`status: ${formatYamlString(opts.status)}`);

  if (opts.priority) {
    lines.push(`priority: ${opts.priority}`);
  }

  lines.push(`created_date: '${now}'`);
  lines.push(`updated_date: '${now}'`);

  if (opts.labels && opts.labels.length > 0) {
    lines.push('labels:');
    for (const label of opts.labels) {
      lines.push(`  - ${formatYamlString(label)}`);
    }
  } else {
    lines.push('labels: []');
  }

  if (opts.dependencies && opts.dependencies.length > 0) {
    lines.push('dependencies:');
    for (const dep of opts.dependencies) {
      lines.push(`  - ${dep}`);
    }
  } else {
    lines.push('dependencies: []');
  }

  if (opts.references && opts.references.length > 0) {
    lines.push('references:');
    for (const ref of opts.references) {
      lines.push(`  - ${formatYamlString(ref)}`);
    }
  }

  lines.push('---', '');

  if (opts.description) {
    lines.push(opts.description, '');
  }

  return lines.join('\n');
}

/**
 * Format a YAML string value. Quotes with single quotes when the value
 * contains characters that would be ambiguous in bare YAML.
 * Matches the quoting logic in `backlog-frontmatter.ts` for consistency.
 */
function formatYamlString(value: string): string {
  if (needsQuoting(value)) {
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  return value;
}

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (/^[\s!&*?|>%@`#,[\]{}'"-]/.test(value)) return true;
  if (/[:#]/.test(value)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

function nowStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}
