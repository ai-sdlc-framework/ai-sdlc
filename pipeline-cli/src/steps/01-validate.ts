/**
 * Step 1 — Validate the task spec.
 *
 * Reads the backlog task file from `<workDir>/backlog/tasks/<taskid> -*.md`,
 * parses YAML frontmatter (+ AC checkboxes from the body), and applies the
 * RFC-0012 §5.4 / `execute-orchestrator.md` Step 1 acceptance gates:
 *
 *  - Status MUST be `To Do` or `In Progress` (not `Draft`, not `Done`).
 *  - At least one acceptance criterion MUST exist.
 *  - Reject the "stale-Done" shape (status=In Progress with all ACs checked).
 *
 * Pure: only reads from disk via `node:fs`. No git / network calls.
 *
 * @module steps/01-validate
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { TaskSpec, ValidateResult } from '../types.js';

export interface ValidateTaskOptions {
  taskId: string;
  workDir: string;
  /**
   * AISDLC-373 — explicit task-file path override. When set, validateTask
   * skips the `<workDir>/backlog/tasks/<id-lower> - *.md` scan and uses this
   * path directly. The path is verified to exist (returns the standard
   * `no task file for <id>` reason when missing) so callers still get the
   * unified rejection envelope. Used by the single-PR `--task-from-file`
   * orchestrator flow where the task file is inside a worktree subtree
   * the default scan never visits.
   */
  taskFilePathOverride?: string;
}

/** Locate `<workDir>/backlog/tasks/<id-lower> - *.md`. Case-insensitive ID match. */
export function findTaskFile(taskId: string, workDir: string): string | null {
  const tasksDir = join(workDir, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return null;
  const lower = taskId.toLowerCase();
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return null;
  }
  // Match files starting with "<lower> -" (Backlog.md filename convention).
  const prefix = `${lower} -`;
  const match = entries.find((name) => name.toLowerCase().startsWith(prefix));
  return match ? join(tasksDir, match) : null;
}

/**
 * Parse a backlog task file into a TaskSpec. Tolerant of unknown frontmatter
 * keys — those are kept on the raw body text but not surfaced on TaskSpec.
 */
