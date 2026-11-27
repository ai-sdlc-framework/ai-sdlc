/**
 * `cli-hierarchy status`: the roster joined with the harness session registry
 * and the board's inflight view.
 */

import { resolveArtifactsDir, resolveProjectRoot } from '../routing/artifacts-dir.js';
import {
  formatJudgmentLiveness,
  judgmentLiveness,
  type JudgmentLiveness,
} from './judgment-liveness.js';
import { collectVerdicts, listBoard, peekQueue } from '../dispatch/board.js';
import { readHold, type Hold } from './hold.js';
import { listHeld } from './held-triage.js';
import { listUnbriefed } from './auto-brief.js';
import type { QueueCounts } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SWEEP_STATUS_FILE, type SweepStatusRecord } from '../steps/00-sweep.js';
import { loadPrLifecycleConfig } from './pr-lifecycle-config.js';
import { AGING_WINDOW_MS, listLanding, readDocsSitePin, recordLastActionAt } from './reconcile.js';
import { formatPrTable } from './pr-rows.js';
import { paneNodeVersion, readNvmrc, versionMatches } from './node-pin.js';
import { hasLaunchEnv } from './up.js';
import { loadOperationalPolicy, mergeOffLines } from './operational.js';
import {
  callsPerSession,
  ghCallsPath,
  ledgerQuota,
  pruneGhCalls,
  readGhCalls,
  type Quota,
} from './gh-calls.js';
import {
  formatModuleHealth,
  readModuleHealth,
  defaultStoreDirs,
  readModuleMeasure,
  readModuleRotatePending,
  type ModuleHealth,
} from './module-health.js';
import { readSessionRegistry, reconcileStartingEntries } from './registry.js';
import { readRosterChecked, writeRoster } from './roster.js';
import {
  formatSchedulerStatus,
  schedulerStatus,
  type SchedulerStatus,
} from './reconcile-scheduler.js';
import { readLoopState } from './dispatch-loop.js';
import { formatLastTick, lastTickInfo } from './host-liveness.js';
import {
  formatWebhookForeign,
  formatWebhookStatus,
  webhookHealth,
  webhookStatus,
  type WebhookHealth,
  type WebhookStatus,
} from './webhook.js';
import { listWindows, paneInfo, paneStartCommand, sessionAttached } from './tmux.js';
import { contextWarning, formatContext, sessionContextTokens } from './context-size.js';
import {
  listStuckPrs,
  readOpenDrainStall,
  resolveStuckAfterMinutes,
  type DrainStallRecord,
  type StuckPrRow,
} from './drain-stall.js';
import { plannerFallbackLine } from './model-fallback.js';
import { budgetStatus, formatBudget, type BudgetStatus } from './budget.js';
import { dynamicExecutors, finishedAt } from './ephemeral-tick.js';
import { executorCap, formatExecutorCap, type ExecutorCap } from './executor-cap.js';
import { formatOpenPrs, openPrState, type OpenPrState } from './open-pr-limit.js';
import { readRotateRequests } from './rotate-request.js';
import { resolveThresholds } from './thresholds.js';
import type { HierarchyDeps, HierarchyRole, RosterEntry } from './types.js';

/** A rostered dynamic executor whose verdict is older than this is flagged `finished, not stopped` (AISDLC-1417). */
export const FINISHED_NOT_STOPPED_MS = 10 * 60 * 1000;

/** Live state of one roster entry. */
export type LiveState = 'busy' | 'idle' | 'starting' | 'gone' | 'unknown';

