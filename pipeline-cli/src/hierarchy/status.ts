/**
 * `cli-hierarchy status`: the roster joined with the harness session registry
 * and the board's inflight view.
 */

import { peekQueue } from '../dispatch/board.js';
import type { QueueCounts } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { readSessionRegistry } from './registry.js';
import { readRoster } from './roster.js';
import { listWindows } from './tmux.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

/** Live state of one roster entry. */
export type LiveState = 'busy' | 'idle' | 'starting' | 'gone';

/** One row of the status table. */
export interface StatusRow {
  entry: RosterEntry;
  state: LiveState;
  /** Task the session holds in `inflight/`, when its heartbeat names it. */
  inflightTask?: string;
}

/** Result of `status`. */
export interface StatusResult {
  rows: StatusRow[];
  board: QueueCounts;
}

/** Join the roster with the registry, tmux and the board. */
export function hierarchyStatus(deps: HierarchyDeps): StatusResult {
  const roster = readRoster(deps.boardDir);
  const registry = readSessionRegistry(deps.registryDir);
  const windows = new Set<string>();
  for (const tmuxSession of new Set(roster.sessions.map((e) => e.tmuxSession))) {
    for (const w of listWindows(deps.run, tmuxSession)) windows.add(`${tmuxSession}:${w}`);
  }
  const inflight = listInflight(deps.boardDir);

  const rows = roster.sessions.map((entry): StatusRow => {
    const live =
      registry.find((r) => r.name === entry.name) ??
      registry.find((r) => r.pid === entry.pid && entry.pid > 0);
    let state: LiveState;
    if (live) state = live.status === 'busy' ? 'busy' : 'idle';
    else if (windows.has(`${entry.tmuxSession}:${entry.tmuxWindow}`)) state = 'starting';
    else state = 'gone';
    const held = inflight.find((i) => i.workerId === entry.name || i.workerId === entry.tmuxWindow);
    return { entry, state, inflightTask: held?.taskId };
  });
  return { rows, board: peekQueue(deps.boardDir) };
}

/** Render the status result as a plain-text table. */
export function formatStatus(result: StatusResult): string[] {
  if (result.rows.length === 0) return ['no sessions in the roster'];
  const header = ['ROLE', 'NAME', 'STATE', 'MODEL', 'MODE', 'INFLIGHT'];
  const body = result.rows.map((r) => [
    r.entry.role,
    r.entry.name,
    r.state,
    r.entry.model,
    r.entry.permissionMode,
    r.inflightTask ?? '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const { queued, inflight, done, failed } = result.board;
  return [
    fmt(header),
    ...body.map(fmt),
    '',
    `board: ${queued} queued, ${inflight} inflight, ${done} done, ${failed} failed`,
  ];
}
