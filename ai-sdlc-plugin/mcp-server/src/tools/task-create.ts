import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { pickProjectRoot } from './task-edit.js';
import {
  type ClaimSource,
  resolveParentRepoRoot,
  findUnscannedRequiredSources,
  scanClaimedTaskIds,
} from '../lib/task-id-scanner.js';
import { acquireTaskIdLock } from '../lib/task-id-lock.js';

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
        // Major 1 (security): validate `id` shape before interpolating into filesystem paths.
        // Reject any ID that doesn't match the project convention (AISDLC-N, AISDLC-N.M, etc.)
        // to prevent path traversal via `id: "../../tmp/pwn"` and non-ASCII injection.
        // The regex also enforces ASCII-only (matches check-backlog-ascii.sh gate).
        const ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+(\.\d+)*$/;
        if (!ID_PATTERN.test(id)) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Invalid task ID format: "${id}". ` +
                  `Expected format: PROJECT-N or PROJECT-N.M (e.g. AISDLC-234, AISDLC-234.1). ` +
                  `Only ASCII uppercase letters, digits, and hyphens are permitted.`,
              },
            ],
            isError: true,
          };
        }

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

        // Frontmatter validation: check references resolve (early failure, mirrors
        // the backlog-drift gate checks for newly created tasks). Cheap + doesn't
        // touch the ID collision surface, so it runs outside the lock.
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

        // Defense-in-depth: assert the resolved path stays inside tasksDir.
        // The ID_PATTERN check above is the primary guard; this is a belt-and-suspenders
        // assertion that catches any future code path that bypasses the regex.
        if (!resolve(filePath).startsWith(resolve(tasksDir) + sep)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Security: computed file path "${filePath}" escapes the tasks directory. Operation refused.`,
              },
            ],
            isError: true,
          };
        }

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

        // AISDLC-559: cross-source collision check (git refs across every
        // branch/remote/tag, sibling worktree filesystems, and the current
        // worktree — not just this project dir), guarded by a parent-repo
        // lock spanning the read-then-create window so two parallel sessions
        // can't both observe "free" and both write. The write itself IS the
        // claim: it becomes visible to the next scan's sibling-worktree
        // source (or current-worktree source) immediately, even uncommitted.
        const idMatch = /^([A-Z][A-Z0-9]*)-(\d+)/.exec(id);
        if (!idMatch) {
          // Unreachable given ID_PATTERN above, but keeps this block self-contained.
          return {
            content: [{ type: 'text' as const, text: `Invalid task ID format: "${id}".` }],
            isError: true,
          };
        }
        const [, idPrefix] = idMatch;
        const lockRoot = resolveParentRepoRoot(projectDir) ?? projectDir;

        const lock = await acquireTaskIdLock(lockRoot);
        try {
          const scan = scanClaimedTaskIds({ projectDir, prefix: idPrefix });

          // AISDLC-559 review (CRITICAL): fail CLOSED when a required source
          // could not be scanned. Treating an unscanned git-refs as "no
          // collisions found" is how a duplicate ID gets written for an ID
          // already claimed on an unmerged or remote branch.
          const unscanned = findUnscannedRequiredSources(scan.sourceReports);
          if (unscanned.length > 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Refusing to create ${id}: cannot verify it is unclaimed.\n` +
                    unscanned
                      .map((r) => `  - ${r.source}: NOT scanned (${r.detail ?? 'unknown reason'})`)
                      .join('\n') +
                    `\nWithout git-refs this cannot see IDs claimed on unmerged or remote branches.`,
                },
              ],
              isError: true,
            };
          }

          // AISDLC-559 review (CRITICAL): compare the EXACT id, not the major.
          // Collapsing to the major refused every legitimate new sub-ID —
          // AISDLC-100.6 was rejected merely because AISDLC-100 or a sibling
          // AISDLC-100.5 existed — which breaks the RFC-walkthrough phase-task
          // pattern. Allocation still reserves on the major; only this
          // duplicate check is exact.
          const claimSources = scan.claimedExact.get(id.toLowerCase());
          if (claimSources && claimSources.length > 0) {
            return {
              content: [{ type: 'text' as const, text: buildCollisionMessage(id, claimSources) }],
              isError: true,
            };
          }
          writeFileSync(filePath, content, 'utf-8');
        } finally {
          lock.release();
        }

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
 * Build the refusal message for a cross-source ID collision (AISDLC-559).
 * Names WHERE each conflict was found (which worktree / which ref) so the
 * caller doesn't have to go re-derive it themselves.
 */
export function buildCollisionMessage(id: string, sources: ClaimSource[]): string {
  const lines = [
    `Task ${id} already exists (or was previously claimed) — found in:`,
    ...sources.map((s) => `  - [${s.source}] ${s.detail}`),
    '',
    'Use task_edit to modify it, choose a different ID, or call next_task_id to allocate a fresh one.',
  ];
  return lines.join('\n');
}

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

  // assignee: [] — present on every task file in the repo; keep consistent
  lines.push('assignee: []');

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
      lines.push(`  - ${formatYamlString(dep)}`);
    }
  } else {
    lines.push('dependencies: []');
  }

  if (opts.references && opts.references.length > 0) {
    lines.push('references:');
    for (const ref of opts.references) {
      lines.push(`  - ${formatYamlString(ref)}`);
    }
  } else {
    lines.push('references: []');
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
