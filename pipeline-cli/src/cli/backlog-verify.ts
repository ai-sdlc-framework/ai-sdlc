/**
 * `cli-backlog-verify` — duplicate-task-ID detection gate (AISDLC-203).
 *
 * Walks `backlog/tasks/` and `backlog/completed/`, builds a map of
 * taskId → list of file paths, and exits non-zero when any task ID
 * appears in BOTH directories simultaneously.
 *
 * This is the regression guard that closes the AISDLC-175/181/184/191/197/201/203
 * copy-only completion pattern. Wire it as a pre-push hook gate or CI step:
 *
 *   node pipeline-cli/bin/cli-backlog-verify.mjs
 *   node pipeline-cli/bin/cli-backlog-verify.mjs --work-dir /abs/repo
 *
 * Exit codes:
 *   0 — no duplicates found; every task ID appears in exactly one location
 *   1 — one or more task IDs appear in BOTH directories (list printed to stderr)
 *
 * @module cli/backlog-verify
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Types ─────────────────────────────────────────────────────────────

export interface TaskLocation {
  taskId: string;
  /** Normalised (lowercase) task ID prefix, e.g. `aisdlc-203`. */
  idLower: string;
  /** Relative path from workDir (e.g. `backlog/tasks/aisdlc-203 - ...md`). */
  relativePath: string;
  /** Directory bucket. */
  bucket: 'tasks' | 'completed';
}

export interface VerifyResult {
  ok: boolean;
  /** All task file locations found (including duplicates). */
  locations: TaskLocation[];
  /** Task IDs that appear in BOTH tasks/ and completed/. */
  duplicates: string[];
}

// ── Core logic ────────────────────────────────────────────────────────

/**
 * Extract a normalised task ID from a Backlog.md filename.
 *
 * Convention: `<taskId-lower> - <title-slug>.md`
 * E.g. `aisdlc-203 - codex-workflow-atomic.md` → `aisdlc-203`
 *
 * Returns null when the filename doesn't match the convention.
 */
export function extractTaskIdFromFilename(filename: string): string | null {
  // Match `<prefix> - <rest>.md` — prefix is everything before the first ` - `.
  const m = filename.match(/^([a-z0-9]+-[0-9]+(?:\.[0-9]+)?)\s+-\s+/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Walk a directory and collect task file locations. Non-existent directories
 * are silently skipped (no entries returned).
 */
function collectLocations(dir: string, bucket: 'tasks' | 'completed'): TaskLocation[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const locs: TaskLocation[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const idLower = extractTaskIdFromFilename(name);
    if (idLower === null) continue;
    locs.push({
      taskId: idLower.toUpperCase().replace(/^([a-z]+)/, (m) => m.toUpperCase()),
      idLower,
      relativePath: `backlog/${bucket}/${name}`,
      bucket,
    });
  }
  return locs;
}

/**
 * Scan `backlog/tasks/` and `backlog/completed/` for duplicate task IDs.
 * Returns a `VerifyResult` with the full location list and any duplicates found.
 */
export function verifyBacklogIntegrity(workDir: string = process.cwd()): VerifyResult {
  const tasksDir = join(workDir, 'backlog', 'tasks');
  const completedDir = join(workDir, 'backlog', 'completed');

  const taskLocs = collectLocations(tasksDir, 'tasks');
  const completedLocs = collectLocations(completedDir, 'completed');
  const allLocs = [...taskLocs, ...completedLocs];

  // Build idLower → buckets map.
  const byId = new Map<string, Set<'tasks' | 'completed'>>();
  for (const loc of allLocs) {
    if (!byId.has(loc.idLower)) byId.set(loc.idLower, new Set());
    byId.get(loc.idLower)!.add(loc.bucket);
  }

  const duplicates: string[] = [];
  for (const [idLower, buckets] of byId) {
    if (buckets.has('tasks') && buckets.has('completed')) {
      duplicates.push(idLower);
    }
  }

  return { ok: duplicates.length === 0, locations: allLocs, duplicates };
}

// ── yargs CLI router ──────────────────────────────────────────────────

export function buildBacklogVerifyCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-backlog-verify')
    .usage(
      'Usage: $0 [options]\n\n' +
        '  Scan backlog/tasks/ and backlog/completed/ for duplicate task IDs.\n' +
        '  Exits non-zero when any task ID appears in both directories.\n\n' +
        '  node pipeline-cli/bin/cli-backlog-verify.mjs\n' +
        '  node pipeline-cli/bin/cli-backlog-verify.mjs --work-dir /repo',
    )
    .option('work-dir', {
      alias: 'w',
      type: 'string',
      describe: 'Repo root containing backlog/ (default: cwd).',
      default: process.cwd(),
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json'] as const,
      default: 'text' as const,
      describe: 'Output format.',
    })
    .option('quiet', {
      type: 'boolean',
      default: false,
      describe: 'Suppress task-list output; only print the duplicate summary (or nothing if OK).',
    })
    .command(
      '$0',
      'Verify backlog integrity (no duplicate task IDs)',
      (y) => y,
      (argv) => {
        const workDir = String(argv['work-dir']);
        const format = String(argv.format) as 'text' | 'json';
        const quiet = Boolean(argv.quiet);

        const result = verifyBacklogIntegrity(workDir);

        if (format === 'json') {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          process.exit(result.ok ? 0 : 1);
        }

        // Text output.
        if (result.ok) {
          if (!quiet) {
            process.stdout.write(
              `[cli-backlog-verify] OK — ${result.locations.length} task file(s) scanned, no duplicates.\n`,
            );
          }
          process.exit(0);
        }

        // Duplicates found — report to stderr for easy pre-push hook capture.
        const lines: string[] = [
          `[cli-backlog-verify] DUPLICATE TASK IDs DETECTED (${result.duplicates.length}):`,
        ];
        for (const idLower of result.duplicates) {
          const matchingLocs = result.locations.filter((l) => l.idLower === idLower);
          lines.push(`  ${idLower}:`);
          for (const loc of matchingLocs) {
            lines.push(`    [${loc.bucket}]  ${loc.relativePath}`);
          }
        }
        lines.push('');
        lines.push(
          'To fix: delete the backlog/tasks/ copy and ensure only backlog/completed/ has the file.',
        );
        lines.push(
          'Run: node pipeline-cli/bin/cli-task-complete.mjs <task-id>  (if tasks/ copy is the authoritative source)',
        );

        process.stderr.write(lines.join('\n') + '\n');
        process.exit(1);
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runBacklogVerifyCli(): Promise<void> {
  await buildBacklogVerifyCli().parseAsync();
}
