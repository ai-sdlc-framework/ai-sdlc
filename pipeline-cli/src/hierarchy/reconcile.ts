/**
 * Coded PR reconciler (RFC-0054, AISDLC-829).
 *
 * The facts about open PRs are REST JSON and the decision is a table, so no model is
 * involved: this module lists open PRs, classifies each with `pr-state.ts`, keeps one
 * `landing/<pr>.json` record per PR (owner, state, action, history) and runs the one
 * action the table names. It is idempotent: the same facts twice give the same record
 * and no second action.
 *
 * Two action sets share the classifier: the task set (PRs with a task id, acted on
 * from `ready` on) and the docs set (filing, decision-sync and docs PRs, owned by the
 * machine from birth). The release-please PR is reported and never acted on.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { now as clockNow } from '../clock.js';
import { classifyPr, type PrCheck, type PrFacts, type PrState } from './pr-state.js';
import { collectVerdicts, readInflightManifest, readQueuedManifest } from '../dispatch/board.js';
import type { CommandRunner } from './types.js';

/** Task set: one action per classifier state (RFC-0054 ownership table). */
export const TASK_ACTIONS: Record<PrState, string> = {
  merged: 'mark-landed',
  'manifest-branch-mismatch': 'rewrite-manifest',
  'stale-claim': 'reap-resume',
  // `land-prep` (AISDLC-881) does not exist yet: a rebase resume stands in.
  'behind-or-dirty': 'land-prep',
  'attestation-content-hash-mismatch': 'push-only-resign',
  // `reenter` (AISDLC-882) does not exist yet: a resume carrying the failing line stands in.
  'real-failure': 'reenter',
  'cancelled-or-infra': 'retrigger-once',
  'ready-to-flip': 'flip-ready-takeover',
  'armed-clean': 'none',
  pending: 'none',
  'no-match': 'route-to-planner',
};

/** Docs set: one action per classifier state. */
export const DOCS_ACTIONS: Record<PrState, string> = {
  merged: 'mark-landed',
  'manifest-branch-mismatch': 'none',
  'stale-claim': 'none',
  'behind-or-dirty': 'rebase-in-place',
  'attestation-content-hash-mismatch': 'none',
  'real-failure': 'route-to-planner',
  'cancelled-or-infra': 'retrigger-once',
  'ready-to-flip': 'none',
  'armed-clean': 'none',
  pending: 'none',
  'no-match': 'arm',
};

/** Docs action used instead of `route-to-planner` when the failing check is the DoR gate. */
export const DOCS_DOR_ACTION = 'rerun-dor';

export type PrKind = 'task' | 'docs' | 'release';

/** Facts for one PR as the reconciler gathers them. */
export interface ReconcilePr extends PrFacts {
  title?: string;
  headSha?: string;
  /** Every changed file is documentation, backlog or spec. */
  docsOnly?: boolean;
  /** The executor that holds the task, for the record's owner. */
  executor?: string;
  /** The executor is gone after signing: the machine takes over. */
  executorDead?: boolean;
  /** Where the task's manifest sits on the board, when it has one. */
  manifestState?: 'queue' | 'inflight';
}

export interface LandingEntry {
  ts: string;
  state: PrState;
  action: string;
  headSha?: string;
}

export interface LandingRecord {
  pr: number;
  kind: Exclude<PrKind, 'release'>;
  taskId?: string;
  owner: string;
  state: PrState;
  action: string;
  headSha?: string;
  failingLine?: string;
  /** Set when the last run of `action` failed; the next pass retries without a new history entry. */
  actionFailed?: boolean;
  delivered?: string;
  landed?: string;
  history: LandingEntry[];
}

