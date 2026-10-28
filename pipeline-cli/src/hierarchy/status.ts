/**
 * `cli-hierarchy status`: the roster joined with the harness session registry
 * and the board's inflight view.
 */

import { listBoard, peekQueue } from '../dispatch/board.js';
import { listUnbriefed } from './auto-brief.js';
import type { QueueCounts } from '../dispatch/types.js';
import {
  attestationGrowth,
  formatAttestationGrowth,
  type AttestationGrowth,
} from './attestation-growth.js';
import { listInflight } from './inflight.js';
import { AGING_WINDOW_MS, listLanding, recordLastActionAt } from './reconcile.js';
import { paneNodeVersion, readNvmrc, versionMatches } from './node-pin.js';
import { hasLaunchEnv } from './up.js';
import {
  callsPerSession,
  ghCallsPath,
  parseQuota,
  pruneGhCalls,
  readGhCalls,
  type Quota,
} from './gh-calls.js';
import {
  formatModuleHealth,
  readModuleHealth,
  defaultStoreDirs,
  readModuleMeasure,
  type ModuleHealth,
} from './module-health.js';
import { readSessionRegistry } from './registry.js';
import { readRosterChecked } from './roster.js';
import {
  formatSchedulerStatus,
  schedulerStatus,
  type SchedulerStatus,
} from './reconcile-scheduler.js';
import { formatLastTick, lastTickInfo } from './host-liveness.js';
import { formatWebhookStatus, webhookStatus, type WebhookStatus } from './webhook.js';
import { listWindows, paneInfo, paneStartCommand, sessionAttached } from './tmux.js';
import { contextWarning, formatContext, sessionContextTokens } from './context-size.js';
import { readOpenDrainStall, type DrainStallRecord } from './drain-stall.js';
import { budgetStatus, formatBudget, type BudgetStatus } from './budget.js';
import { resolveThresholds } from './thresholds.js';
import type { HierarchyDeps, HierarchyRole, RosterEntry } from './types.js';

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
  /** Present with `launchEnv: 'missing'`: how to repair it. */
  nextStep?: string;
}

/** Result of `status`. */
export interface StatusResult {
  rows: StatusRow[];
  board: QueueCounts;
  /** The local webhook receiver (AISDLC-880). */
  webhook: WebhookStatus;
  /** The detached reconcile scheduler (AISDLC-932). */
  scheduler: SchedulerStatus;
  /** Age and author of the last dispatch tick (AISDLC-1096); absent when none was recorded. */
  lastTick?: { ageSec: number; by: 'host' | 'scheduler' };
  /** Per-role context-clear thresholds in tokens (AISDLC-815), from `<board-dir>/config.json`. */
  contextThresholds?: Record<HierarchyRole, number>;
  /** Token budget pace from `usage.json` (AISDLC-1072); absent when never sampled. */
  budget?: BudgetStatus;
  /** Dispatchable tasks on no brief and not on the board (AISDLC-930); absent when none. */
  unbriefed?: string[];
  /** Tasks parked in `blocked/` with the reason (AISDLC-1043); absent when none. */
  blocked?: { taskId: string; reason: string }[];
  /** Open PRs no lane owns (AISDLC-1091); `unowned PRs: N` in the text view. */
  unowned?: number;
  /** AISDLC-1092: open PRs with no state change for the aging window, oldest first. */
  agedPrs?: { pr: number; ageMs: number; lane: string; lastAction: string }[];
  /** `gh` calls in the last hour by HIERARCHY_SESSION (AISDLC-963). */
  ghCallsPerHour?: Record<string, number>;
  /** Live remaining quota for the core and graphql buckets; absent when `gh` cannot say. */
  quota?: Quota;
  /** The open drain stall (AISDLC-1101); absent when the drain is moving. */
  drainStall?: DrainStallRecord;
  /** Committed attestation envelope and leaf growth (AISDLC-968). */
  attestationGrowth?: AttestationGrowth;
}