/** One row of the status table. */
export interface StatusRow {
  entry: RosterEntry;
  state: LiveState;
  /** True when a tmux client is attached to the entry's session. */
  attached: boolean;
  /** Task the session holds in `inflight/`, when its heartbeat names it. */
  inflightTask?: string;
  /**
   * AISDLC-1417: a dynamic executor still rostered more than {@link FINISHED_NOT_STOPPED_MS}
   * after its task's verdict: the teardown missed it. Shown instead of the live state.
   */
  finishedNotStopped?: true;
  /** Pipeline phase of that task (AISDLC-1226). */
  phase?: string;
  /** The PR this executor is landing and its state, e.g. `#12 ci-pending` (AISDLC-816). */
  landing?: string;
  /**
   * Whether the running session was launched with the env the lease-push hook binds it by.
   * Absent when the window is gone or tmux cannot report its start command.
   */
  launchEnv?: 'ok' | 'missing';
  /** Node version the pane's processes run; absent when it cannot be read. */
  nodeVersion?: string;
  /** True when `nodeVersion` does not satisfy the version `.nvmrc` pins (AISDLC-812). */
  nodeMismatch?: boolean;
  /** Hooks-module heartbeat (AISDLC-1061); `absent` when the session never wrote one. */
  module: ModuleHealth;
  /** Context tokens from the transcript tail (AISDLC-1066); absent when the transcript cannot be found. */
  contextTokens?: number;
  /** True when `contextTokens` exceeds the role's clear threshold. */
  overThreshold?: boolean;
  /** The module's own last `session.measure` count (AISDLC-1100); absent when it never measured. */
  moduleTokens?: number;
  /** The module deferred a rotation to the turn end (AISDLC-1159). */
  rotatePending?: boolean;
  /** Pending rotate request dispatch made of this session and its age (AISDLC-1150). */
  rotateRequest?: { at: string; ageSec: number };
  /** Present with `launchEnv: 'missing'`: how to repair it. */
  nextStep?: string;
}

/** Result of `status`. */
export interface StatusResult {
  rows: StatusRow[];
  board: QueueCounts;
  /** The local webhook receiver (AISDLC-880). */
  webhook: WebhookStatus;
  /** Class and signals of the webhook path (AISDLC-1157); absent when no secret is set. */
  webhookHealth?: WebhookHealth;
  /** The detached reconcile scheduler (AISDLC-932). */
  scheduler: SchedulerStatus;
  /** Age and author of the last dispatch tick (AISDLC-1096); absent when none was recorded. */
  lastTick?: { ageSec: number; by: 'host' | 'scheduler' };
  /** Per-role context-clear thresholds in tokens (AISDLC-815), from `<board-dir>/config.json`. */
  contextThresholds?: Record<HierarchyRole, number>;
  /** Token budget pace from `usage.json` (AISDLC-1072); absent when never sampled. */
  budget?: BudgetStatus;
  /** Planner model fallback line (AISDLC-1364); absent when no fallback is active. */
  modelFallback?: string;
  /** AISDLC-1316: recorded docs site pin state when the last bump run was skipped or failed. */
  docsSitePin?: { state: 'skipped' | 'failed'; runUrl?: string };
  /** The board hold (AISDLC-1319): who set it, since when and why; absent when not held. */
  hold?: Hold;
  /** Spawn cap: min of executors.max and the pacer allowance (AISDLC-1076). */
  executorCap?: ExecutorCap;
  /** Open task PRs against the limit that holds new tasks (AISDLC-1189). */
  openPrs?: OpenPrState;
  /** Dispatchable tasks on no brief and not on the board (AISDLC-930); absent when none. */
  unbriefed?: string[];
  /** Tasks parked in `blocked/` with the reason (AISDLC-1043); absent when none. */
  blocked?: { taskId: string; reason: string }[];
  /** Queued tasks held on a dependency, with the hold class (AISDLC-1244); absent when none. */
  held?: { taskId: string; dependency: string; class: string }[];
  /** Open PRs no lane owns (AISDLC-1091); `unowned PRs: N` in the text view. */
  unowned?: number;
  /** AISDLC-1092: open PRs with no state change for the aging window, oldest first. */
  /** AISDLC-1190: open PRs routed to the planner and not yet landed or closed, with how long each has waited. */
  routedToPlanner?: { pr: number; waitMs: number; reason: string }[];
  agedPrs?: { pr: number; ageMs: number; lane: string; lastAction: string }[];
  /** AISDLC-1095: every open PR with lane, action, reason, owner and age, as text lines. */
  prTable?: string[];
  /** `gh` calls in the last hour by HIERARCHY_SESSION (AISDLC-963). */
  ghCallsPerHour?: Record<string, number>;
  /** Live remaining quota for the core and graphql buckets; absent when `gh` cannot say. */
  quota?: Quota;
  /** The open drain stall (AISDLC-1101); absent when the drain is moving. */
  drainStall?: DrainStallRecord;
  /**
   * AISDLC-1156 (DEC-0291): failed verdicts with a signature or review that reached no terminal state
   * (repaired and delivered, a timeboxed Decision, an operator notification).
   */
  stuck?: StuckPrRow[];
  /** `stuckAfterMinutes` in force; `status --check` exits 1 when a stuck entry is older. */
  stuckAfterMinutes?: number;
  /** Spawn errors of the last tick (AISDLC-1117). */
  spawnErrors?: { taskId: string; error: string }[];
  /** Worktree directories, how many the last sweep could not remove, and the alarm ceiling (AISDLC-1108). */
  worktrees?: { count: number; removable: number; ceiling: number };
  /** AISDLC-1351: why this board will never merge, one line per cause; absent when merging is configured. */
  mergeOff?: string[];
  /** AISDLC-1442: whether the judgment layer is calling its provider, from the judgment log. */
  judgment?: JudgmentLiveness;
}