export const DOCS_BRANCH_PREFIXES = ['ai-sdlc/file-', 'ai-sdlc/decisions-sync', 'docs/'] as const;
const TASK_ID_IN_TEXT = /\b[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/;
const RELEASE_RE = /^chore: release\b|^release-please--/i;

/** Decide what kind of PR this is. Pure. A PR with no task id is a docs PR. */
export function detectKind(f: { title?: string; headBranch?: string; taskId?: string }): PrKind {
  if (RELEASE_RE.test(f.title ?? '') || RELEASE_RE.test(f.headBranch ?? '')) return 'release';
  const branch = f.headBranch ?? '';
  if (DOCS_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) return 'docs';
  return f.taskId ? 'task' : 'docs';
}

/** Task id from a branch or title, when one is named. */
export function taskIdFrom(branch?: string, title?: string): string {
  const fromBranch = /^ai-sdlc\/([a-z][a-z0-9]*-\d+(?:\.\d+)*)/i.exec(branch ?? '');
  if (fromBranch?.[1]) return fromBranch[1].toUpperCase();
  return TASK_ID_IN_TEXT.exec(title ?? '')?.[0] ?? '';
}

export interface Decision {
  kind: PrKind;
  state: PrState;
  action: string;
  failingLine?: string;
}

/** Classify one PR and pick its action from the set that owns it. Pure. */
export function decide(f: ReconcilePr, record?: LandingRecord): Decision {
  const kind = detectKind({
    ...(f.title === undefined ? {} : { title: f.title }),
    ...(f.headBranch === undefined ? {} : { headBranch: f.headBranch }),
    taskId: f.taskId,
  });
  if (kind === 'release') return { kind, state: 'no-match', action: 'report-only' };
  const c = classifyPr(f);
  const base = {
    kind,
    state: c.state,
    ...(c.failingLine === undefined ? {} : { failingLine: c.failingLine }),
  };
  if (kind === 'docs') {
    const checks = f.checks ?? [];
    let action = DOCS_ACTIONS[c.state];
    if (checks.some((k) => /dor/i.test(k.name) && k.conclusion === 'failure')) {
      if (c.state !== 'merged') action = DOCS_DOR_ACTION;
    } else if (c.state === 'no-match') {
      const green = checks.length > 0 && checks.every((k) => k.conclusion === 'success');
      if (!(green && f.mergeStateStatus === 'CLEAN' && !f.autoMergeArmed)) {
        action = 'route-to-planner';
      }
    }
    return { ...base, action };
  }
  // A queued manifest with the wrong branch is repaired at once; an inflight one is reported.
  if (c.state === 'manifest-branch-mismatch' && f.manifestState !== undefined) {
    return { ...base, action: f.manifestState === 'queue' ? 'rewrite-manifest' : 'report-only' };
  }
  // Task set: the executor owns the PR until it is delivered (flipped ready); a stale
  // claim, or a dead executor after signing, hands it to the machine.
  const delivered = f.merged === true || f.draft === false || record?.delivered !== undefined;
  const takeover = f.executorDead === true && c.state === 'ready-to-flip';
  if (!delivered && !takeover && c.state !== 'stale-claim') return { ...base, action: 'none' };
  return { ...base, action: TASK_ACTIONS[c.state] };
}

/** What an action did. */
export interface ActionResult {
  ran: boolean;
  note?: string;
  /** The action's command exited non-zero; the next pass retries it. */
  failed?: boolean;
}

export interface ActionContext {
  pr: number;
  taskId: string;
  kind: Exclude<PrKind, 'release'>;
  action: string;
  state: PrState;
  headSha?: string;
  failingLine?: string;
  boardDir: string;
}

export type ActionExecutor = (ctx: ActionContext) => ActionResult;

function note(text: string): string {
  // Resume notes are prose: one that starts like a command is refused by the board.
  return `Fix: ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
}

/** The argv an action runs, or null when it is record-only or left to a session. Pure. */
export function actionCommands(
  ctx: ActionContext,
  cliBin: string,
): { file: string; args: string[] }[] | null {
  const dispatch = (...a: string[]) => ({
    file: 'node',
    args: [path.join(cliBin, 'cli-dispatch.mjs'), ...a, '--board-dir', ctx.boardDir],
  });
  const sha = ctx.headSha ? ` (head ${ctx.headSha})` : '';
  const resume = (check: string, text: string) =>
    dispatch(
      'resume',
      '--task-id',
      ctx.taskId,
      '--pr',
      String(ctx.pr),
      '--failing-check',
      check,
      '--note',
      note(text),
    );
  switch (ctx.action) {
    case 'reenter':
      return [resume('ai-sdlc/pr-ready', `${ctx.failingLine ?? 'a required check failed'}${sha}`)];
    case 'land-prep':
      return [resume('ai-sdlc/pr-ready', `rebase onto origin/main, resolve conflicts, push${sha}`)];
    case 'push-only-resign':
      return [
        resume('ai-sdlc/attestation', `fetch origin, re-sign the attestation, push only${sha}`),
      ];
    case 'rewrite-manifest':
      return [dispatch('write-manifest', '--task-id', ctx.taskId, '--from-pr', String(ctx.pr))];
    case 'reap-resume':
      return [dispatch('reap')];
    case 'flip-ready-takeover':
      return [{ file: 'gh', args: ['pr', 'ready', String(ctx.pr)] }];
    case 'rebase-in-place':
      return [
        {
          file: 'node',
          args: [path.join(cliBin, 'cli-file.mjs'), 'rebase', ctx.taskId || String(ctx.pr), '--pr'],
        },
      ];
    case 'arm':
      return [
        {
          file: 'node',
          args: [
            path.join(cliBin, 'cli-merge-if-eligible.mjs'),
            String(ctx.pr),
            '--source-kind',
            'backlog',
            '--arm',
          ],
        },
      ];
    case 'retrigger-once':
    case 'rerun-dor':
      return ctx.headSha
        ? [{ file: 'gh', args: ['run', 'rerun', '--failed', '--commit', ctx.headSha] }]
        : null;
    default:
      return null;
  }
}

/** Default executor: runs the argv the action names through the injected runner. */
export function commandExecutor(run: CommandRunner, cwd: string, cliBin: string): ActionExecutor {
  return (ctx) => {
    const cmds = actionCommands(ctx, cliBin);
    if (!cmds) return { ran: false, note: 'record-only or left to a session' };
    for (const c of cmds) {
      const r = run(c.file, c.args, { cwd });
      if (r.status !== 0) {
        return {
          ran: true,
          failed: true,
          note: `${c.file} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`.trim(),
        };
      }
    }
    return { ran: true };
  };
}

export function landingDir(boardDir: string): string {
  return path.join(boardDir, 'landing');
}

export function landingPath(boardDir: string, pr: number): string {
  return path.join(landingDir(boardDir), `${pr}.json`);
}

export function readLanding(boardDir: string, pr: number): LandingRecord | undefined {
  try {
    return JSON.parse(readFileSync(landingPath(boardDir, pr), 'utf-8')) as LandingRecord;
  } catch {
    return undefined;
  }
}

/** All landing records on the board, by PR number. */
export function listLanding(boardDir: string): LandingRecord[] {
  const dir = landingDir(boardDir);
  if (!existsSync(dir)) return [];
  const out: LandingRecord[] = [];
  for (const f of readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))) {
    const r = readLanding(boardDir, Number.parseInt(f, 10));
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.pr - b.pr);
}

function writeLanding(boardDir: string, r: LandingRecord): void {
  mkdirSync(landingDir(boardDir), { recursive: true });
  const target = landingPath(boardDir, r.pr);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

export interface ReconcileReport {
  records: LandingRecord[];
  /** PRs whose facts changed this pass and whose action is not `none`. */
  acted: { pr: number; action: string; ran: boolean; note?: string }[];
  /** PRs reported and never acted on (the release-please PR). */
  reported: { pr: number; title?: string }[];
}

/** One-line summary of the open landing records, for the tick's progress line. */
export function summariseLanding(boardDir: string): string {
  const open = listLanding(boardDir).filter((r) => !r.landed);
  return open.map((r) => `#${r.pr} ${r.kind} ${r.state}`).join(', ');
}

export interface ReconcileOpts {
  boardDir: string;
  execute: ActionExecutor;
  now?: () => Date;
}

/** Reconcile a set of PR facts: update the records and run the actions. Idempotent. */
export function reconcile(facts: readonly ReconcilePr[], opts: ReconcileOpts): ReconcileReport {
  const now = opts.now ?? clockNow;
  const report: ReconcileReport = { records: [], acted: [], reported: [] };
  for (const f of facts) {
    const existing = readLanding(opts.boardDir, f.prNumber);
    const d = decide(f, existing);
    if (d.kind === 'release') {
      report.reported.push({
        pr: f.prNumber,
        ...(f.title === undefined ? {} : { title: f.title }),
      });
      continue;
    }
    const ts = now().toISOString();
    const delivered = f.merged === true || f.draft === false;
    const machineOwned =
      d.kind === 'docs' ||
      delivered ||
      existing?.owner === 'machine' ||
      (f.executorDead === true && d.action !== 'none');
    const owner = machineOwned ? 'machine' : `executor:${f.executor ?? 'unknown'}`;
    const unchanged =
      existing !== undefined &&
      existing.state === d.state &&
      existing.action === d.action &&
      existing.headSha === f.headSha &&
      existing.owner === owner;
    if (unchanged && existing.actionFailed === true && d.action !== 'none') {
      // A failed action is retried on the next pass; history is not appended again.
      const retry = opts.execute({
        pr: f.prNumber,
        taskId: f.taskId,
        kind: d.kind,
        action: d.action,
        state: d.state,
        ...(f.headSha === undefined ? {} : { headSha: f.headSha }),
        ...(d.failingLine === undefined ? {} : { failingLine: d.failingLine }),
        boardDir: opts.boardDir,
      });
      const { actionFailed: _drop, ...rest } = existing;
      const updated: LandingRecord = retry.failed ? { ...rest, actionFailed: true } : rest;
      writeLanding(opts.boardDir, updated);
      report.records.push(updated);
      report.acted.push({
        pr: f.prNumber,
        action: d.action,
        ran: retry.ran,
        ...(retry.note ? { note: retry.note } : {}),
      });
      continue;
    }
    if (unchanged) {
      report.records.push(existing);
      continue;
    }
    const entry: LandingEntry = {
      ts,
      state: d.state,
      action: d.action,
      ...(f.headSha === undefined ? {} : { headSha: f.headSha }),
    };
    const deliveredAt = existing?.delivered ?? (delivered || d.kind === 'docs' ? ts : undefined);
    const landedAt = existing?.landed ?? (d.state === 'merged' ? ts : undefined);
    const record: LandingRecord = {
      pr: f.prNumber,
      kind: d.kind,
      ...(f.taskId ? { taskId: f.taskId } : {}),
      owner,
      state: d.state,
      action: d.action,
      ...(f.headSha === undefined ? {} : { headSha: f.headSha }),
      ...(d.failingLine === undefined ? {} : { failingLine: d.failingLine }),
      ...(deliveredAt === undefined ? {} : { delivered: deliveredAt }),
      ...(landedAt === undefined ? {} : { landed: landedAt }),
      history: [...(existing?.history ?? []), entry],
    };
    let result: ActionResult = { ran: false };
    if (d.action !== 'none' && d.action !== 'mark-landed') {
      result = opts.execute({
        pr: f.prNumber,
        taskId: f.taskId,
        kind: d.kind,
        action: d.action,
        state: d.state,
        ...(f.headSha === undefined ? {} : { headSha: f.headSha }),
        ...(d.failingLine === undefined ? {} : { failingLine: d.failingLine }),
        boardDir: opts.boardDir,
      });
    }
    if (result.failed) record.actionFailed = true;
    writeLanding(opts.boardDir, record);
    report.records.push(record);
    if (d.action !== 'none') {
      report.acted.push({
        pr: f.prNumber,
        action: d.action,
        ran: result.ran,
        ...(result.note ? { note: result.note } : {}),
      });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Gathering facts through `gh`
// ---------------------------------------------------------------------------

interface ListedPr {
  number: number;
  title?: string;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  autoMergeRequest?: unknown;
  files?: { path: string }[];
  isCrossRepository?: boolean;
  author?: { login?: string };
}

/** PR number in a `.../pull/<n>` URL. */
function prNumberFromUrl(url?: string | null): number | undefined {
  const m = /\/pull\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Authors whose PRs the reconciler may act on: `AI_SDLC_RECONCILE_AUTHORS` (comma
 * separated) when set, else the authenticated `gh` user. Undefined when neither is known.
 */
export function allowedAuthors(
  run: CommandRunner,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | undefined {
  const fromEnv = (env['AI_SDLC_RECONCILE_AUTHORS'] ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return new Set(fromEnv);
  const me = run('gh', ['api', 'user', '--jq', '.login'], { cwd });
  const login = me.status === 0 ? me.stdout.trim().toLowerCase() : '';
  return login ? new Set([login]) : undefined;
}

/**
 * True when the task's own board record names this PR: a verdict or resume
 * feedback carrying the PR number, or an inflight manifest whose branch is the PR head. A PR
 * that merely names a task id in its branch or title is not enough.
 */
export function prBelongsToTask(
  boardDir: string,
  taskId: string,
  prNumber: number,
  headBranch: string | undefined,
  verdicts: readonly { taskId: string; prNumber?: number; prUrl?: string | null }[],
): boolean {
  const id = taskId.toLowerCase();
  for (const v of verdicts) {
    if (v.taskId.toLowerCase() !== id) continue;
    if (v.prNumber === prNumber || prNumberFromUrl(v.prUrl) === prNumber) return true;
  }
  const manifest = readInflightManifest(boardDir, taskId);
  if (manifest?.resume?.prNumber === prNumber) return true;
  const branch = manifest?.branch;
  if (branch !== undefined && headBranch !== undefined && branch === headBranch) return true;
  // A queued manifest holding the short form of the head (`<branch>-<slug>`) still owns the PR.
  const queued = readQueuedManifest(boardDir, taskId);
  if (queued?.resume?.prNumber === prNumber) return true;
  return (
    queued?.branch !== undefined &&
    headBranch !== undefined &&
    headBranch.startsWith(`${queued.branch}-`)
  );
}

interface RollupItem {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  description?: string;
  title?: string;
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const DOCS_FILE_RE = /^(backlog|docs|spec)\/|^\.ai-sdlc\/_decisions\/|\.md$/;

/** Normalise one check from the rollup. */
export function normaliseCheck(c: RollupItem): PrCheck {
  const raw = (c.conclusion || c.state || '').toUpperCase();
  const finished = c.status === undefined || c.status.toUpperCase() === 'COMPLETED';
  let conclusion: PrCheck['conclusion'] = 'pending';
  if (finished) {
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw)) conclusion = 'success';
    else if (raw === 'CANCELLED') conclusion = 'cancelled';
    else if (['STARTUP_FAILURE', 'TIMED_OUT', 'STALE'].includes(raw)) conclusion = 'infra';
    else if (['FAILURE', 'ERROR', 'ACTION_REQUIRED'].includes(raw)) conclusion = 'failure';
  }
  const summary = c.description ?? c.title;
  return { name: c.name ?? c.context ?? '', conclusion, ...(summary ? { summary } : {}) };
}

/** List open PRs and their checks. Returns undefined when GitHub cannot be read. */
export function gatherFacts(
  run: CommandRunner,
  cwd: string,
  boardDir: string,
): ReconcilePr[] | undefined {
  const listed = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,headRefName,headRefOid,isDraft,mergeStateStatus,autoMergeRequest,files,isCrossRepository,author',
    ],
    { cwd },
  );
  const prs = listed.status === 0 ? parse<ListedPr[]>(listed.stdout) : undefined;
  if (!Array.isArray(prs)) return undefined;
  const allowed = allowedAuthors(run, cwd);
  if (!allowed) return undefined;
  const verdicts = collectVerdicts(boardDir);
  const facts: ReconcilePr[] = [];
  for (const p of prs) {
    // A fork PR can name any task id; never act on one.
    if (p.isCrossRepository !== false) continue;
    const taskId = taskIdFrom(p.headRefName, p.title);
    const kind = detectKind({
      ...(p.title === undefined ? {} : { title: p.title }),
      ...(p.headRefName === undefined ? {} : { headBranch: p.headRefName }),
      taskId,
    });
    if (kind !== 'release') {
      if (!allowed.has((p.author?.login ?? '').toLowerCase())) continue;
      if (kind === 'task' && !prBelongsToTask(boardDir, taskId, p.number, p.headRefName, verdicts))
        continue;
    }
    const view = run('gh', ['pr', 'view', String(p.number), '--json', 'statusCheckRollup'], {
      cwd,
    });
    const rollup =
      view.status === 0 ? parse<{ statusCheckRollup?: RollupItem[] }>(view.stdout) : undefined;
    const files = p.files?.map((x) => x.path) ?? [];
    const queuedManifest = kind === 'task' ? readQueuedManifest(boardDir, taskId) : undefined;
    const inflightManifest = kind === 'task' ? readInflightManifest(boardDir, taskId) : undefined;
    const onBoard = inflightManifest ?? queuedManifest;
    facts.push({
      ...(onBoard?.branch === undefined
        ? {}
        : {
            manifestBranch: onBoard.branch,
            manifestState: inflightManifest ? ('inflight' as const) : ('queue' as const),
          }),
      prNumber: p.number,
      taskId,
      ...(p.title === undefined ? {} : { title: p.title }),
      ...(p.headRefName === undefined ? {} : { headBranch: p.headRefName }),
      ...(p.headRefOid === undefined ? {} : { headSha: p.headRefOid }),
      draft: p.isDraft === true,
      ...(p.mergeStateStatus === undefined ? {} : { mergeStateStatus: p.mergeStateStatus }),
      autoMergeArmed: p.autoMergeRequest != null,
      docsOnly: files.length > 0 && files.every((x) => DOCS_FILE_RE.test(x)),
      checks: (rollup?.statusCheckRollup ?? []).map(normaliseCheck),
    });
  }
  // A record not yet landed whose PR left the open list: ask whether it merged.
  const open = new Set(facts.map((x) => x.prNumber));
  for (const r of listLanding(boardDir)) {
    if (r.landed || open.has(r.pr)) continue;
    const v = run('gh', ['pr', 'view', String(r.pr), '--json', 'state'], { cwd });
    const state = v.status === 0 ? parse<{ state?: string }>(v.stdout)?.state : undefined;
    if (state === 'MERGED') {
      facts.push({
        prNumber: r.pr,
        taskId: r.taskId ?? '',
        merged: true,
        ...(r.headSha ? { headSha: r.headSha } : {}),
      });
    }
  }
  return facts;
}
