/**
 * `cli-task-complete` — atomic backlog task completion helper (AISDLC-203).
 *
 * Shared helper that performs an authoritative move (NOT a copy) of a task
 * file from `backlog/tasks/<taskId> - *.md` to `backlog/completed/<same-name>.md`,
 * patches the frontmatter status to `Done`, and verifies post-move that the
 * task ID resolves to exactly ONE location.
 *
 * Problem solved: Codex workflows (and any other agent-driven path that doesn't
 * go through `/ai-sdlc execute`) were copying the completed file without
 * deleting the original. This caused the same task ID to appear in BOTH
 * `backlog/tasks/` and `backlog/completed/`, breaking backlog status queries
 * and risking redispatch of already-completed work (AISDLC-175, 181, 184,
 * 191, 197, 201, 203).
 *
 * Usage:
 *   node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203
 *   node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203 --work-dir /abs/path/to/repo
 *
 * Exit codes:
 *   0 — task moved (or already in completed/ — idempotent no-op with --allow-already-done)
 *   1 — error (malformed ID, file not found, duplicate detected)
 *   2 — task already in completed/ (default, exit 0 with --allow-already-done)
 *
 * @module cli/complete-task
 */

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Types ─────────────────────────────────────────────────────────────

export interface CompleteTaskResult {
  taskId: string;
  from: string;
  to: string;
  verified: true;
  alreadyDone: false;
}

export interface AlreadyDoneResult {
  taskId: string;
  location: string;
  alreadyDone: true;
}

export type CompleteTaskOutcome = CompleteTaskResult | AlreadyDoneResult;

export class DuplicateTaskFileError extends Error {
  readonly taskId: string;
  readonly tasksPath: string;
  readonly completedPath: string;

  constructor(taskId: string, tasksPath: string, completedPath: string) {
    super(
      `[cli-task-complete] DUPLICATE DETECTED: ${taskId} exists in BOTH backlog locations.\n` +
        `  tasks/:     ${tasksPath}\n` +
        `  completed/: ${completedPath}\n` +
        `Remove the tasks/ copy manually (or via a lifecycle-close PR) before proceeding.`,
    );
    this.name = 'DuplicateTaskFileError';
    this.taskId = taskId;
    this.tasksPath = tasksPath;
    this.completedPath = completedPath;
  }
}

// ── Core helper ───────────────────────────────────────────────────────

/**
 * Locate `<dir>/<idLower> - *.md` (Backlog.md filename convention).
 * Returns the absolute path when found, null otherwise.
 */