/** Count `.worktrees/*` directories and read the last sweep's unremoved-removable count. */
export function worktreeStatus(deps: HierarchyDeps): NonNullable<StatusResult['worktrees']> {
  const ceiling = loadPrLifecycleConfig(deps.cwd).hierarchy.worktrees.ceiling;
  const dir = join(deps.cwd, '.worktrees');
  let count = 0;
  try {
    count = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    // no .worktrees directory
  }
  let removable = 0;
  try {
    const p = join(deps.cwd, SWEEP_STATUS_FILE);
    if (existsSync(p)) {
      removable = (JSON.parse(readFileSync(p, 'utf8')) as SweepStatusRecord).removable || 0;
    }
  } catch {
    // unreadable record: report none
  }
  return { count, removable, ceiling };
}

/** `worktrees: <count> (<n> removable)` plus an alarm line above the ceiling. */
export function formatWorktrees(w: StatusResult['worktrees']): string[] {
  if (!w) return [];
  const lines = [`worktrees: ${w.count} (${w.removable} removable)`];
  if (w.count > w.ceiling) {
    lines.push(
      `ALARM: ${w.count} worktrees exceed the ceiling of ${w.ceiling}; run \`/ai-sdlc:cleanup\` or check that the dispatch tick sweep is running`,
    );
  }
  return lines;
}

