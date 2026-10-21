/**
 * Superseded-PR close (AISDLC-1011, DEC-0266).
 *
 * The one mechanical exception to "never close a PR": a PR the CLI itself opened whose
 * every changed file is already byte-identical on main, and whose task or decision id
 * is carried by a landed PR, holds no work to discard. This module is the ONLY place
 * that runs `gh pr close`; it closes only when all three conditions hold:
 *
 *  (a) the head branch was opened by the CLI (`ai-sdlc/file-*`, `ai-sdlc/decisions-sync`,
 *      or an `ai-sdlc/<task-id>-*` branch whose task is Done);
 *  (b) a different, merged PR carries the same task or decision id;
 *  (c) every file in the PR diff has the same blob sha on GitHub's main as at the PR
 *      head (or the path is absent on both).
 *
 * Anything it cannot prove (a GitHub read failing, a truncated file list) is "not
 * superseded". The caller leaves such a PR where it was (route-to-planner).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { DECISIONS_SYNC_BRANCH } from '../decisions/remote-persist.js';
import type { CommandRunner } from './types.js';

/** `gh pr view --json files` is capped at this many entries; a full page is not provably complete. */
const FILE_LIST_CAP = 100;
const ID_RE = /\b[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/g;

export interface SupersededAudit {
  type: 'superseded-close';
  ts: string;
  pr: number;
  supersededBy: number;
  /** path -> blob sha (the shared content hash), or null when deleted on both sides. */
  contentHashes: Record<string, string | null>;
}

export type SupersededResult =
  | { closed: true; supersededBy: number; audit: SupersededAudit }
  | { closed: false; reason: string };

/** True when the branch name is one the CLI creates. Pure. */
export function isCliBranchShape(branch: string): boolean {
  return (
    branch === DECISIONS_SYNC_BRANCH ||
    branch.startsWith('ai-sdlc/file-') ||
    /^ai-sdlc\/[a-z][a-z0-9]*-\d+(?:\.\d+)*-/.test(branch)
  );
}

/** Task id named by an `ai-sdlc/<task-id>-*` branch, upper-cased, when the branch has that shape. */
function branchTaskId(branch: string): string | undefined {
  const m = /^ai-sdlc\/([a-z][a-z0-9]*-\d+(?:\.\d+)*)-/.exec(branch);
  return m ? m[1]!.toUpperCase() : undefined;
}

/** Whether `backlog/completed/` holds the task's file. */
export function taskIsDone(cwd: string, taskId: string): boolean {
  const dir = path.join(cwd, 'backlog', 'completed');
  if (!existsSync(dir)) return false;
  const prefix = `${taskId.toLowerCase()} `;
  return readdirSync(dir).some((f) => {
    const n = f.toLowerCase();
    return n.startsWith(prefix) || n.startsWith(`${taskId.toLowerCase()}-`);
  });
}

/** Task and decision ids a PR carries in its title, branch and changed paths. Pure. */
export function carriedIds(title: string, branch: string, files: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of [title, branch.toUpperCase(), ...files.map((x) => x.toUpperCase())]) {
    for (const m of text.matchAll(ID_RE)) found.add(m[0]);
  }
  return [...found];
}

interface PrView {
  state: string;
  headRefName: string;
  headRefOid: string;
  title: string;
  isCrossRepository: boolean;
  files: { path: string }[];
}

function readJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Blob sha of `file` at `ref` (default branch when omitted); null when absent; undefined when unreadable. */
function blobSha(
  run: CommandRunner,
  cwd: string,
  file: string,
  ref?: string,
): string | null | undefined {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const r = run(
    'gh',
    ['api', `repos/{owner}/{repo}/contents/${encodeURI(file)}${query}`, '--jq', '.sha'],
    { cwd },
  );
  if (r.status === 0) {
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }
  return /404|Not Found/i.test(`${r.stderr}${r.stdout}`) ? null : undefined;
}

/**
 * Close PR `pr` when it is superseded; otherwise change nothing. The audit record is
 * written BEFORE the close, so a failed audit write means no close.
 */
export function closeSupersededPr(
  run: CommandRunner,
  opts: { cwd: string; boardDir: string; pr: number; now: () => Date },
): SupersededResult {
  const { cwd, pr } = opts;
  const no = (reason: string): SupersededResult => ({ closed: false, reason });

  const view = run(
    'gh',
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'state,headRefName,headRefOid,title,isCrossRepository,files',
    ],
    { cwd },
  );
  const v = view.status === 0 ? readJson<PrView>(view.stdout) : undefined;
  if (!v) return no('could not read the PR');
  if (v.state !== 'OPEN') return no(`PR is ${v.state}`);
  if (v.isCrossRepository !== false) return no('fork PR');

  // (a) CLI-opened branch shape; a task branch also needs its task Done.
  if (!isCliBranchShape(v.headRefName)) return no('branch was not opened by the CLI');
  const taskId = branchTaskId(v.headRefName);
  if (taskId && !taskIsDone(cwd, taskId)) return no(`task ${taskId} is not Done`);

  const files = (v.files ?? []).map((x) => x.path);
  if (files.length === 0) return no('empty file list');
  if (files.length >= FILE_LIST_CAP) return no('file list may be truncated');

  // (b) a different merged PR carries the same task or decision id.
  const ids = carriedIds(v.title, v.headRefName, files);
  if (ids.length === 0) return no('PR names no task or decision id');
  let supersededBy: number | undefined;
  for (const id of ids) {
    const listed = run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--search',
        `${id} in:title`,
        '--limit',
        '20',
        '--json',
        'number,title,headRefName',
      ],
      { cwd },
    );
    const prs =
      listed.status === 0
        ? readJson<{ number: number; title?: string; headRefName?: string }[]>(listed.stdout)
        : undefined;
    const re = new RegExp(`\\b${id.replace(/[.]/g, '\\.')}(?![\\d.])`, 'i');
    const hit = prs?.find(
      (p) => p.number !== pr && (re.test(p.title ?? '') || re.test(p.headRefName ?? '')),
    );
    if (hit) {
      supersededBy = hit.number;
      break;
    }
  }
  if (supersededBy === undefined) return no('no landed PR carries the same id');

  // (c) every diff path is byte-identical on GitHub's main.
  const contentHashes: Record<string, string | null> = {};
  for (const f of files) {
    const onHead = blobSha(run, cwd, f, v.headRefOid);
    const onMain = blobSha(run, cwd, f);
    if (onHead === undefined || onMain === undefined) return no(`could not read ${f}`);
    if (onHead !== onMain) return no(`${f} differs on main`);
    contentHashes[f] = onMain;
  }

  const audit: SupersededAudit = {
    type: 'superseded-close',
    ts: opts.now().toISOString(),
    pr,
    supersededBy,
    contentHashes,
  };
  const auditDir = path.join(opts.boardDir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(path.join(auditDir, 'superseded-close.jsonl'), `${JSON.stringify(audit)}\n`);

  const body =
    `Closing as superseded: every file in this PR is already byte-identical on main, ` +
    `landed through #${supersededBy} (DEC-0266). No work is discarded.`;
  const commented = run('gh', ['pr', 'comment', String(pr), '--body', body], { cwd });
  if (commented.status !== 0) return no('could not post the comment');
  const closed = run('gh', ['pr', 'close', String(pr)], { cwd });
  if (closed.status !== 0) return no('gh pr close failed');
  return { closed: true, supersededBy, audit };
}