function findFileInDir(dir: string, idLower: string): string | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${idLower} -`;
  const match = entries.find((name) => name.toLowerCase().startsWith(prefix));
  return match ? join(dir, match) : null;
}

/**
 * Patch `status: <anything>` in the first YAML frontmatter block to `Done`.
 * Pure — does not touch the disk; caller is responsible for writing.
 */
function patchStatusDone(raw: string): string {
  let inFm = false;
  let fmCount = 0;
  return raw
    .split('\n')
    .map((line) => {
      if (line === '---') {
        fmCount++;
        if (fmCount === 1) inFm = true;
        else if (fmCount === 2) inFm = false;
        return line;
      }
      if (inFm && /^status:/.test(line)) {
        return 'status: Done';
      }
      return line;
    })
    .join('\n');
}

/**
 * Perform an atomic task completion:
 *   1. Locate the task file in `backlog/tasks/`.
 *   2. If already in `backlog/completed/` only → return AlreadyDoneResult.
 *   3. If in BOTH → throw DuplicateTaskFileError.
 *   4. Patch frontmatter status to Done.
 *   5. Move (NOT copy) from tasks/ → completed/.
 *   6. Verify post-move that the file exists in completed/ and NOT in tasks/.
 *   7. Return CompleteTaskResult.
 *
 * @param taskId  Task ID (e.g. "AISDLC-203"). Case-insensitive.
 * @param workDir Repo root directory containing `backlog/`. Defaults to `process.cwd()`.
 */
export function completeTaskAtomically(
  taskId: string,
  workDir: string = process.cwd(),
): CompleteTaskOutcome {
  const idLower = taskId.toLowerCase();
  const tasksDir = join(workDir, 'backlog', 'tasks');
  const completedDir = join(workDir, 'backlog', 'completed');

  const tasksFile = findFileInDir(tasksDir, idLower);
  const completedFile = findFileInDir(completedDir, idLower);

  // Duplicate detection (both exist) — throw immediately.
  if (tasksFile !== null && completedFile !== null) {
    throw new DuplicateTaskFileError(taskId, tasksFile, completedFile);
  }

  // Already done — idempotent.
  if (completedFile !== null) {
    return { taskId, location: completedFile, alreadyDone: true };
  }

  // Not found anywhere.
  if (tasksFile === null) {
    throw new Error(
      `[cli-task-complete] Task file not found for ${taskId} under ${tasksDir}\n` +
        `Ensure the file exists with a name matching "${idLower} - *.md".`,
    );
  }

  // Patch status to Done.
  const raw = readFileSync(tasksFile, 'utf8');
  const patched = patchStatusDone(raw);
  writeFileSync(tasksFile, patched, 'utf8');

  // Ensure destination dir exists.
  mkdirSync(completedDir, { recursive: true });

  // Atomic move.
  const fileName = tasksFile.split('/').at(-1)!;
  const destPath = join(completedDir, fileName);
  renameSync(tasksFile, destPath);

  // Post-move verification.
  if (!existsSync(destPath)) {
    throw new Error(
      `[cli-task-complete] Move appeared to succeed but ${destPath} does not exist post-move.`,
    );
  }
  if (existsSync(tasksFile)) {
    throw new DuplicateTaskFileError(taskId, tasksFile, destPath);
  }

  return { taskId, from: tasksFile, to: destPath, verified: true, alreadyDone: false };
}

// ── yargs CLI router ──────────────────────────────────────────────────

export function buildCompleteTaskCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-task-complete')
    .usage(
      'Usage: $0 <task-id> [options]\n\n' +
        '  Atomically moves a backlog task from tasks/ to completed/,\n' +
        '  patching the frontmatter status to Done.\n\n' +
        '  node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203\n' +
        '  node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203 --work-dir /repo',
    )
    .option('work-dir', {
      alias: 'w',
      type: 'string',
      describe: 'Repo root (default: cwd).',
      default: process.cwd(),
    })
    .option('allow-already-done', {
      type: 'boolean',
      default: false,
      describe: 'Exit 0 instead of 2 when the task is already in completed/.',
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json'] as const,
      default: 'text' as const,
      describe: 'Output format.',
    })
    .command(
      '$0 <task-id>',
      'Complete a backlog task atomically',
      (y) =>
        y.positional('task-id', {
          type: 'string',
          describe: 'Backlog task ID (e.g. AISDLC-203).',
          demandOption: true,
        }),
      (argv) => {
        const taskId = String(argv['task-id']);
        const workDir = String(argv['work-dir']);
        const format = String(argv.format) as 'text' | 'json';
        const allowAlreadyDone = Boolean(argv['allow-already-done']);

        let result: CompleteTaskOutcome;
        try {
          result = completeTaskAtomically(taskId, workDir);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (format === 'json') {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
          } else {
            process.stderr.write(msg + '\n');
          }
          process.exit(1);
        }

        if (result.alreadyDone) {
          const msg = `[cli-task-complete] ${taskId} already in backlog/completed/ — no-op.`;
          if (format === 'json') {
            process.stdout.write(
              JSON.stringify({ ok: true, alreadyDone: true, location: result.location }, null, 2) +
                '\n',
            );
          } else {
            process.stdout.write(msg + '\n');
          }
          process.exit(allowAlreadyDone ? 0 : 2);
        }

        if (format === 'json') {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                alreadyDone: false,
                taskId: result.taskId,
                from: result.from,
                to: result.to,
                verified: result.verified,
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `[cli-task-complete] ${taskId}: moved\n` +
              `  from: ${result.from}\n` +
              `  to:   ${result.to}\n` +
              `  verified: OK\n`,
          );
        }
        process.exit(0);
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runCompleteTaskCli(): Promise<void> {
  await buildCompleteTaskCli().parseAsync();
}
