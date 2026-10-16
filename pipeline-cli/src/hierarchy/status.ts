/**
 * `cli-hierarchy status`: the roster joined with the harness session registry
 * and the board's inflight view.
 */

import { peekQueue } from '../dispatch/board.js';
import { listUnbriefed } from './auto-brief.js';
import type { QueueCounts } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { listLanding } from './reconcile.js';
import { paneNodeVersion, readNvmrc, versionMatches } from './node-pin.js';
import { hasLaunchEnv } from './up.js';
import { readSessionRegistry } from './registry.js';
import { readRosterChecked } from './roster.js';
import {
  formatSchedulerStatus,
  schedulerStatus,
  type SchedulerStatus,
} from './reconcile-scheduler.js';
import { formatWebhookStatus, webhookStatus, type WebhookStatus } from './webhook.js';
import { listWindows, paneInfo, paneStartCommand, sessionAttached } from './tmux.js';
import { resolveThresholds } from './auto-clear.js';
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
  /** Per-role context-clear thresholds in tokens (AISDLC-815), from `<board-dir>/config.json`. */
  contextThresholds?: Record<HierarchyRole, number>;
  /** Dispatchable tasks on no brief and not on the board (AISDLC-930); absent when none. */
  unbriefed?: string[];
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
    const nodeVersion = alive
      ? paneNodeVersion(deps.run, paneInfo(deps.run, entry.tmuxSession, entry.tmuxWindow).panePid)
      : undefined;
    const nodeMismatch =
      nodeVersion !== undefined &&
      wantedNode !== undefined &&
      !versionMatches(wantedNode, nodeVersion);
    return {
      entry,
      state,
      ...(nodeVersion ? { nodeVersion } : {}),
      ...(nodeMismatch ? { nodeMismatch } : {}),
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
  return {
    rows,
    board: peekQueue(deps.boardDir),
    webhook: webhookStatus(deps),
    scheduler: schedulerStatus(deps),
    contextThresholds: resolveThresholds(deps.boardDir),
    ...(unbriefed.length > 0 ? { unbriefed } : {}),
  };
}

/** Render the status result as a plain-text table. */
export function formatStatus(result: StatusResult): string[] {
  const t = result.contextThresholds;
  const thresholds = t
    ? [
        `context clear thresholds (tokens): planner ${t.planner}, operator-dispatch ${t['operator-dispatch']}, executor ${t.executor}`,
      ]
    : [];
  const unbriefed = result.unbriefed?.length
    ? [
        `unbriefed (dispatchable, on no brief, not on the board): ${result.unbriefed.join(', ')}; write a brief with \`cli-hierarchy brief --tasks <id,...>\``,
      ]
    : [];
  if (result.rows.length === 0)
    return [
      'no sessions in the roster',
      formatWebhookStatus(result.webhook),
      formatSchedulerStatus(result.scheduler),
      ...thresholds,
      ...unbriefed,
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
  return [
    fmt(header),
    ...body.map(fmt),
    ...(repairs.length + nodeRepairs.length > 0 ? ['', ...repairs, ...nodeRepairs] : []),
    '',
    `board: ${queued} queued, ${inflight} inflight, ${done} done, ${failed} failed`,
    formatWebhookStatus(result.webhook),
    formatSchedulerStatus(result.scheduler),
    ...thresholds,
    ...unbriefed,
  ];
}