/** Join the roster with the registry, tmux and the board. */
export function hierarchyStatus(
  deps: HierarchyDeps,
  _opts: { rosterOnly?: boolean } = {},
): StatusResult {
  const checked = readRosterChecked(deps.boardDir);
  const { rejected } = checked;
  let roster = checked.roster;
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  const registry = readSessionRegistry(deps.registryDir);
  // Entries stuck in `starting` take their registry name; persisted unless that would drop
  // a rejected entry from the file.
  const reconciled = reconcileStartingEntries(roster.sessions, registry);
  if (reconciled.changed > 0) {
    roster = { ...roster, sessions: reconciled.entries };
    if (rejected.length === 0) {
      try {
        // AISDLC-1258: re-read just before the write. The roster in hand predates any
        // `restart` that finished meanwhile, and writing it back would restore the old pane.
        const fresh = readRosterChecked(deps.boardDir);
        if (fresh.rejected.length === 0) {
          const again = reconcileStartingEntries(fresh.roster.sessions, registry);
          if (again.changed > 0) {
            writeRoster(deps.boardDir, { ...fresh.roster, sessions: again.entries });
          }
        }
      } catch {
        /* status stays read-only on a write failure */
      }
    }
  }
  const windows = new Set<string>();
  for (const tmuxSession of new Set(roster.sessions.map((e) => e.tmuxSession))) {
    for (const w of listWindows(deps.run, tmuxSession)) windows.add(`${tmuxSession}:${w}`);
  }
  const inflight = listInflight(deps.boardDir);
  let landings: ReturnType<typeof listLanding> = [];
  try {
    landings = listLanding(deps.boardDir).filter((l) => !l.landed);
  } catch {
    /* an unreadable landing dir must not break status */
  }
  const attachedBySession = new Map<string, boolean>();
  const isAttached = (tmuxSession: string): boolean => {
    let v = attachedBySession.get(tmuxSession);
    if (v === undefined) {
      v = sessionAttached(deps.run, tmuxSession);
      attachedBySession.set(tmuxSession, v);
    }
    return v;
  };

  const wantedNode = readNvmrc(deps.cwd);
  const thresholdsByRole = resolveThresholds(deps.boardDir);
  let budgetNow: BudgetStatus | undefined;
  try {
    budgetNow = budgetStatus(deps.boardDir, deps.now().getTime());
  } catch {
    /* an unreadable usage file must not break status */
  }
  const modelFallbackNow = plannerFallbackLine(deps);
  const boardHold = readHold(deps.boardDir) ?? undefined;
  let resourcesNow: ReturnType<HierarchyDeps['resources']> | undefined;
  try {
    resourcesNow = deps.resources();
  } catch {
    /* an unmeasurable machine adds no load limit */
  }
  const capNow = executorCap(deps.boardDir, deps.now().getTime(), deps.env, budgetNow, {
    ...(resourcesNow ? { resources: resourcesNow } : {}),
    live: dynamicExecutors(deps.boardDir).length,
  });
  const rotateRequests = readRotateRequests(deps.boardDir);
  const dynamicNames = new Set(dynamicExecutors(deps.boardDir).map((e) => e.name));
  let verdicts: ReturnType<typeof collectVerdicts> = [];
  try {
    verdicts = dynamicNames.size > 0 ? collectVerdicts(deps.boardDir) : [];
  } catch {
    /* an unreadable verdict must not break status */
  }
  const rows = roster.sessions.map((entry): StatusRow => {
    const live =
      registry.find((r) => r.name === entry.name) ??
      registry.find((r) => r.pid === entry.pid && entry.pid > 0);
    let state: LiveState;
    const alive = windows.has(`${entry.tmuxSession}:${entry.tmuxWindow}`);
    if (!alive) state = 'gone';
    else if (live) {
      state = live.status === 'busy' ? 'busy' : live.status === 'idle' ? 'idle' : 'unknown';
    } else state = 'starting';
    const held = inflight.find((i) => i.workerId === entry.name);
    const verdictAt = dynamicNames.has(entry.name) ? finishedAt(entry, verdicts) : undefined;
    const finishedNotStopped =
      verdictAt !== undefined && deps.now().getTime() - verdictAt > FINISHED_NOT_STOPPED_MS;
    const owned = landings.find((l) => l.owner === `executor:${entry.name}`);
    const startCommand = alive
      ? paneStartCommand(deps.run, entry.tmuxSession, entry.tmuxWindow)
      : '';
    const launchEnv: StatusRow['launchEnv'] =
      startCommand === ''
        ? undefined
        : hasLaunchEnv(startCommand, entry.name, entry.role)
          ? 'ok'
          : 'missing';
    const nodeVersion = !alive
      ? undefined
      : (entry.nodeVersion ??
        paneNodeVersion(deps.run, paneInfo(deps.run, entry.tmuxSession, entry.tmuxWindow).panePid));
    const nodeMismatch =
      nodeVersion !== undefined &&
      wantedNode !== undefined &&
      !versionMatches(wantedNode, nodeVersion);
    const contextTokens = alive ? sessionContextTokens(deps, live) : undefined;
    const moduleTokens = alive
      ? readModuleMeasure(defaultStoreDirs(), entry.name)?.tokens
      : undefined;
    const rotatePending = alive && readModuleRotatePending(defaultStoreDirs(), entry.name);
    return {
      entry,
      state,
      ...(finishedNotStopped ? { finishedNotStopped: true as const } : {}),
      ...(rotatePending ? { rotatePending } : {}),
      ...(contextTokens !== undefined
        ? { contextTokens, overThreshold: contextTokens > thresholdsByRole[entry.role] }
        : {}),
      ...(rotateRequests[entry.name] && Number.isFinite(Date.parse(rotateRequests[entry.name]!))
        ? {
            rotateRequest: {
              at: rotateRequests[entry.name]!,
              ageSec: Math.max(
                0,
                Math.round((deps.now().getTime() - Date.parse(rotateRequests[entry.name]!)) / 1000),
              ),
            },
          }
        : {}),
      ...(nodeVersion ? { nodeVersion } : {}),
      ...(nodeMismatch ? { nodeMismatch } : {}),
      module: readModuleHealth(deps.boardDir, entry, deps.now()),
      ...(moduleTokens !== undefined ? { moduleTokens } : {}),
      attached: alive && isAttached(entry.tmuxSession),
      inflightTask: held?.taskId,
      ...(held?.phase ? { phase: held.phase } : {}),
      ...(owned
        ? {
            landing: `#${owned.pr} ${owned.delivered ? 'delivered' : 'undelivered'}:${owned.state}`,
          }
        : {}),
      ...(launchEnv ? { launchEnv } : {}),
      ...(launchEnv === 'missing'
        ? {
            nextStep: `relaunch with \`cli-hierarchy down --role ${entry.role}\` then \`up\` from the main checkout's build`,
          }
        : {}),
    };
  });
  let unbriefed: string[] = [];
  try {
    unbriefed = listUnbriefed(deps.cwd, deps.boardDir);
  } catch {
    /* an unreadable backlog must not break status */
  }
  let blocked: { taskId: string; reason: string }[] = [];
  try {
    blocked = listBoard(deps.boardDir, deps.now)
      .filter((e) => e.state === 'blocked')
      .map((e) => ({ taskId: e.taskId, reason: e.reason ?? 'no reason recorded' }));
  } catch {
    /* an unreadable board must not break status */
  }
  let held: { taskId: string; dependency: string; class: string }[] = [];
  try {
    held = listHeld(deps.boardDir, deps.cwd).map((r) => ({
      taskId: r.taskId,
      dependency: r.dependency,
      class: r.class,
    }));
  } catch {
    /* an unreadable board must not break status */
  }
  let ghCallsPerHour: Record<string, number> = {};
  let quota: Quota | undefined;
  try {
    const log = ghCallsPath(deps.boardDir);
    pruneGhCalls(log, deps.now());
    const calls = readGhCalls(log);
    ghCallsPerHour = callsPerSession(calls, deps.now());
    // AISDLC-1440: the quota is the ledger's latest reading; status never polls `gh api rate_limit`.
    quota = ledgerQuota(calls, deps.now());
  } catch {
    /* an unreadable call log must not break status */
  }
  const drainStall = readOpenDrainStall(deps.boardDir);
  let webhookHealthReading: WebhookHealth | undefined;
  try {
    if (deps.env.AI_SDLC_WEBHOOK_SECRET) webhookHealthReading = webhookHealth(deps);
  } catch {
    /* an unreadable health reading must not break status */
  }
  let stuck: StuckPrRow[] = [];
  try {
    stuck = listStuckPrs(deps.boardDir, deps.now);
  } catch {
    /* an unreadable board must not break status */
  }
  const docsPin = readDocsSitePin(deps.boardDir);
  const lastTick = lastTickInfo(deps.boardDir, deps.now());
  const spawnErrors = readLoopState(deps.boardDir).lastSpawnErrors ?? [];
  const nowMs = deps.now().getTime();
  const agedPrs = landings
    .flatMap((l) => {
      const at = Date.parse(recordLastActionAt(l) ?? '');
      const ageMs = nowMs - at;
      return Number.isFinite(at) && !l.closedUnlanded && ageMs >= AGING_WINDOW_MS
        ? [{ pr: l.pr, ageMs, lane: l.owner, lastAction: l.action }]
        : [];
    })
    .sort((a, b) => b.ageMs - a.ageMs);
  const routedToPlanner = landings
    .filter((l) => l.action === 'route-to-planner' && !l.landed && !l.closedUnlanded)
    .map((l) => {
      let since = recordLastActionAt(l);
      for (let i = l.history.length - 1; i >= 0 && l.history[i]!.action === 'route-to-planner'; i--)
        since = l.history[i]!.ts;
      const at = Date.parse(since ?? '');
      return {
        pr: l.pr,
        waitMs: Number.isFinite(at) ? Math.max(0, nowMs - at) : 0,
        reason: l.failingLine ?? l.note ?? l.state,
      };
    })
    .sort((a, b) => b.waitMs - a.waitMs);
  let mergeOff: string[] = [];
  try {
    mergeOff = mergeOffLines(
      (deps.loadPolicy ?? ((r: string) => loadOperationalPolicy(r, r)))(deps.cwd),
    );
  } catch {
    /* an unreadable policy must not stop status */
  }
  let judgment: JudgmentLiveness | undefined;
  try {
    judgment = judgmentLiveness(resolveArtifactsDir(resolveProjectRoot(deps.cwd)), deps.now());
  } catch {
    /* an unreadable judgment log must not break status */
  }
  return {
    rows,
    ...(judgment ? { judgment } : {}),
    ...(mergeOff.length > 0 ? { mergeOff } : {}),
    ...(routedToPlanner.length > 0 ? { routedToPlanner } : {}),
    ...(agedPrs.length > 0 ? { agedPrs } : {}),
    prTable: formatPrTable(deps.boardDir, nowMs, loadPrLifecycleConfig(deps.cwd).maxCiRounds),
    unowned: landings.filter((l) => l.owner === 'unowned').length,
    ...(drainStall ? { drainStall } : {}),
    ...(stuck.length > 0
      ? { stuck, stuckAfterMinutes: resolveStuckAfterMinutes(deps.boardDir) }
      : {}),
    ...(spawnErrors.length > 0 ? { spawnErrors } : {}),
    ...(Object.keys(ghCallsPerHour).length > 0 ? { ghCallsPerHour } : {}),
    ...(quota ? { quota } : {}),
    board: peekQueue(deps.boardDir),
    worktrees: worktreeStatus(deps),
    webhook: webhookStatus(deps),
    ...(webhookHealthReading ? { webhookHealth: webhookHealthReading } : {}),
    scheduler: schedulerStatus(deps),
    ...(lastTick ? { lastTick } : {}),
    contextThresholds: thresholdsByRole,
    ...(budgetNow ? { budget: budgetNow } : {}),
    ...(modelFallbackNow ? { modelFallback: modelFallbackNow } : {}),
    ...(boardHold ? { hold: boardHold } : {}),
    ...(docsPin && docsPin.state !== 'ok'
      ? { docsSitePin: { ...docsPin, state: docsPin.state } }
      : {}),
    executorCap: capNow,
    openPrs: openPrState(deps.boardDir, deps.env),
    ...(unbriefed.length > 0 ? { unbriefed } : {}),
    ...(blocked.length > 0 ? { blocked } : {}),
    ...(held.length > 0 ? { held } : {}),
  };
}