export function parseTaskFile(filePath: string): TaskSpec {
  const raw = readFileSync(filePath, 'utf8');

  // Frontmatter is between the first two `---` delimiters.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`Task file ${filePath} missing YAML frontmatter`);
  }
  const fmRaw = fmMatch[1];
  const body = fmMatch[2];

  const fm = parseSimpleYaml(fmRaw);

  // AC list is parsed from `- [ ] #N <text>` / `- [x] #N <text>` lines in the body.
  const acRe = /^- \[( |x|X)\] (?:#(\d+) )?(.*)$/gm;
  const acs: string[] = [];
  const acsChecked: boolean[] = [];
  let m: RegExpExecArray | null;
  while ((m = acRe.exec(body)) !== null) {
    acs.push(m[3].trim());
    acsChecked.push(m[1].toLowerCase() === 'x');
  }

  // Description block — between `## Description` and the next `##` (best effort).
  const descMatch = body.match(/##\s+Description\s*\n([\s\S]*?)(?=\n##\s|$)/);
  const description = descMatch
    ? descMatch[1]
        .replace(/<!--\s*SECTION:DESCRIPTION:BEGIN\s*-->/g, '')
        .replace(/<!--\s*SECTION:DESCRIPTION:END\s*-->/g, '')
        .trim()
    : '';

  const id = String(fm.id ?? '').trim();
  const title = String(fm.title ?? '').trim();
  const status = String(fm.status ?? '').trim();

  let permittedExternalPaths: string[] | undefined;
  if (Array.isArray(fm.permittedExternalPaths)) {
    permittedExternalPaths = (fm.permittedExternalPaths as unknown[]).map(String);
  }
  let references: string[] | undefined;
  if (Array.isArray(fm.references)) {
    references = (fm.references as unknown[]).map(String);
  }

  return {
    id,
    title,
    status,
    acceptanceCriteria: acs,
    acceptanceCriteriaChecked: acsChecked,
    permittedExternalPaths,
    references,
    description,
    rawBody: body,
    filePath,
  };
}

/**
 * Parse a YAML frontmatter block into a flat `Record<string, unknown>`.
 *
 * Backed by `js-yaml` (vs. the line-based regex parser that previously lived
 * here, AISDLC-180) so block-scalar titles (`title: >- \n  long wrapped …`)
 * decode to the actual string instead of capturing the indicator literal
 * `>-` as the value. The slug computer in `02-compute-branch.ts` and the
 * `cli-deps frontier` display both depended on this — the regex parser
 * silently produced empty slugs and stripped frontier titles to `>-`.
 *
 * Returns `{}` for empty / whitespace-only input or when the document parses
 * to a non-object scalar (e.g. a bare string), so callers can keep treating
 * the result as a key-lookup map without a typeof guard. Throws on YAML
 * syntax errors — call sites already wrap parse failures in `try/catch` and
 * surface a `failed to parse task file` reason.
 *
 * Lists of nested objects (e.g. `externalDependencies:`) ARE returned via
 * js-yaml as arrays of `Record<string, unknown>`, so the dedicated walker
 * in `parseExternalDependenciesBlock` is no longer strictly necessary —
 * left in place for backwards-compat while RFC-0014 callers migrate.
 */
export function parseSimpleYaml(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch (err) {
    throw new Error(`YAML parse error: ${(err as Error).message}`, { cause: err });
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export async function validateTask(opts: ValidateTaskOptions): Promise<ValidateResult> {
  // AISDLC-373 — honour the explicit path override before falling back to
  // the default backlog/tasks scan. The override path must exist on disk;
  // a missing override is treated identically to a missing default-scan
  // file so callers see one consistent rejection shape.
  const filePath =
    opts.taskFilePathOverride && existsSync(opts.taskFilePathOverride)
      ? opts.taskFilePathOverride
      : findTaskFile(opts.taskId, opts.workDir);
  if (!filePath) {
    return { ok: false, reason: `no task file for ${opts.taskId}` };
  }

  let task: TaskSpec;
  try {
    task = parseTaskFile(filePath);
  } catch (err) {
    return { ok: false, reason: `failed to parse task file: ${(err as Error).message}` };
  }

  if (task.status === 'Done') {
    return { ok: false, reason: `status is 'Done' — already shipped`, task };
  }
  if (task.status === 'Draft') {
    return { ok: false, reason: `status is 'Draft' — task not ready for execution`, task };
  }
  if (task.status === 'Needs Clarification') {
    // RFC-0011 §7.3 + Phase 4 (AISDLC-115.5) — refuse with a pointer to
    // the DoR clarification comment in the task body so the operator can
    // resolve before re-running. The actual gate list / link is rendered
    // by `refusalMessage()` in `pipeline-cli/src/dor/ingress-claude.ts`
    // when the slash command body has access to the loaded verdict; here
    // we surface a stable reason string the slash command reuses verbatim.
    return {
      ok: false,
      reason: [
        `status is 'Needs Clarification' — task blocked by the Definition-of-Ready gate (RFC-0011).`,
        `See the DoR clarification thread in the task file (look for the`,
        `'<!-- ai-sdlc:dor-comment -->' marker) and address the questions, then re-run.`,
      ].join(' '),
      task,
    };
  }
  if (task.status !== 'To Do' && task.status !== 'In Progress') {
    return {
      ok: false,
      reason: `unexpected status "${task.status}" — expected 'To Do' or 'In Progress'`,
      task,
    };
  }

  if (task.acceptanceCriteria.length === 0) {
    return { ok: false, reason: 'task has no acceptance criteria', task };
  }

  // Stale-Done shape — In Progress with every AC ticked.
  if (
    task.status === 'In Progress' &&
    task.acceptanceCriteriaChecked.length === task.acceptanceCriteria.length &&
    task.acceptanceCriteriaChecked.every((c) => c)
  ) {
    return {
      ok: false,
      reason:
        "stale-Done shape: status='In Progress' with all acceptance criteria checked — needs triage",
      task,
    };
  }

  return { ok: true, task };
}