/** Join the roster with the registry, tmux and the board. */
export function hierarchyStatus(deps: HierarchyDeps): StatusResult {
  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  const registry = readSessionRegistry(deps.registryDir);
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
    return {
      entry,
      state,
      ...(contextTokens !== undefined
        ? { contextTokens, overThreshold: contextTokens > thresholdsByRole[entry.role] }
        : {}),
      ...(nodeVersion ? { nodeVersion } : {}),
      ...(nodeMismatch ? { nodeMismatch } : {}),
      module: readModuleHealth(deps.boardDir, entry, deps.now()),
      ...(moduleTokens !== undefined ? { moduleTokens } : {}),
      attached: alive && isAttached(entry.tmuxSession),
      inflightTask: held?.taskId,
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
  let ghCallsPerHour: Record<string, number> = {};
  try {
    const log = ghCallsPath(deps.boardDir);
    pruneGhCalls(log, deps.now());
    ghCallsPerHour = callsPerSession(readGhCalls(log), deps.now());
  } catch {
    /* an unreadable call log must not break status */
  }
  let quota: Quota | undefined;
  try {
    const r = deps.run('gh', ['api', 'rate_limit'], { cwd: deps.cwd });
    if (r?.status === 0) quota = parseQuota(r.stdout);
  } catch {
    /* gh missing or offline */
  }
  const drainStall = readOpenDrainStall(deps.boardDir);
  let growth: AttestationGrowth | undefined;
  try {
    growth = attestationGrowth(deps.cwd, deps.run);
  } catch {
    /* unreadable directories must not break status */
  }
  const lastTick = lastTickInfo(deps.boardDir, deps.now());
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
  return {
    rows,
    ...(agedPrs.length > 0 ? { agedPrs } : {}),
    unowned: landings.filter((l) => l.owner === 'unowned').length,
    ...(growth ? { attestationGrowth: growth } : {}),
    ...(drainStall ? { drainStall } : {}),
    ...(Object.keys(ghCallsPerHour).length > 0 ? { ghCallsPerHour } : {}),
    ...(quota ? { quota } : {}),
    board: peekQueue(deps.boardDir),
    webhook: webhookStatus(deps),
    scheduler: schedulerStatus(deps),
    ...(lastTick ? { lastTick } : {}),
    contextThresholds: thresholdsByRole,
    ...(budgetNow ? { budget: budgetNow } : {}),
    ...(unbriefed.length > 0 ? { unbriefed } : {}),
    ...(blocked.length > 0 ? { blocked } : {}),
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

export function formatStatus(result: StatusResult, nowMs: number = Number.NaN): string[] {
  const dynamicLines = result.rows
    .filter((r) => r.entry.taskId !== undefined)
    .map(
      (r) =>
        `dynamic executor: ${r.entry.name} task ${r.entry.taskId} age ${formatAge(r.entry.startedAt, nowMs)} (${r.state})`,
    );
  const t = result.contextThresholds;
  const thresholds = t
    ? [
        `context clear thresholds (tokens): planner ${t.planner}, operator-dispatch ${t['operator-dispatch']}, executor ${t.executor}`,
      ]
    : [];
  const budgetLine = result.budget ? [formatBudget(result.budget)] : [];
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
  const unownedLine = `unowned PRs: ${result.unowned ?? 0}`;
  const agedLines = (result.agedPrs ?? []).map(
    (a) =>
      `aged PR #${a.pr}: ${formatAge(new Date(0).toISOString(), a.ageMs)}, lane ${a.lane}, last action ${a.lastAction}`,
  );
  const blockedLines = (result.blocked ?? []).map((b) => `blocked: ${b.taskId}: ${b.reason}`);
  if (result.rows.length === 0)
    return [
      'no sessions in the roster',
      formatWebhookStatus(result.webhook),
      formatSchedulerStatus(result.scheduler),
      formatLastTick(result.lastTick),
      ...thresholds,
      ...budgetLine,
      ...unbriefed,
      ...blockedLines,
      ...stallLines,
      unownedLine,
      ...agedLines,
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
    r.state,
    r.attached ? 'yes' : 'no',
    r.entry.model,
    r.entry.permissionMode,
    r.inflightTask ?? '-',
    r.landing ?? '-',
    r.launchEnv ?? '-',
    r.nodeVersion ? `${r.nodeVersion}${r.nodeMismatch ? ' MISMATCH' : ''}` : '-',
    r.moduleTokens !== undefined
      ? `${formatModuleHealth(r.module)} (measured ${r.moduleTokens})`
      : formatModuleHealth(r.module),
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
  const overLines = contextWarnings(result);
  return [
    fmt(header),
    ...body.map(fmt),
    ...(repairs.length + nodeRepairs.length + overLines.length > 0
      ? ['', ...repairs, ...nodeRepairs, ...overLines]
      : []),
    ...(dynamicLines.length > 0 ? ['', ...dynamicLines] : []),
    '',
    `board: ${queued} queued, ${inflight} inflight, ${done} done, ${failed} failed`,
    formatWebhookStatus(result.webhook),
    formatSchedulerStatus(result.scheduler),
    formatLastTick(result.lastTick),
    ...thresholds,
    ...budgetLine,
    ...unbriefed,
    ...blockedLines,
    ...stallLines,
    unownedLine,
    ...agedLines,
    ...ghLines,
  ];
}

function formatGhCalls(result: StatusResult): string[] {
  const growth = result.attestationGrowth
    ? [formatAttestationGrowth(result.attestationGrowth)]
    : [];
  if (!result.ghCallsPerHour && !result.quota) return growth;
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
  return [`gh calls last hour: ${per}; ${quota}`, ...growth];
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
