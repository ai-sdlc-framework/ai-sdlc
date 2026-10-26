/**
 * `cli-file` — planner filing tool (AISDLC-801).
 *
 * Validates a backlog task or decision record, then commits it on a fresh
 * branch `ai-sdlc/file-<id>` cut from `origin/main` (in `.worktrees/file-<id>`),
 * pushes it as a plain fast-forward and opens a ready (never draft) PR. When a
 * filing branch conflicts, `rebase` rebuilds it from current `origin/main` and
 * lease-pushes the SAME branch (DEC-0088), so the PR number stays and is re-armed
 * through the docs lane (`--source-kind docs`); no replacement PR is opened.
 *
 *   cli-file task <path> [--pr] [--no-brief] [--fixes-pr <n>] [--queue] [--spacing-minutes <n>]
 *   cli-file decision <DEC-NNNN> --task-id <ID> [--answer <option>] [--rationale <t>] [--pr]
 *   cli-file rebase <id> [--pr]
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { now as clockNow } from '../clock.js';
import {
  eventContentHash,
  eventFileName,
  readDecisionEvents,
  resolveEventsDir,
} from '../decisions/event-log.js';
import { paceFiling, recordFiling } from './file-pacing.js';
import { isProtectedBranch } from '../hierarchy/lease-policy.js';
import { writeAutoBrief } from '../hierarchy/auto-brief.js';
import type { DecisionEvent } from '../decisions/decision-record.js';

export const EVENT_LOG_REL = '.ai-sdlc/_decisions/events.jsonl';
export const EVENTS_DIR_REL = '.ai-sdlc/_decisions/events';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface FileDeps {
  exec(cmd: string, args: string[], cwd: string): ExecResult;
  /** Returns an error string, or null when clean. */
  drift(taskId: string, cwd: string): string | null;
  dor(taskFile: string, cwd: string): string | null;
}

export class FileRefusal extends Error {}

function realExec(cmd: string, args: string[], cwd: string): ExecResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const PKG_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');

export const defaultDeps: FileDeps = {
  exec: realExec,
  drift(taskId, cwd) {
    const r = realExec('npx', ['backlog-drift', 'check', '--task', taskId], cwd);
    return r.status === 0 ? null : `backlog-drift: ${(r.stdout + r.stderr).trim()}`;
  },
  dor(taskFile, cwd) {
    const r = realExec(
      process.execPath,
      [join(PKG_BIN, 'cli-dor-check.mjs'), '--task', taskFile],
      cwd,
    );
    return r.status === 0 ? null : `DoR: ${(r.stdout + r.stderr).trim()}`;
  },
};

