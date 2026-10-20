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
import { gateRunListArgs, parseGateRunId } from './gate-run.js';
import { classifyPr, type PrCheck, type PrFacts, type PrState } from './pr-state.js';
import { collectVerdicts, readInflightManifest, readQueuedManifest } from '../dispatch/board.js';
import { clearRuling, readRuling } from '../dispatch/ruling.js';
import type { TaskRuling } from '../dispatch/types.js';
import type { CommandRunner } from './types.js';

/** Task set: one action per classifier state (RFC-0054 ownership table). */
export const TASK_ACTIONS: Record<PrState, string> = {
  merged: 'mark-landed',
  'manifest-branch-mismatch': 'rewrite-manifest',
  // `land-prep` (AISDLC-881) is not built yet: `reenter` runs its rebase for a BEHIND PR.
  'behind-or-dirty': 'land-prep',
  'attestation-content-hash-mismatch': 'push-only-resign',
  'rate-limited': 'wait-and-rerun',
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
  'behind-or-dirty': 'rebase-in-place',
  'attestation-content-hash-mismatch': 'none',
  'rate-limited': 'wait-and-rerun',
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
  /** The planner ruling text that holds this PR (action `held`). */
  ruling?: string;
  /** Set when the same-head loop guard replaced the action with `route-to-planner`. */
  note?: string;
  /** Set when the last run of `action` failed; the next pass retries without a new history entry. */
  actionFailed?: boolean;
  /** `rate-limited` only: when the installation limit resets and the rerun may fire. */
  rateLimitResetAt?: string;
  /** `rate-limited` only: the head sha already rerun once; never rerun it again. */
  rerunHeadSha?: string;
  delivered?: string;
  landed?: string;
  /** Set once the PR is confirmed closed without landing; the record is not re-checked. */
  closedUnlanded?: string;
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
  /** Ruling text, when the action is `held`. */
  ruling?: string;
  /** Why the action was replaced (same-head loop guard). */
  note?: string;
}

/** A planner ruling on the PR's task, with whether its `until` task has merged (AISDLC-903). */
export interface RulingFacts {
  ruling: TaskRuling;
  untilMerged: boolean;
}

/** Task states a ruling holds: the ones that would otherwise reach the planner or a fix round. */
const HELD_ACTIONS = new Set(['reenter', 'route-to-planner']);

/** Classify one PR and pick its action from the set that owns it. Pure. */
export function decide(
  f: ReconcilePr,
  record?: LandingRecord,
  ruled?: RulingFacts,
  maxSameHeadActions = 1,
): Decision {
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
    return guardSameHead({ ...base, action }, f, record, maxSameHeadActions);
  }
  // A queued manifest with the wrong branch is repaired at once; an inflight one is reported.
  if (c.state === 'manifest-branch-mismatch' && f.manifestState !== undefined) {
    return { ...base, action: f.manifestState === 'queue' ? 'rewrite-manifest' : 'report-only' };
  }
  // Task set: the executor owns the PR until it is delivered (flipped ready); a stale
  // claim, or a dead executor after signing, hands it to the machine.
  const delivered = f.merged === true || f.draft === false || record?.delivered !== undefined;
  const takeover = f.executorDead === true && c.state === 'ready-to-flip';
  if (!delivered && !takeover) return { ...base, action: 'none' };
  const action = TASK_ACTIONS[c.state];
  if (ruled && c.state !== 'merged') {
    if (ruled.untilMerged) return { ...base, action: 'ready-to-requeue' };
    if (HELD_ACTIONS.has(action)) return { ...base, action: 'held', ruling: ruled.ruling.text };
  }
  return guardSameHead({ ...base, action }, f, record, maxSameHeadActions);
}

/** Actions that are not machine work on the PR, so the same-head guard never counts them. */
const GUARD_EXEMPT_ACTIONS = new Set([
  'none',
  'mark-landed',
  'route-to-planner',
  'report-only',
  'held',
  'ready-to-requeue',
  'wait-and-rerun',
]);

