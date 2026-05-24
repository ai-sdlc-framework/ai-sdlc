/**
 * Backlog task writer for the spec-kit bridge.
 *
 * RFC-0036 Phase 4 (AISDLC-329). Translates a parsed `SpecKitTaskEntry`
 * into a backlog task file with `specRef:` frontmatter pointing back to
 * the upstream spec-kit `tasks.md` row.
 *
 * ID allocation mirrors the convention in `reference/src/adapters/backlog-md`
 * (`<PREFIX>-<N+1>` where N is the highest existing numeric suffix). Kept
 * inline here rather than importing the adapter package because pipeline-cli
 * has no workspace dependency on `reference/`.
 *
 * Filename + slug rules mirror `ai-sdlc-plugin/mcp-server/src/tools/task-create.ts`
 * so generated tasks are indistinguishable from operator-authored tasks
 * once the import lands.
 *
 * @module import-spec/task-writer
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { SpecKitTaskEntry } from './parser.js';

export interface SpecRef {
  source: 'spec-kit';
  featureId: string;
  taskId: string;
  artifactPath: string;
  importedAt: string;
}

export interface WriteTaskOpts {
  /** Project root (must contain `backlog/`). */
  workDir: string;
  /** Task ID prefix — defaults to `IMP` to avoid collision with AISDLC-NNN. */
  prefix?: string;
  /** Spec-kit feature id (slug of the spec-kit feature dir). */
  featureId: string;
  /** Path to the spec-kit `tasks.md` (relative to workDir or absolute). */
  artifactPath: string;
  /** Imported-at ISO timestamp. Defaults to `new Date().toISOString()`. */
  importedAt?: string;
}

export interface WrittenTask {
  /** Allocated task id, e.g. `IMP-7`. */
  id: string;
  /** Absolute path of the written file. */
  filePath: string;
  /** Filename only (e.g. `imp-7 - implement-bearer.md`). */
  fileName: string;
  /** Upstream spec-kit task id (e.g. `T-007`). */
  upstreamTaskId: string;
}

const DEFAULT_PREFIX = 'IMP';

/**
 * Compute the next numeric suffix for `<prefix>-<n>` in `<workDir>/backlog/{tasks,completed}`.
 * Returns 1 when no existing task carries the prefix. Idempotent + side-effect free.
 */
export function nextTaskNumber(workDir: string, prefix: string): number {
  const pattern = new RegExp(`^${escapeRegExp(prefix).toLowerCase()}-(\\d+)`, 'i');
  let max = 0;
  for (const bucket of ['tasks', 'completed']) {
    const dir = join(workDir, 'backlog', bucket);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(pattern);
      if (!m) continue;
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Translate a spec-kit task entry into a backlog task file. Returns the
 * metadata about the written file so the import path can include it in
 * its summary output.
 *
 * Refuses to overwrite an existing file — the caller picks a higher
 * numeric suffix via {@link nextTaskNumber} first.
 */
export function writeBacklogTaskFromSpecKitEntry(
  entry: SpecKitTaskEntry,
  opts: WriteTaskOpts,
): WrittenTask {
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  ensurePrefixShape(prefix);

  const num = nextTaskNumber(opts.workDir, prefix);
  const id = `${prefix}-${num}`;
  const slug = slugify(entry.title);
  const fileName = `${id.toLowerCase()} - ${slug}.md`;
  const tasksDir = join(opts.workDir, 'backlog', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const filePath = join(tasksDir, fileName);

  // Defense-in-depth: assert the resolved path stays inside tasksDir.
  if (!resolve(filePath).startsWith(resolve(tasksDir) + sep)) {
    throw new Error(
      `[import-spec] refusing to write outside tasks dir: ${filePath} not under ${tasksDir}`,
    );
  }

  if (existsSync(filePath)) {
    throw new Error(`[import-spec] refusing to overwrite existing task file: ${filePath}`);
  }

  const specRef: SpecRef = {
    source: 'spec-kit',
    featureId: opts.featureId,
    taskId: entry.taskId,
    artifactPath: opts.artifactPath,
    importedAt: opts.importedAt ?? new Date().toISOString(),
  };

  const content = renderTaskMarkdown(id, entry, specRef);
  writeFileSync(filePath, content, 'utf8');
  return { id, filePath, fileName, upstreamTaskId: entry.taskId };
}

/**
 * Build the markdown content for the generated task file. Frontmatter
 * follows the AISDLC-234 `task-create` MCP shape; the `specRef:` block
 * is the RFC-0036 Phase 4 addition.
 */
export function renderTaskMarkdown(id: string, entry: SpecKitTaskEntry, specRef: SpecRef): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${id}`);
  lines.push(`title: ${formatYamlString(entry.title)}`);
  lines.push("status: 'To Do'");
  lines.push('assignee: []');
  lines.push('labels:');
  lines.push('  - imported-from-spec-kit');
  lines.push('  - rfc-0036');
  lines.push('dependencies: []');
  lines.push('references:');
  lines.push(`  - ${formatYamlString(specRef.artifactPath)}`);
  lines.push('specRef:');
  lines.push(`  source: ${specRef.source}`);
  lines.push(`  featureId: ${formatYamlString(specRef.featureId)}`);
  lines.push(`  taskId: ${formatYamlString(specRef.taskId)}`);
  lines.push(`  artifactPath: ${formatYamlString(specRef.artifactPath)}`);
  lines.push(`  importedAt: '${specRef.importedAt}'`);
  lines.push('---');
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push('<!-- SECTION:DESCRIPTION:BEGIN -->');
  if (entry.body) {
    lines.push(entry.body);
  } else {
    lines.push(
      `Imported from spec-kit \`${specRef.artifactPath}\` (feature \`${specRef.featureId}\`, upstream \`${specRef.taskId}\`).`,
    );
  }
  lines.push('<!-- SECTION:DESCRIPTION:END -->');
  lines.push('');
  lines.push('## Acceptance Criteria');
  lines.push('');
  lines.push('<!-- AC:BEGIN -->');
  if (entry.acceptanceCriteria.length === 0) {
    lines.push('- [ ] (no acceptance criteria extracted from upstream — review needed)');
  } else {
    entry.acceptanceCriteria.forEach((ac, idx) => {
      lines.push(`- [ ] #${idx + 1} ${ac}`);
    });
  }
  lines.push('<!-- AC:END -->');
  lines.push('');
  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a task title into a URL-safe ASCII slug. Mirrors the
 * `slugify` helper in `ai-sdlc-plugin/mcp-server/src/tools/task-create.ts`
 * so import-spec output matches operator-authored task filenames.
 */
export function slugify(title: string): string {
  return title
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PREFIX_RE = /^[A-Z][A-Z0-9]{1,15}$/;
function ensurePrefixShape(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(
      `[import-spec] invalid task prefix: ${prefix} — must be 2-16 uppercase ASCII chars starting with a letter`,
    );
  }
}