function git(deps: FileDeps, cwd: string, ...args: string[]): string {
  const r = deps.exec('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// -- Validation ---------------------------------------------------------------

export function assertAscii(path: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(path)) {
    throw new FileRefusal(`non-ASCII characters in backlog filename: ${path}`);
  }
}

export function taskIdOf(file: string): string {
  const m = basename(file).match(/^([a-z]+-\d+(?:\.\d+)?)\s/i);
  if (m) return m[1].toUpperCase();
  const fm = readFileSync(file, 'utf8').match(/^id:\s*['"]?([A-Za-z]+-\d+(?:\.\d+)?)['"]?\s*$/m);
  if (fm) return fm[1].toUpperCase();
  throw new FileRefusal(`cannot derive a task id from ${file}`);
}

export interface ParsedLog {
  lines: string[];
  events: Array<Record<string, unknown>>;
}

/** Strict parse: every non-empty line must be a JSON object. */
export function parseLogStrict(text: string, label: string): ParsedLog {
  const lines: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new FileRefusal(`${label}: line ${i + 1} is not valid JSON`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new FileRefusal(`${label}: line ${i + 1} is not a JSON object`);
    }
    lines.push(line);
    events.push(obj as Record<string, unknown>);
  });
  return { lines, events };
}

/** Count of each (decisionId, type) pair. */
export function pairCounts(events: Array<Record<string, unknown>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (typeof e.decisionId !== 'string') continue;
    const key = `${e.decisionId}|${String(e.type)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Refuses a duplicate (decisionId, type) pair, except a pair already duplicated
 * on origin/main (`onMain` counts): that one is warned about, never grown (AISDLC-922).
 */
export function assertNoDuplicatePairs(
  events: Array<Record<string, unknown>>,
  label: string,
  onMain: Map<string, number> = new Map(),
): void {
  for (const [key, n] of pairCounts(events)) {
    if (n < 2) continue;
    const allowed = onMain.get(key) ?? 1;
    const pretty = key.replace('|', ' ');
    if (n > allowed) {
      throw new FileRefusal(`${label}: duplicate (decisionId, type) pair ${pretty}`);
    }
    console.error(
      `warning: ${label}: duplicate (decisionId, type) pair ${pretty} already on origin/main`,
    );
  }
}

// -- Branch + PR plumbing -------------------------------------------------------

interface Publish {
  repo: string;
  branch: string;
  worktreeDir: string;
  subject: string;
  prBody: string;
  pr: boolean;
  /**
   * In-place rebuild (DEC-0088): push this local branch over the EXISTING remote branch with
   * `--force-with-lease` pinned to `leaseSha`, keep the open PR, never open another.
   */
  inPlace?: { remoteBranch: string; leaseSha: string };
  /** Writes the content into the new worktree; returns repo-relative paths to stage. */
  materialise(worktree: string): string[];
}

function publish(
  deps: FileDeps,
  p: Publish,
): { branch: string; prUrl: string | null; armed?: boolean } {
  git(deps, p.repo, 'fetch', 'origin', 'main');
  const wt = join(p.repo, '.worktrees', p.worktreeDir);
  git(deps, p.repo, 'worktree', 'add', '-b', p.branch, wt, 'origin/main');
  try {
    const paths = p.materialise(wt);
    git(deps, wt, 'add', '--', ...paths);
    git(
      deps,
      wt,
      'commit',
      '-m',
      `${p.subject}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`,
    );
    if (p.inPlace) {
      git(
        deps,
        wt,
        'push',
        `--force-with-lease=${p.inPlace.remoteBranch}:${p.inPlace.leaseSha}`,
        'origin',
        `HEAD:refs/heads/${p.inPlace.remoteBranch}`,
      );
    } else {
      // Plain fast-forward push of a brand-new branch; never a force push.
      git(deps, wt, 'push', '-u', 'origin', `HEAD:refs/heads/${p.branch}`);
    }
  } catch (err) {
    // Remove what this call created so a retry starts clean (no branch deletion of pushed work).
    deps.exec('git', ['worktree', 'remove', '--force', wt], p.repo);
    deps.exec('git', ['branch', '-D', p.branch], p.repo);
    throw err;
  }
  if (p.inPlace) {
    // The temporary local branch has served its purpose; the remote branch carries the work.
    deps.exec('git', ['worktree', 'remove', '--force', wt], p.repo);
    deps.exec('git', ['branch', '-D', p.branch], p.repo);
    return { branch: p.inPlace.remoteBranch, prUrl: null };
  }
  let prUrl: string | null = null;
  if (p.pr) {
    const r = deps.exec('gh', buildPrCreateArgs(p), wt);
    if (r.status !== 0) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
    prUrl = r.stdout.trim().split('\n').pop() ?? null;
    recordFiling(p.repo);
  }
  return { branch: p.branch, prUrl };
}

/** Filing PRs are never drafts: the docs lane arms them straight away (AISDLC-878). */
export function buildPrCreateArgs(p: Pick<Publish, 'branch' | 'subject' | 'prBody'>): string[] {
  return [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    p.branch,
    '--title',
    p.subject,
    '--body',
    p.prBody,
  ];
}

function appendEvents(
  worktree: string,
  newLines: string[],
  label: string,
  onMain: Map<string, number> = new Map(),
): void {
  const p = join(worktree, EVENT_LOG_REL);
  mkdirSync(dirname(p), { recursive: true });
  let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (text !== '' && !text.endsWith('\n')) text += '\n';
  const combined = text + newLines.map((l) => l + '\n').join('');
  assertNoDuplicatePairs(parseLogStrict(combined, label).events, label, onMain);
  writeFileSync(p, combined);
}

/** Events from the per-event store only, as strict-parsed lines. */
function readStoreEvents(repo: string): ParsedLog {
  const lines: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  for (const e of readDecisionEvents({ workDir: repo }).events) {
    const line = JSON.stringify(e);
    lines.push(line);
    events.push(e as unknown as Record<string, unknown>);
  }
  return { lines, events };
}

/** Legacy events first, then store events not already present (same content hash). */
function mergeEvents(legacy: ParsedLog, store: ParsedLog): ParsedLog {
  const seen = new Set(legacy.lines.map(eventContentHash));
  const out: ParsedLog = { lines: [...legacy.lines], events: [...legacy.events] };
  store.lines.forEach((l, i) => {
    const h = eventContentHash(l);
    if (seen.has(h)) return;
    seen.add(h);
    out.lines.push(l);
    out.events.push(store.events[i]);
  });
  return out;
}

/** Writes one per-event file per line into the worktree; returns the staged paths. */
function writeEventFiles(worktree: string, lines: string[]): string[] {
  const dir = join(worktree, EVENTS_DIR_REL);
  mkdirSync(dir, { recursive: true });
  return lines.map((line) => {
    const rel = `${EVENTS_DIR_REL}/${eventFileName(JSON.parse(line) as DecisionEvent, line)}`;
    writeFileSync(join(worktree, rel), line + '\n');
    return rel;
  });
}

/**
 * AISDLC-950: after a successful push, remove the untracked source copy in the parent when it is
 * byte-identical to the committed copy, so Step 0.5 never tries to re-file it. Otherwise keep it
 * and print why. Returns true when removed.
 */
export function removeSourceCopy(
  deps: FileDeps,
  repo: string,
  abs: string,
  rel: string,
  branch: string,
): boolean {
  const keep = (why: string) => {
    console.error(`[cli-file] kept ${rel}: ${why}`);
    return false;
  };
  if (!existsSync(abs)) return false;
  if (deps.exec('git', ['ls-files', '--error-unmatch', '--', rel], repo).status === 0) {
    return keep('it is tracked');
  }
  const committed = deps.exec('git', ['show', `${branch}:${rel}`], repo);
  if (committed.status !== 0) return keep(`cannot read it from ${branch}`);
  if (committed.stdout !== readFileSync(abs, 'utf8')) {
    return keep(`it differs from the copy on ${branch}`);
  }
  unlinkSync(abs);
  console.error(`[cli-file] removed ${rel} (identical to the copy on ${branch})`);
  return true;
}

// -- Subcommands ----------------------------------------------------------------

export interface ValidatedTask {
  abs: string;
  rel: string;
  id: string;
}

/**
 * Finds the path on `origin/main` (`backlog/tasks` or `backlog/completed`) whose filename or id
 * matches, case-insensitively; null when the id is free (AISDLC-860).
 */
function findOnMain(
  deps: FileDeps,
  repo: string,
  rel: string,
  id: string,
  extraIds: string[],
): string | null {
  git(deps, repo, 'fetch', 'origin', 'main');
  const listing = git(
    deps,
    repo,
    'ls-tree',
    '-r',
    '--name-only',
    'origin/main',
    'backlog/tasks',
    'backlog/completed',
  );
  const wantName = basename(rel).toLowerCase();
  const wantIds = new Set([id, ...extraIds].map((i) => i.toLowerCase()));
  for (const line of listing.split('\n')) {
    const path = line.trim();
    if (!path) continue;
    const name = basename(path).toLowerCase();
    const m = name.match(/^([a-z]+-\d+(?:\.\d+)?)\s/);
    if (name === wantName || (m !== null && wantIds.has(m[1]))) return path;
  }
  return null;
}

/**
 * Refuses a task whose id (any case) or filename (any case) already exists in
 * `backlog/tasks` or `backlog/completed` on `origin/main` (AISDLC-860).
 */
export function assertIdFreeOnMain(
  deps: FileDeps,
  repo: string,
  rel: string,
  id: string,
  extraIds: string[] = [],
): void {
  const path = findOnMain(deps, repo, rel, id, extraIds);
  if (path !== null) {
    throw new FileRefusal(
      `${rel}: task id ${id} already exists on origin/main as ${path} (case-insensitive match)`,
    );
  }
}

/** Runs every filing check (ASCII, path, duplicate id on main, drift, DoR); creates nothing. */
export function validateTaskFile(
  repo: string,
  taskPath: string,
  deps: FileDeps = defaultDeps,
  update = false,
): ValidatedTask {
  const abs = isAbsolute(taskPath) ? taskPath : resolve(repo, taskPath);
  const relFromRepo = relative(repo, abs);
  // A source anywhere on disk (e.g. a scratchpad, AISDLC-931) is filed under
  // backlog/tasks/<basename>; the parent tree is never touched.
  const inTasksDir =
    !relFromRepo.startsWith('..') &&
    !isAbsolute(relFromRepo) &&
    relFromRepo.startsWith('backlog/tasks/');
  let rel = inTasksDir ? relFromRepo : `backlog/tasks/${basename(abs)}`;
  assertAscii(rel);
  if (!rel.toLowerCase().endsWith('.md')) {
    throw new FileRefusal(`task source must be a .md file: ${basename(abs)}`);
  }
  if (!existsSync(abs)) throw new FileRefusal(`task file not found: ${abs}`);
  const id = taskIdOf(abs);
  const fm = readFileSync(abs, 'utf8').match(/^id:\s*['"]?([A-Za-z]+-\d+(?:\.\d+)?)['"]?\s*$/m);
  if (update) {
    // AISDLC-921: --update edits a task already on main, in place, through the same checks.
    const existing = findOnMain(deps, repo, rel, id, fm ? [fm[1]] : []);
    if (existing === null) {
      throw new FileRefusal(
        `${rel}: --update needs task id ${id} to exist on origin/main; none found (file it without --update)`,
      );
    }
    if (!existing.startsWith('backlog/tasks/')) {
      throw new FileRefusal(`${rel}: task id ${id} is completed on origin/main as ${existing}`);
    }
    rel = existing;
    assertAscii(rel);
  } else {
    assertIdFreeOnMain(deps, repo, rel, id, fm ? [fm[1]] : []);
  }
  const drift = deps.drift(id, repo);
  if (drift) throw new FileRefusal(drift);
  const dor = deps.dor(abs, repo);
  if (dor) throw new FileRefusal(dor);
  return { abs, rel, id };
}

function resolveSource(repo: string, taskPath: string): string {
  return isAbsolute(taskPath) ? taskPath : resolve(repo, taskPath);
}

/** AISDLC-1045: true when the task is absent from origin/main but `origin/ai-sdlc/file-<id>` exists. */
function onlyOnFilingBranch(deps: FileDeps, repo: string, taskPath: string): boolean {
  const abs = resolveSource(repo, taskPath);
  if (!existsSync(abs)) return false;
  const id = taskIdOf(abs);
  const fm = readFileSync(abs, 'utf8').match(/^id:\s*['"]?([A-Za-z]+-\d+(?:\.\d+)?)['"]?\s*$/m);
  const rel = `backlog/tasks/${basename(abs)}`;
  if (findOnMain(deps, repo, rel, id, fm ? [fm[1]] : []) !== null) return false;
  const ref = `refs/remotes/origin/ai-sdlc/file-${id.toLowerCase()}`;
  return deps.exec('git', ['rev-parse', '--verify', '--quiet', ref], repo).status === 0;
}

/** AISDLC-1054: the head branch of the PR a task fixes, from GitHub; refuses when it cannot be read. */
function fixesOf(
  deps: FileDeps,
  repo: string,
  fixesPr: number | undefined,
): { fixesPr: number; prHeadRef: string } | undefined {
  if (fixesPr === undefined) return undefined;
  const r = deps.exec(
    'gh',
    ['pr', 'view', String(fixesPr), '--json', 'headRefName,isCrossRepository'],
    repo,
  );
  let ref: string;
  let cross = false;
  try {
    const j =
      r.status === 0
        ? (JSON.parse(r.stdout) as { headRefName?: string; isCrossRepository?: boolean })
        : {};
    ref = String(j.headRefName ?? '');
    cross = j.isCrossRepository === true;
  } catch {
    ref = '';
  }
  if (!ref || ref === 'undefined') {
    throw new FileRefusal(
      `--fixes-pr ${fixesPr}: could not read the head branch of PR #${fixesPr}`,
    );
  }
  if (cross) {
    throw new FileRefusal(
      `--fixes-pr ${fixesPr}: PR #${fixesPr} head is in another repository (a fork); refused`,
    );
  }
  if (isProtectedBranch(ref, [])) {
    throw new FileRefusal(`--fixes-pr ${fixesPr}: head branch '${ref}' is protected; refused`);
  }
  return { fixesPr, prHeadRef: ref };
}