/** Render the status result as a plain-text table. */
/** Human age such as `5m` or `2h10m` for a dynamic executor's `startedAt`. */
export function formatAge(startedAt: string, nowMs: number): string {
  const ms = nowMs - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`;
}

/** The STATE cell: `finished, not stopped` for a missed teardown (AISDLC-1417), else the live state. */
function stateLabel(r: StatusRow): string {
  return r.finishedNotStopped ? 'finished, not stopped' : r.state;
}

export function formatStatus(result: StatusResult, nowMs: number = Number.NaN): string[] {
  const dynamicLines = result.rows
    .filter((r) => r.entry.taskId !== undefined)
    .map(
      (r) =>
        `dynamic executor: ${r.entry.name} task ${r.entry.taskId} age ${formatAge(r.entry.startedAt, nowMs)} (${stateLabel(r)})`,
    );
  dynamicLines.push(
    ...(result.spawnErrors ?? []).map((e) => `spawn error: task ${e.taskId}: ${e.error}`),
  );
  const t = result.contextThresholds;
  const thresholds = t
    ? [
        `context clear thresholds (tokens): planner ${t.planner}, operator-dispatch ${t['operator-dispatch']}, executor ${t.executor}`,
      ]
    : [];
  const budgetLine = [
    ...(result.judgment ? [formatJudgmentLiveness(result.judgment, nowMs)] : []),
    ...(result.hold
      ? [
          `HOLD by ${result.hold.by || 'unknown'} since ${result.hold.since || 'unknown'}: ${result.hold.reason}`,
        ]
      : []),
    ...(result.budget ? [formatBudget(result.budget)] : []),
    ...(result.modelFallback ? [result.modelFallback] : []),
    ...(result.executorCap ? [formatExecutorCap(result.executorCap)] : []),
    ...(result.openPrs ? [formatOpenPrs(result.openPrs)] : []),
  ];
  const unbriefed = result.unbriefed?.length
    ? [
        `unbriefed (dispatchable, on no brief, not on the board): ${result.unbriefed.join(', ')}; write a brief with \`cli-hierarchy brief --tasks <id,...>\``,
      ]
    : [];
  const ghLines = formatGhCalls(result);
  const stallLines = result.drainStall
    ? [
        `drain-stall: open since ${result.drainStall.since}, stalled stage ${result.drainStall.stage}, ${result.drainStall.eligible} eligible queued, idle ${result.drainStall.idleExecutors.join(', ')}`,
      ]
    : [];
  const stuckLines =
    result.stuck && result.stuck.length > 0
      ? [
          'stuck:',
          ...result.stuck.map(
            (r) =>
              `  PR #${r.pr} (${r.taskId}): ${r.cause}, age ${r.ageMinutes}m, missing ${r.missing.join(', ')}`,
          ),
        ]
      : [];
  const docsPinLine = result.docsSitePin
    ? [
        `docs site pin: ${result.docsSitePin.state}${result.docsSitePin.runUrl ? ` (${result.docsSitePin.runUrl})` : ''}; the website was not updated by the last bump run`,
      ]
    : [];
  const unownedLine = `unowned PRs: ${result.unowned ?? 0}`;
  const agedLines = (result.agedPrs ?? []).map(
    (a) =>
      `aged PR #${a.pr}: ${formatAge(new Date(0).toISOString(), a.ageMs)}, lane ${a.lane}, last action ${a.lastAction}`,
  );
  const routedLines = (result.routedToPlanner ?? []).map(
    (r) =>
      `held for planner: PR #${r.pr} waiting ${formatAge(new Date(0).toISOString(), r.waitMs)} (${r.reason})`,
  );
  const heldLines = (result.held ?? []).map(
    (h) => `held: ${h.taskId} (waits on ${h.dependency}) [${h.class}]`,
  );
  const blockedLines = (result.blocked ?? []).map((b) => `blocked: ${b.taskId}: ${b.reason}`);
  if (result.rows.length === 0)
    return [
      'no sessions in the roster',
      ...dynamicLines,
      formatWebhookStatus(result.webhook, result.webhookHealth),
      ...formatWebhookForeign(result.webhookHealth),
      formatSchedulerStatus(result.scheduler),
      ...formatWorktrees(result.worktrees),
      formatLastTick(result.lastTick),
      ...thresholds,
      ...budgetLine,
      ...unbriefed,
      ...blockedLines,
      ...heldLines,
      ...stallLines,
      ...stuckLines,
      ...docsPinLine,
      unownedLine,
      ...agedLines,
      ...routedLines,
      ...(result.prTable ?? []),
      ...ghLines,
    ];
  const header = [
    'ROLE',
    'NAME',
    'STATE',
    'ATTACHED',
    'MODEL',
    'MODE',
    'INFLIGHT',
    'LANDING',
    'ENV',
    'NODE',
    'MODULE',
    'CONTEXT',
    'HIERARCHY_SESSION',
    'HIERARCHY_ROLE',
  ];
  const body = result.rows.map((r) => [
    r.entry.role,
    r.entry.name,
    stateLabel(r),
    r.attached ? 'yes' : 'no',
    r.entry.model,
    r.entry.permissionMode,
    r.inflightTask ? `${r.inflightTask}${r.phase ? ` (${r.phase})` : ''}` : '-',
    r.landing ?? '-',
    r.launchEnv ?? '-',
    r.nodeVersion ? `${r.nodeVersion}${r.nodeMismatch ? ' MISMATCH' : ''}` : '-',
    (r.moduleTokens !== undefined
      ? `${formatModuleHealth(r.module)} (measured ${r.moduleTokens})`
      : formatModuleHealth(r.module)) + (r.rotatePending ? ' rotate pending' : ''),
    r.state === 'gone' ? '-' : formatContext(r.contextTokens, r.overThreshold),
    r.entry.tmuxSession,
    r.entry.role,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const { queued, inflight, done, failed } = result.board;
  const repairs = result.rows.flatMap((r) =>
    r.nextStep ? [`env missing on ${r.entry.name}: ${r.nextStep}`] : [],
  );
  const nodeRepairs = result.rows.flatMap((r) =>
    r.nodeMismatch
      ? [
          `node mismatch on ${r.entry.name}: runs ${r.nodeVersion}, .nvmrc pins another version; relaunch with \`cli-hierarchy down --role ${r.entry.role}\` then \`up\``,
        ]
      : [],
  );
  const overLines = [
    ...contextWarnings(result),
    ...result.rows.flatMap((r) =>
      r.rotateRequest
        ? [
            `rotate requested of ${r.entry.name} ${r.rotateRequest.ageSec} s ago; waiting for its turn boundary`,
          ]
        : [],
    ),
  ];
  return [
    fmt(header),
    ...body.map(fmt),
    ...(repairs.length + nodeRepairs.length + overLines.length > 0
      ? ['', ...repairs, ...nodeRepairs, ...overLines]
      : []),
    ...(dynamicLines.length > 0 ? ['', ...dynamicLines] : []),
    '',
    `board: ${queued} queued, ${inflight} inflight, ${done} done, ${failed} failed`,
    formatWebhookStatus(result.webhook, result.webhookHealth),
    ...formatWebhookForeign(result.webhookHealth),
    formatSchedulerStatus(result.scheduler),
    ...formatWorktrees(result.worktrees),
    formatLastTick(result.lastTick),
    ...thresholds,
    ...budgetLine,
    ...(result.mergeOff ?? []),
    ...unbriefed,
    ...blockedLines,
    ...heldLines,
    ...stallLines,
    ...docsPinLine,
    unownedLine,
    ...agedLines,
    ...routedLines,
    ...(result.prTable ?? []),
    ...ghLines,
  ];
}

function formatGhCalls(result: StatusResult): string[] {
  if (!result.ghCallsPerHour && !result.quota) return [];
  const calls = result.ghCallsPerHour;
  const per = calls
    ? Object.entries(calls)
        .sort(([, a], [, b]) => b - a)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ')
    : 'none';
  const q = result.quota;
  const quota = q
    ? `remaining core ${q.core ?? '?'}, graphql ${q.graphql ?? '?'}`
    : 'remaining unknown';
  return [`gh calls last hour: ${per}; ${quota}`];
}

/** One warning line per session whose context is above its clear threshold (AISDLC-1066). */
export function contextWarnings(result: StatusResult): string[] {
  const t = result.contextThresholds;
  const over = result.rows.flatMap((r) =>
    r.overThreshold && r.contextTokens !== undefined && t
      ? [contextWarning(r.entry.name, r.contextTokens, t[r.entry.role])]
      : [],
  );
  // AISDLC-1100: the module and the transcript measure differently; across the threshold means no rotation.
  const disagree = result.rows.flatMap((r) => {
    if (!t || r.moduleTokens === undefined || r.contextTokens === undefined) return [];
    const limit = t[r.entry.role];
    if (r.moduleTokens > limit === r.contextTokens > limit) return [];
    return [
      `measure mismatch on ${r.entry.name}: module last measured ${r.moduleTokens}, CONTEXT ${r.contextTokens}, threshold ${limit}; the module may not be rotating this session`,
    ];
  });
  return [...over, ...disagree];
}

/** True when any stuck entry is older than the threshold; `cli-hierarchy status --check` exits 1 on it. */
export function hasStuckViolation(result: StatusResult): boolean {
  const limit = result.stuckAfterMinutes ?? Number.POSITIVE_INFINITY;
  return (result.stuck ?? []).some((r) => r.ageMinutes > limit);
}