/** Names of actions in the guard note: the PR-facing verb, not the table's internal one. */
const GUARD_LABELS: Record<string, string> = { 'land-prep': 'rebase' };

/**
 * Same-head loop guard (AISDLC-883). An action that was already taken on this head
 * and did not change it is not taken again: the PR goes to the planner with the
 * `(action, head)` pair and the count as the note. A new head SHA resets the guard.
 * Only a return to the action counts (the PR left it and came back on the same head);
 * the same facts seen twice in a row are the idempotent no-op above, not a repeat.
 */
function guardSameHead(
  d: Decision,
  f: ReconcilePr,
  record: LandingRecord | undefined,
  maxSameHeadActions: number,
): Decision {
  if (!record || !f.headSha || GUARD_EXEMPT_ACTIONS.has(d.action)) return d;
  if (record.action === d.action) return d;
  const prior = record.history.filter(
    (h) => h.action === d.action && h.headSha === f.headSha,
  ).length;
  if (prior < maxSameHeadActions) return d;
  const label = GUARD_LABELS[d.action] ?? d.action;
  return { ...d, action: 'route-to-planner', note: `${label}@${f.headSha} x${prior + 1}` };
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

/** The argv an action runs, or null when it is record-only or left to a session. Pure. */
export const RUN_ID_PLACEHOLDER = '{runId}';

export interface ActionCommand {
  file: string;
  args: string[];
  /** Stdout is the gate run id; it replaces `{runId}` in later commands. Empty means no run. */
  captureRunId?: boolean;
}

export function actionCommands(ctx: ActionContext, cliBin: string): ActionCommand[] | null {
  const dispatch = (...a: string[]) => ({
    file: 'node',
    args: [path.join(cliBin, 'cli-dispatch.mjs'), ...a, '--board-dir', ctx.boardDir],
  });
  // `reenter` classifies the PR itself and runs the machine action or writes the manifest.
  const reenter = () => dispatch('reenter', String(ctx.pr));
  switch (ctx.action) {
    case 'reenter':
    case 'land-prep':
    case 'push-only-resign':
      return [reenter()];
    case 'rewrite-manifest':
      return [dispatch('write-manifest', '--task-id', ctx.taskId, '--from-pr', String(ctx.pr))];
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
    case 'rerun-rate-limited':
    case 'rerun-dor':
      return ctx.headSha
        ? [
            // `gh run rerun` takes a run id, not a commit: look the gate run up first.
            {
              file: 'gh',
              args: gateRunListArgs(ctx.headSha),
              captureRunId: true,
            },
            { file: 'gh', args: ['run', 'rerun', RUN_ID_PLACEHOLDER, '--failed'] },
          ]
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
    let runId: string | undefined;
    for (const c of cmds) {
      const args = c.args.map((a) => (a === RUN_ID_PLACEHOLDER && runId ? runId : a));
      const r = run(c.file, args, { cwd });
      if (r.status === 0 && c.captureRunId) {
        runId = parseGateRunId(r.stdout);
        if (!runId) return { ran: false, note: 'no gate run for head' };
        continue;
      }
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
  /** `route-to-planner` reports withheld this pass because the same key was already sent. */
  suppressed: number;
  /** AISDLC-929: `main: RED at <sha>`, `main: green` or `main: unknown`; undefined when not checked. */
  main?: string;
  /** Set once per red sha: the item the tick routes to the planner. */
  routed?: { action: 'route-to-planner'; text: string };
}

/** Dedupe ledger for planner reports, persisted on the board (AISDLC-924). */
interface PlannerRoutes {
  /** Keys `pr|headSha|reason` already sent to the planner. */
  sent: string[];
  /** Reports withheld since the last tick summary. */
  suppressed: number;
}

function routesPath(boardDir: string): string {
  return path.join(landingDir(boardDir), 'planner-routes.json');
}

function readRoutes(boardDir: string): PlannerRoutes {
  try {
    const r = JSON.parse(readFileSync(routesPath(boardDir), 'utf-8')) as Partial<PlannerRoutes>;
    return { sent: r.sent ?? [], suppressed: r.suppressed ?? 0 };
  } catch {
    return { sent: [], suppressed: 0 };
  }
}

function writeRoutes(boardDir: string, r: PlannerRoutes): void {
  mkdirSync(landingDir(boardDir), { recursive: true });
  const target = routesPath(boardDir);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

/** True the first time a (PR, head sha, reason) key is seen; later calls count a suppression. */
function firstRoute(boardDir: string, pr: number, headSha: string | undefined, reason: string) {
  const routes = readRoutes(boardDir);
  const key = `${pr}|${headSha ?? ''}|${reason}`;
  if (routes.sent.includes(key)) {
    writeRoutes(boardDir, { ...routes, suppressed: routes.suppressed + 1 });
    return false;
  }
  writeRoutes(boardDir, { ...routes, sent: [...routes.sent, key] });
  return true;
}

/** Health of main's latest completed monitor run. */
export interface MainHealth {
  status: 'red' | 'green' | 'unknown';
  sha?: string;
  runUrl?: string;
}

/** The monitor's conclusion for the main head, read through `gh`. Unreadable or no completed run is `unknown`. */
export function gatherMainHealth(run: CommandRunner, cwd: string): MainHealth {
  const head = run('gh', ['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha'], { cwd });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  if (!sha) return { status: 'unknown' };
  const listed = run(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      'main-health-monitor.yml',
      '--commit',
      sha,
      '--status',
      'completed',
      '--limit',
      '1',
      '--json',
      'conclusion,url',
    ],
    { cwd },
  );
  const runs =
    listed.status === 0 ? parse<{ conclusion?: string; url?: string }[]>(listed.stdout) : undefined;
  const latest = Array.isArray(runs) ? runs[0] : undefined;
  if (!latest?.conclusion) return { status: 'unknown', sha };
  if (latest.conclusion === 'success') return { status: 'green', sha };
  if (latest.conclusion === 'failure')
    return { status: 'red', sha, ...(latest.url ? { runUrl: latest.url } : {}) };
  return { status: 'unknown', sha };
}

function mainHealthPath(boardDir: string): string {
  return path.join(boardDir, 'main-health.json');
}

/** Report main's health; a red sha is routed to the planner once. */
export function reportMainHealth(
  boardDir: string,
  health: MainHealth,
): Pick<ReconcileReport, 'main' | 'routed'> {
  if (health.status === 'green') return { main: 'main: green' };
  if (health.status === 'unknown') return { main: 'main: unknown' };
  const short = (health.sha ?? '').slice(0, 8);
  const text = `main: RED at ${short}${health.runUrl ? ` ${health.runUrl}` : ''}`;
  let seen: string | undefined;
  try {
    seen = (JSON.parse(readFileSync(mainHealthPath(boardDir), 'utf-8')) as { redSha?: string })
      .redSha;
  } catch {
    seen = undefined;
  }
  if (seen === health.sha) return { main: text };
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(mainHealthPath(boardDir), JSON.stringify({ redSha: health.sha }) + '\n', 'utf-8');
  return { main: text, routed: { action: 'route-to-planner', text } };
}

/** One-line summary of the open landing records, for the tick's progress line. */
export function summariseLanding(boardDir: string): string {
  const open = listLanding(boardDir).filter((r) => !r.landed);
  const line = open.map((r) => `#${r.pr} ${r.kind} ${r.state}`).join(', ');
  const limited = open.filter((r) => r.state === 'rate-limited');
  if (limited.length === 0) return line;
  const resets = limited
    .map((r) => r.rateLimitResetAt ?? '')
    .filter(Boolean)
    .sort();
  const reset = resets.length > 0 ? ` (reset ${resets[resets.length - 1]})` : '';
  return `${line}; rate-limited: ${limited.length}${reset}`;
}

/** Suppressed planner reports since the last call, as a summary suffix. Resets the count. */
export function takeSuppressedNote(boardDir: string): string {
  const routes = readRoutes(boardDir);
  if (routes.suppressed === 0) return '';
  writeRoutes(boardDir, { ...routes, suppressed: 0 });
  return `planner reports suppressed: ${routes.suppressed}`;
}

/** The installation limit resets hourly; wait this long from first sight before the rerun. */
export const RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;

/** The quota resets on the hour: the next full hour after `now` (AISDLC-949). */
export function nextFullHour(now: Date): Date {
  return new Date((Math.floor(now.getTime() / RATE_LIMIT_WAIT_MS) + 1) * RATE_LIMIT_WAIT_MS);
}

export interface ReconcileOpts {
  boardDir: string;
  execute: ActionExecutor;
  now?: () => Date;
  /** AISDLC-929: main's health this pass, when the caller read it. */
  mainHealth?: MainHealth;
  /** `loopGuard.maxSameHeadActions` from `.ai-sdlc/pr-lifecycle.yaml`; default 1. */
  maxSameHeadActions?: number;
}

/** Reconcile a set of PR facts: update the records and run the actions. Idempotent. */
export function reconcile(facts: readonly ReconcilePr[], opts: ReconcileOpts): ReconcileReport {
  const now = opts.now ?? clockNow;
  const report: ReconcileReport = { records: [], acted: [], reported: [], suppressed: 0 };
  if (opts.mainHealth) Object.assign(report, reportMainHealth(opts.boardDir, opts.mainHealth));
  const routeOnce = (pr: number, headSha: string | undefined, reason: string): boolean => {
    const first = firstRoute(opts.boardDir, pr, headSha, reason);
    if (!first) report.suppressed++;
    return first;
  };
  for (const f of facts) {
    const existing = readLanding(opts.boardDir, f.prNumber);
    const ruled = rulingFacts(opts.boardDir, f, facts);
    const d = decide(f, existing, ruled, opts.maxSameHeadActions);
    // The hold is lifted: drop the ruling so it is not carried past the task it waited on.
    if (d.action === 'ready-to-requeue') {
      try {
        clearRuling(opts.boardDir, f.taskId);
      } catch {
        /* the task went inflight meanwhile; the ruling is dropped when it next finishes */
      }
    }
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
      existing.ruling === d.ruling &&
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
    if (unchanged && d.action === 'wait-and-rerun') {
      // One rerun per head sha, after the recorded reset time.
      const due =
        existing.rateLimitResetAt !== undefined &&
        Date.parse(existing.rateLimitResetAt) <= now().getTime();
      if (due && f.headSha !== undefined && existing.rerunHeadSha !== f.headSha) {
        const r = opts.execute({
          pr: f.prNumber,
          taskId: f.taskId,
          kind: d.kind,
          action: 'rerun-rate-limited',
          state: d.state,
          headSha: f.headSha,
          boardDir: opts.boardDir,
        });
        const updated: LandingRecord = {
          ...existing,
          rerunHeadSha: f.headSha,
          ...(r.failed ? { actionFailed: true } : {}),
        };
        writeLanding(opts.boardDir, updated);
        report.records.push(updated);
        report.acted.push({
          pr: f.prNumber,
          action: 'rerun-rate-limited',
          ran: r.ran,
          ...(r.note ? { note: r.note } : {}),
        });
        continue;
      }
      report.records.push(existing);
      continue;
    }
    if (unchanged) {
      if (
        d.action === 'route-to-planner' &&
        routeOnce(f.prNumber, f.headSha, d.failingLine ?? d.state)
      ) {
        report.acted.push({ pr: f.prNumber, action: d.action, ran: false });
      }
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
      ...(d.state === 'rate-limited'
        ? {
            rateLimitResetAt: nextFullHour(now()).toISOString(),
          }
        : {}),
      ...(d.ruling === undefined ? {} : { ruling: d.ruling }),
      ...(d.note === undefined ? {} : { note: d.note }),
      ...(deliveredAt === undefined ? {} : { delivered: deliveredAt }),
      ...(landedAt === undefined ? {} : { landed: landedAt }),
      history: [...(existing?.history ?? []), entry],
    };
    let result: ActionResult = { ran: false };
    if (!['none', 'mark-landed', 'held', 'ready-to-requeue', 'wait-and-rerun'].includes(d.action)) {
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
    const withheld =
      d.action === 'route-to-planner' &&
      !routeOnce(f.prNumber, f.headSha, d.failingLine ?? d.state);
    if (d.action !== 'none' && !withheld) {
      report.acted.push({
        pr: f.prNumber,
        action: d.action,
        ran: result.ran,
        ...(d.ruling === undefined ? {} : { note: `held: ${d.ruling}` }),
        ...(result.note || d.note ? { note: d.note ?? result.note } : {}),
      });
    }
  }
  return report;
}

/** The ruling on the PR's task, and whether the task it waits on has merged. */
function rulingFacts(
  boardDir: string,
  f: ReconcilePr,
  all: readonly ReconcilePr[],
): RulingFacts | undefined {
  if (!f.taskId) return undefined;
  const ruling = readRuling(boardDir, f.taskId);
  if (!ruling) return undefined;
  const until = ruling.until;
  const untilMerged =
    until !== undefined &&
    (all.some((o) => o.taskId === until && o.merged === true) ||
      listLanding(boardDir).some((r) => r.taskId === until && r.landed !== undefined));
  return { ruling, untilMerged };
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
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
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
  const t0 = Date.parse(c.startedAt ?? '');
  const t1 = Date.parse(c.completedAt ?? '');
  return {
    name: c.name ?? c.context ?? '',
    conclusion,
    ...(Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0
      ? { durationSec: Math.round((t1 - t0) / 1000) }
      : {}),
    ...(raw === 'SKIPPED' ? { skipped: true } : {}),
    ...(summary ? { summary } : {}),
    ...(c.detailsUrl ? { detailsUrl: c.detailsUrl } : {}),
  };
}

/** AISDLC-953: first annotation message of a failed job, when the rollup gave no summary. */
function fillSummaryFromAnnotations(run: CommandRunner, cwd: string, checks: PrCheck[]): void {
  for (const c of checks) {
    if (c.conclusion !== 'failure' || c.summary || c.name === 'ai-sdlc/pr-ready') continue;
    const jid = /\/job\/(\d+)/.exec(c.detailsUrl ?? '')?.[1];
    if (!jid) continue;
    const r = run(
      'gh',
      ['api', `repos/{owner}/{repo}/check-runs/${jid}/annotations`, '--jq', '.[].message'],
      { cwd },
    );
    const msg = r.status === 0 ? r.stdout.split('\n').find((l) => l.trim()) : undefined;
    if (msg) c.summary = msg.trim().slice(0, 300);
  }
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
    const checks = (rollup?.statusCheckRollup ?? []).map(normaliseCheck);
    fillSummaryFromAnnotations(run, cwd, checks);
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
      checks,
    });
  }
  // A record not yet landed whose PR left the open list: ask whether it merged.
  const open = new Set(facts.map((x) => x.prNumber));
  for (const r of listLanding(boardDir)) {
    if (r.landed || r.closedUnlanded || open.has(r.pr)) continue;
    const v = run('gh', ['pr', 'view', String(r.pr), '--json', 'state'], { cwd });
    const state = v.status === 0 ? parse<{ state?: string }>(v.stdout)?.state : undefined;
    if (state === 'CLOSED') {
      // Closed without landing: one confirmation, then the record expires (AISDLC-959).
      writeLanding(boardDir, { ...r, closedUnlanded: clockNow().toISOString() });
      continue;
    }
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