export function fileTask(
  repo: string,
  taskPath: string,
  opts: {
    pr: boolean;
    brief?: boolean;
    update?: boolean;
    validated?: ValidatedTask;
    /** AISDLC-1054: the PR this task fixes; its head branch goes into the brief entry. */
    fixesPr?: number;
  },
  deps: FileDeps = defaultDeps,
) {
  const update = opts.update === true;
  if (update && !opts.validated && onlyOnFilingBranch(deps, repo, taskPath)) {
    // AISDLC-1045: the task is not on main but sits on its open filing branch; correct it there.
    return fileRebase(
      repo,
      taskIdOf(resolveSource(repo, taskPath)),
      { pr: opts.pr, source: taskPath },
      deps,
    );
  }
  const { abs, rel, id } = opts.validated ?? validateTaskFile(repo, taskPath, deps, update);
  const slug = id.toLowerCase();
  const verb = update ? 'update' : 'file';
  const res = publish(deps, {
    repo,
    branch: `ai-sdlc/${verb}-${slug}`,
    worktreeDir: `${verb}-${slug}`,
    subject: `chore(docs): ${verb} backlog task ${id} (${id})`,
    prBody: `${update ? 'Updates' : 'Files'} backlog task ${id}.\n\nValidated before commit: ASCII filename, duplicate id on origin/main, backlog-drift, DoR.\n\nGenerated by cli-file (AISDLC-801).`,
    pr: opts.pr,
    materialise(wt) {
      const dest = join(wt, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      return [rel];
    },
  });
  // AISDLC-930: a one-task brief on the local board (gitignored), so dispatch ingests the task
  // without a hand-written brief. Only for a PR filing; `--no-brief` opts out.
  if (opts.pr && opts.brief !== false) {
    writeAutoBrief(repo, abs, undefined, fixesOf(deps, repo, opts.fixesPr));
  }
  // Only a source inside the parent's own backlog/tasks is a leftover (AISDLC-931 sources are elsewhere).
  if (abs === join(repo, rel)) removeSourceCopy(deps, repo, abs, rel, res.branch);
  return res;
}

export function fileDecision(
  repo: string,
  decisionId: string,
  opts: { taskId: string; answer?: string; rationale?: string; pr: boolean },
  deps: FileDeps = defaultDeps,
) {
  const logPath = join(repo, EVENT_LOG_REL);
  const hasLegacy = existsSync(logPath);
  const legacy = parseLogStrict(hasLegacy ? readFileSync(logPath, 'utf8') : '', 'local log');
  // Per-event store (AISDLC-719), read through the shared event-log module.
  const local = mergeEvents(legacy, readStoreEvents(repo));
  git(deps, repo, 'fetch', 'origin', 'main');
  const mainEvents: Array<Record<string, unknown>> = [];
  const mainShow = deps.exec('git', ['show', `origin/main:${EVENT_LOG_REL}`], repo);
  if (mainShow.status === 0) {
    mainEvents.push(...parseLogStrict(mainShow.stdout, 'origin/main log').events);
  }
  const tree = deps.exec(
    'git',
    ['ls-tree', '--name-only', 'origin/main', `${EVENTS_DIR_REL}/`],
    repo,
  );
  const treeShown: string[] = [];
  for (const f of tree.status === 0 ? tree.stdout.split('\n').filter(Boolean) : []) {
    const shown = deps.exec('git', ['show', `origin/main:${f}`], repo);
    if (shown.status === 0) {
      treeShown.push(shown.stdout);
      mainEvents.push(...parseLogStrict(shown.stdout, `origin/main ${f}`).events);
    }
  }
  const onMainPairs = pairCounts(mainEvents);
  assertNoDuplicatePairs(local.events, 'local log', onMainPairs);
  const own = local.events.filter((e) => e.decisionId === decisionId);
  const opened = own.find((e) => e.type === 'decision-opened');
  if (!opened) {
    throw new FileRefusal(`no decision-opened event for ${decisionId} in ${EVENT_LOG_REL}`);
  }
  const lines = own.map((e) => JSON.stringify(e));
  if (opts.answer) {
    const options = (opened.options as Array<{ id: string }> | undefined) ?? [];
    if (!options.some((o) => o.id === opts.answer)) {
      throw new FileRefusal(`option ${opts.answer} is not an option of ${decisionId}`);
    }
    if (own.some((e) => e.type === 'operator-answered')) {
      throw new FileRefusal(`duplicate (decisionId, type) pair ${decisionId} operator-answered`);
    }
    lines.push(
      JSON.stringify({
        eventVersion: 'v1',
        type: 'operator-answered',
        ts: clockNow().toISOString(),
        decisionId,
        chosenOptionId: opts.answer,
        ...(opts.rationale ? { rationale: opts.rationale } : {}),
        by: 'planner',
      }),
    );
  }
  const onMainHashes = new Set(
    (mainShow.status === 0 ? parseLogStrict(mainShow.stdout, 'origin/main log').lines : []).map(
      eventContentHash,
    ),
  );
  for (const t of treeShown) onMainHashes.add(eventContentHash(t));
  const fresh = lines.filter((l) => !onMainHashes.has(eventContentHash(l)));
  if (fresh.length === 0) {
    throw new FileRefusal(`origin/main already has every ${decisionId} event; nothing to file`);
  }
  // Legacy log only when this repo has no events/ directory and still keeps a legacy log.
  const useLegacy = !existsSync(resolveEventsDir(repo)) && (hasLegacy || mainShow.status === 0);
  const slug = decisionId.toLowerCase();
  const res = publish(deps, {
    repo,
    branch: `ai-sdlc/file-${slug}`,
    worktreeDir: `file-${slug}`,
    subject: `chore(decisions): record ${decisionId} (${opts.taskId})`,
    prBody: `Appends the ${decisionId} event(s) to the decision log.\n\nThe whole log was parsed and checked for duplicate (decisionId, type) pairs before commit.\n\nGenerated by cli-file (AISDLC-801).`,
    pr: opts.pr,
    materialise(wt) {
      if (useLegacy) {
        appendEvents(wt, fresh, `log for ${decisionId}`, onMainPairs);
        return [EVENT_LOG_REL];
      }
      return writeEventFiles(wt, fresh);
    },
  });
  // AISDLC-950: per-event files only; the legacy log is tracked and appended to, so it is kept.
  if (!useLegacy) {
    for (const line of fresh) {
      const rel = `${EVENTS_DIR_REL}/${eventFileName(JSON.parse(line) as DecisionEvent, line)}`;
      removeSourceCopy(deps, repo, join(repo, rel), rel, res.branch);
    }
  }
  return res;
}

/**
 * Rebuild an existing filing branch on a NEW branch from current `origin/main`
 * plus the branch's own additions. No force push is involved.
 */
export function fileRebase(
  repo: string,
  id: string,
  opts: { pr: boolean; source?: string },
  deps: FileDeps = defaultDeps,
) {
  const slug = id.toLowerCase();
  // AISDLC-1045: a corrected source replaces the branch's copy of the task file; checked first.
  let source: { abs: string; content: string } | undefined;
  if (opts.source !== undefined) {
    const abs = resolveSource(repo, opts.source);
    assertAscii(`backlog/tasks/${basename(abs)}`);
    if (!abs.toLowerCase().endsWith('.md')) {
      throw new FileRefusal(`task source must be a .md file: ${basename(abs)}`);
    }
    if (!existsSync(abs)) throw new FileRefusal(`task file not found: ${abs}`);
    const sourceId = taskIdOf(abs);
    if (sourceId.toLowerCase() !== slug) {
      throw new FileRefusal(`source task id ${sourceId} does not match ${id}`);
    }
    const drift = deps.drift(sourceId, repo);
    if (drift) throw new FileRefusal(drift);
    const dor = deps.dor(abs, repo);
    if (dor) throw new FileRefusal(dor);
    source = { abs, content: readFileSync(abs, 'utf8') };
  }
  const oldBranch = `ai-sdlc/file-${slug}`;
  const old = `origin/${oldBranch}`;
  git(deps, repo, 'fetch', 'origin');
  const base = git(deps, repo, 'merge-base', 'origin/main', old).trim();
  const changed = git(
    deps,
    repo,
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    '--diff-filter=AM',
    base,
    old,
  )
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0) throw new FileRefusal(`branch ${old} has no changes`);
  for (const f of changed) {
    if (
      f !== EVENT_LOG_REL &&
      !f.startsWith(`${EVENTS_DIR_REL}/`) &&
      !f.startsWith('backlog/tasks/') &&
      !f.startsWith('backlog/completed/')
    ) {
      throw new FileRefusal(`refusing to rebuild path outside the filing scope: ${f}`);
    }
  }
  const taskFile = source
    ? changed.find(
        (f) => f.startsWith('backlog/tasks/') && basename(f).toLowerCase().startsWith(`${slug} `),
      )
    : undefined;
  if (source && !taskFile) {
    throw new FileRefusal(`branch ${old} has no task file for ${id} to replace`);
  }
  const subjectOld = git(deps, repo, 'log', '-1', '--format=%s', old).trim();
  let own: string[] = [];
  if (changed.includes(EVENT_LOG_REL)) {
    const before = parseLogStrict(
      git(deps, repo, 'show', `${base}:${EVENT_LOG_REL}`),
      'base log',
    ).lines;
    const after = parseLogStrict(
      git(deps, repo, 'show', `${old}:${EVENT_LOG_REL}`),
      'branch log',
    ).lines;
    const have = new Set(before);
    own = after.filter((l) => !have.has(l));
  }
  const leaseSha = git(deps, repo, 'rev-parse', old).trim();
  const res = publish(deps, {
    repo,
    branch: `${oldBranch}-rebuild`,
    worktreeDir: `file-${slug}-rebuild`,
    subject: subjectOld,
    prBody: '',
    pr: false,
    inPlace: { remoteBranch: oldBranch, leaseSha },
    materialise(wt) {
      for (const f of changed.filter((c) => c !== EVENT_LOG_REL)) {
        mkdirSync(dirname(join(wt, f)), { recursive: true });
        if (source && f === taskFile) {
          writeFileSync(join(wt, f), source.content);
          continue;
        }
        const out = deps.exec('git', ['show', `${old}:${f}`], repo);
        if (out.status !== 0) throw new Error(`cannot read ${f} from ${old}`);
        writeFileSync(join(wt, f), out.stdout);
      }
      if (own.length > 0) appendEvents(wt, own, `rebuilt log for ${id}`);
      return changed;
    },
  });
  if (!opts.pr) return res;
  // Same PR number stays open; arm it through the docs lane.
  const view = deps.exec(
    'gh',
    ['pr', 'list', '--head', oldBranch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
    repo,
  );
  let found: { number: number; url: string } | undefined;
  try {
    found = (JSON.parse(view.stdout || '[]') as Array<{ number: number; url: string }>)[0];
  } catch {
    found = undefined;
  }
  if (view.status !== 0 || !found) {
    throw new Error(`no open PR found for ${oldBranch} after the in-place rebase`);
  }
  const arm = deps.exec(
    process.execPath,
    [
      join(PKG_BIN, 'cli-merge-if-eligible.mjs'),
      String(found.number),
      '--source-kind',
      'docs',
      '--arm',
    ],
    repo,
  );
  return { ...res, prUrl: found.url, armed: arm.status === 0 };
}

// -- CLI --------------------------------------------------------------------------

export async function runFileCli(argv: string[] = hideBin(process.argv)): Promise<number> {
  const repo = process.cwd();
  let code = 0;
  const report = (r: { branch: string; prUrl: string | null; armed?: boolean }) =>
    process.stdout.write(`${JSON.stringify(r)}\n`);
  const guard = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      const refused = err instanceof FileRefusal;
      process.stderr.write(
        `[cli-file] ${refused ? 'refused' : 'error'}: ${(err as Error).message}\n`,
      );
      code = refused ? 1 : 2;
      return undefined;
    }
  };
  /** AISDLC-986: pace a `--pr` filing; false when it was queued instead. */
  const paced = async (a: Record<string, unknown>, id: string, cmd: string): Promise<boolean> => {
    if (!a.pr) return true;
    try {
      const outcome = await paceFiling(repo, {
        id,
        command: cmd,
        spacingMinutes: a.spacingMinutes as number | undefined,
        queue: a.queue as boolean,
      });
      return outcome === 'proceed';
    } catch (err) {
      process.stderr.write(`[cli-file] error: ${(err as Error).message}\n`);
      code = 2;
      return false;
    }
  };
  const pacingOptions = <T>(y: Argv<T>) =>
    y
      .option('queue', {
        type: 'boolean',
        default: false,
        describe: 'with --pr: queue a brief for the next window instead of waiting on the spacing',
      })
      .option('spacing-minutes', {
        type: 'number',
        describe: 'minutes between PR filings (default 15; env AI_SDLC_FILE_SPACING_MINUTES)',
      });
  await yargs(argv)
    .scriptName('cli-file')
    .command(
      'task <path>',
      'validate and file a backlog task',
      (y) =>
        pacingOptions(y)
          .positional('path', { type: 'string', demandOption: true })
          .option('pr', { type: 'boolean', default: false })
          .option('update', {
            type: 'boolean',
            default: false,
            describe:
              'edit a task on origin/main, or on its open filing branch (then same as rebase --source)',
          })
          .option('fixes-pr', {
            type: 'number',
            describe:
              'PR this task fixes: the brief entry carries fixesPr and the PR head branch, so the task lands on that PR',
          })
          .option('brief', {
            type: 'boolean',
            default: true,
            describe: 'write a one-task dispatch brief with --pr; --no-brief skips it',
          }),
      async (a) => {
        if (!(await paced(a, basename(a.path as string), `cli-file task ${a.path} --pr`))) return;
        const r = guard(() =>
          fileTask(repo, a.path as string, {
            pr: a.pr as boolean,
            brief: a.brief as boolean,
            update: a.update as boolean,
            ...(a.fixesPr !== undefined ? { fixesPr: a.fixesPr as number } : {}),
          }),
        );
        if (r) report(r);
      },
    )
    .command(
      'decision <id>',
      'validate and file decision-log events',
      (y) =>
        pacingOptions(
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('task-id', { type: 'string', demandOption: true })
            .option('answer', { type: 'string' })
            .option('rationale', { type: 'string' })
            .option('pr', { type: 'boolean', default: false }),
        ),
      async (a) => {
        if (
          !(await paced(a, a.id as string, `cli-file decision ${a.id} --task-id ${a.taskId} --pr`))
        )
          return;
        const r = guard(() =>
          fileDecision(repo, a.id as string, {
            taskId: a.taskId as string,
            answer: a.answer as string | undefined,
            rationale: a.rationale as string | undefined,
            pr: a.pr as boolean,
          }),
        );
        if (r) report(r);
      },
    )
    .command(
      'rebase <id>',
      'rebuild a conflicting filing branch in place (lease push, same PR) and re-arm it',
      (y) =>
        pacingOptions(
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('source', {
              type: 'string',
              describe: 'corrected task file that replaces the branch copy (same id required)',
            })
            .option('pr', { type: 'boolean', default: false }),
        ),
      async (a) => {
        if (!(await paced(a, a.id as string, `cli-file rebase ${a.id} --pr`))) return;
        const r = guard(() =>
          fileRebase(repo, a.id as string, {
            pr: a.pr as boolean,
            source: a.source as string | undefined,
          }),
        );
        if (r) report(r);
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
  return code;
}
