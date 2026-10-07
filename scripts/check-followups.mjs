#!/usr/bin/env node
/**
 * Follow-up gate for completed backlog tasks.
 *
 *   node scripts/check-followups.mjs --task <path>
 *   node scripts/check-followups.mjs --staged --push-range <A..B>
 *
 * The rule lives in pipeline-cli (`src/backlog/followup-rule.ts`) and is shared
 * with the plugin's `task_complete` tool; this script only does file/range
 * plumbing. Range mode checks files added or modified under backlog/completed/
 * within the range, and within those files only the follow-up items the range
 * adds or changes: an item that already violated at the range base is the
 * branch's inheritance, not its work, so touching a completed task for another
 * reason (a dead script reference) never re-judges its old prose (AISDLC-733).
 *
 * Fails closed: a missing build, unreadable file or git error exits non-zero.
 * Exit codes: 0 pass, 1 violation or error, 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RULE_DIST = join(SCRIPT_DIR, '..', 'pipeline-cli', 'dist', 'backlog', 'followup-rule.js');

function fail(msg, code = 1) {
  process.stderr.write(`[followup-gate] ${msg}\n`);
  process.exit(code);
}

function readTaskPrefix(root) {
  try {
    const cfg = readFileSync(join(root, 'backlog', 'config.yml'), 'utf-8');
    const m = /^task_prefix:\s*['"]?([A-Za-z][A-Za-z0-9]*)['"]?\s*$/m.exec(cfg);
    if (m) return m[1];
  } catch {
    // no config: rule default applies
  }
  return undefined;
}

function parseArgs(argv) {
  const out = { task: undefined, staged: false, range: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--staged') out.staged = true;
    else if (a === '--push-range') out.range = argv[++i];
    else fail(`unknown argument: ${a}`, 2);
  }
  if (out.task && (out.staged || out.range)) fail('--task cannot be combined with range mode', 2);
  if (!out.task && !(out.staged && out.range)) {
    fail('usage: check-followups.mjs --task <path> | --staged --push-range <A..B>', 2);
  }
  return out;
}

/** Files added, modified or renamed under backlog/completed/ as `{ path, basePath }`. */
function completedFilesInRange(range) {
  const raw = execFileSync(
    'git',
    ['diff', '--name-status', '-M', '--diff-filter=AMR', range, '--', 'backlog/completed/'],
    { encoding: 'utf-8' },
  );
  const out = [];
  for (const line of raw.split('\n')) {
    const [status, a, b] = line.split('\t');
    if (!status) continue;
    const path = status.startsWith('R') ? b : a;
    if (path && path.endsWith('.md')) out.push({ path, basePath: a });
  }
  return out;
}

/** Content of `file` at the range base, or null when the base has no such file (added). */
function readAtRangeBase(range, file) {
  const base = range.split('..')[0];
  try {
    return execFileSync('git', ['show', `${base}:${file}`], {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Content of `file` as of the range tip (what is being pushed), not the working tree. */
function readAtRangeTip(range, file) {
  const tip = range.split('..').pop();
  return execFileSync('git', ['show', `${tip}:${file}`], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const files = args.task
    ? [{ path: args.task, basePath: undefined }]
    : completedFilesInRange(args.range);
  if (files.length === 0) return 0;

  if (!existsSync(RULE_DIST)) {
    fail(
      `pipeline-cli is not built (missing ${RULE_DIST}). Run: pnpm --filter @ai-sdlc/pipeline-cli build`,
    );
  }
  const { checkFollowups, formatFollowupViolations } = await import(pathToFileURL(RULE_DIST).href);
  const taskPrefix = readTaskPrefix(root);

  let blocked = 0;
  for (const { path: file, basePath } of files) {
    const text = args.task
      ? readFileSync(resolve(root, file), 'utf-8')
      : readAtRangeTip(args.range, file);
    const result = checkFollowups(text, { taskPrefix });
    let violations = result.violations;
    if (!args.task && violations.length > 0) {
      // Judge only items the range adds or changes: drop those already failing at the base.
      const baseText = readAtRangeBase(args.range, basePath);
      if (baseText !== null) {
        const inherited = new Set(
          checkFollowups(baseText, { taskPrefix }).violations.map((v) => v.item),
        );
        violations = violations.filter((v) => !inherited.has(v.item));
      }
    }
    if (violations.length > 0) {
      blocked++;
      process.stderr.write(`${formatFollowupViolations(violations, { file, taskPrefix })}\n\n`);
    }
  }
  return blocked > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => fail(`error: ${err instanceof Error ? err.message : String(err)}`),
);
