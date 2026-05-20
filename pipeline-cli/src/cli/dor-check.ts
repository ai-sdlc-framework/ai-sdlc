/**
 * `cli-dor-check` — pre-push DoR gate (AISDLC-370).
 *
 * Runs the same DoR rubric the CI workflow runs, but locally before the
 * push lands. Catches gate-2/3/7 violations + upstream-OQ blocks so the
 * operator fixes them without a CI round-trip.
 *
 * Modes:
 *   --task <path>                  Check a single task file
 *   --staged --push-range A..B     Walk `git diff --name-only A B` for
 *                                  changed backlog/{tasks,completed}/*.md
 *                                  files and check each
 *
 * Exits non-zero on any block; prints findings in the same format the
 * CI workflow comments on the PR so the operator sees identical wording.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { refineBacklogTask } from '../dor/ingress-claude.js';
import { renderClarificationComment } from '../dor/comment-loop.js';
import { loadDorConfig } from '../dor/dor-config.js';

function extractTaskIdFromFile(taskFile: string): string | null {
  // Backlog convention: `aisdlc-<n> - <slug>.md`. Pull the ID from the basename.
  const name = basename(taskFile);
  const match = name.match(/^(aisdlc-\d+(?:\.\d+)?)\s/i);
  if (match) return match[1].toUpperCase();
  // Fallback: read frontmatter `id:` field
  if (existsSync(taskFile)) {
    const text = readFileSync(taskFile, 'utf8');
    const fmMatch = text.match(/^id:\s*['"]?([A-Z]+-\d+(?:\.\d+)?)['"]?\s*$/m);
    if (fmMatch) return fmMatch[1].toUpperCase();
  }
  return null;
}

function findWorkDir(taskFile: string): string {
  // Walk up from the task file looking for a `backlog/` directory's parent.
  let dir = isAbsolute(taskFile) ? dirname(taskFile) : resolve(dirname(taskFile));
  while (dir !== '/' && dir !== '') {
    if (existsSync(join(dir, 'backlog')) && statSync(join(dir, 'backlog')).isDirectory()) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

interface CheckOneResult {
  taskFile: string;
  taskId: string;
  blocked: boolean;
  comment: string;
}

async function checkOneTaskFile(taskFile: string): Promise<CheckOneResult> {
  const resolved = isAbsolute(taskFile) ? taskFile : resolve(taskFile);
  const taskId = extractTaskIdFromFile(resolved);
  if (!taskId) {
    return {
      taskFile: resolved,
      taskId: '<unknown>',
      blocked: true,
      comment: `[dor-gate] Could not extract task ID from ${resolved} — filename must match aisdlc-<n>-*.md or frontmatter must include id:`,
    };
  }
  const workDir = findWorkDir(resolved);

  // Force enforce mode regardless of repo's dor-config.yaml — the pre-push
  // gate's entire purpose is to BLOCK, not warn. A repo that's still in
  // warn-only at runtime should still get pre-push refusals locally so the
  // operator doesn't waste a CI cycle on a known-bad task.
  const baseConfig = loadDorConfig({ workDir });
  const enforceConfig = { ...baseConfig, evaluationMode: 'enforce' as const };

  const result = await refineBacklogTask(taskId, {
    workDir,
    taskFilePathOverride: resolved,
    config: enforceConfig,
  });

  if (!result.shouldRefuseExecution) {
    return { taskFile: resolved, taskId, blocked: false, comment: '' };
  }

  // Use the same renderer the CI workflow uses so wording is identical
  const comment = renderClarificationComment(result.verdict, { channel: 'author' });
  return { taskFile: resolved, taskId, blocked: true, comment };
}

// AISDLC-370 security review: validate pushRange to a strict git-range
// shape before spawning git. Defense-in-depth — today's only caller is
// the trusted pre-push hook with git-derived SHAs, but rejecting odd
// input prevents a future automation caller from accidentally widening
// the attack surface. Combined with execFileSync (no shell), the worst a
// rejected value can do is exit non-zero.
const PUSH_RANGE_RE = /^[A-Za-z0-9_./^~-]+\.\.[A-Za-z0-9_./^~-]+$/;

function listStagedTaskFiles(pushRange: string): string[] {
  if (!PUSH_RANGE_RE.test(pushRange)) {
    throw new Error(`Refusing unsafe --push-range value: ${pushRange}`);
  }
  // execFileSync (no shell) — argv is passed verbatim to git without any
  // shell expansion, so the pushRange string can't smuggle command chars
  // even if validation regressed.
  const out = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=AMR',
      pushRange,
      '--',
      'backlog/tasks/**.md',
      'backlog/completed/**.md',
    ],
    { encoding: 'utf8' },
  );
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runDorCheckCli(): Promise<number> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cli-dor-check')
    .usage('Usage: $0 (--task <path> | --staged --push-range <A..B>)')
    .option('task', {
      type: 'string',
      describe: 'Path to a single backlog task file to check',
    })
    .option('staged', {
      type: 'boolean',
      default: false,
      describe: 'Walk a git push range for changed backlog task files',
    })
    .option('push-range', {
      type: 'string',
      describe: 'Git range A..B (required with --staged)',
    })
    .help()
    .strict()
    .parseAsync();

  const taskFiles: string[] = [];

  if (argv.task) {
    if (!existsSync(argv.task)) {
      process.stderr.write(`[dor-gate] Task file not found: ${argv.task}\n`);
      return 2;
    }
    taskFiles.push(argv.task);
  } else if (argv.staged) {
    if (!argv['push-range']) {
      process.stderr.write('[dor-gate] --staged requires --push-range A..B\n');
      return 2;
    }
    try {
      taskFiles.push(...listStagedTaskFiles(argv['push-range']));
    } catch (err) {
      process.stderr.write(
        `[dor-gate] Failed to enumerate staged task files: ${(err as Error).message}\n`,
      );
      return 2;
    }
  } else {
    process.stderr.write('[dor-gate] Pass --task <path> or --staged --push-range <A..B>\n');
    return 2;
  }

  if (taskFiles.length === 0) {
    // Nothing to check — silent pass.
    return 0;
  }

  let blocked = 0;
  for (const file of taskFiles) {
    let result: CheckOneResult;
    try {
      result = await checkOneTaskFile(file);
    } catch (err) {
      // A malformed task file or missing references engine error — surface
      // but don't auto-block the push (engine errors are operator bugs,
      // not DoR violations).
      process.stderr.write(`[dor-gate] Skipped ${file}: ${(err as Error).message}\n`);
      continue;
    }
    if (result.blocked) {
      blocked += 1;
      process.stdout.write(
        `\n[dor-gate] DoR violations in ${result.taskFile} (${result.taskId}):\n\n`,
      );
      process.stdout.write(result.comment);
      if (!result.comment.endsWith('\n')) process.stdout.write('\n');
    }
  }

  return blocked === 0 ? 0 : 1;
}
