/**
 * `cli-hierarchy stall-notice` (AISDLC-871): an alert-only check for a drain that
 * stopped moving. With eligible queued work and no new verdict or heartbeat for N
 * minutes it raises one desktop notification and appends one digest line, once per
 * stall. It never relaunches, never sends keys or messages to a session and never
 * starts a model; the only process it runs is the notifier.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { collectVerdicts, listBoard, readHeartbeat } from '../dispatch/board.js';
import { listInflight } from './inflight.js';
import type { CommandRunner } from './types.js';

/** Minutes without movement before a stall is reported. */
export const DEFAULT_STALL_NOTICE_MINUTES = 45;

const STATE_FILE = 'stall-notice.json';
const DIGEST_FILE = 'stall-digest.log';

export interface StallNoticeDeps {
  boardDir: string;
  now: () => Date;
  /** Runs the notifier, and nothing else. */
  run: CommandRunner;
  platform?: NodeJS.Platform;
  minutes?: number;
}

export interface StallNoticeResult {
  action: 'notified' | 'none';
  reason: 'stalled' | 'already-notified' | 'empty-queue' | 'progress';
  /** Minutes since the last verdict or heartbeat. */
  idleMinutes?: number;
  message?: string;
}

interface State {
  /** First sighting of queued work when the board has no verdict or heartbeat to anchor on. */
  anchor?: string;
  /** The progress timestamp of the stall already reported. */
  notifiedFor?: string;
}

function readState(file: string): State {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as State;
  } catch {
    return {};
  }
}

/** Latest verdict or heartbeat time on the board, in epoch milliseconds. */
function lastProgressMs(boardDir: string): number | undefined {
  const times: number[] = collectVerdicts(boardDir).map((v) => Date.parse(v.completedAt));
  for (const item of listInflight(boardDir)) {
    times.push(Date.parse(readHeartbeat(boardDir, item.taskId)?.lastHeartbeat ?? ''));
  }
  const valid = times.filter((t) => !Number.isNaN(t));
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

/** Check the board once; notify at most once per stall. */
export function runStallNotice(deps: StallNoticeDeps): StallNoticeResult {
  const minutes = deps.minutes ?? DEFAULT_STALL_NOTICE_MINUTES;
  const nowMs = deps.now().getTime();
  const stateFile = path.join(deps.boardDir, STATE_FILE);
  const eligible = listBoard(deps.boardDir, deps.now).filter(
    (e) => e.state === 'queue' && e.eligible,
  ).length;
  if (eligible === 0) return { action: 'none', reason: 'empty-queue' };

  const state = readState(stateFile);
  let progress = lastProgressMs(deps.boardDir);
  if (progress === undefined) {
    const anchor = Date.parse(state.anchor ?? '');
    progress = Number.isNaN(anchor) ? nowMs : anchor;
    if (state.anchor === undefined) {
      writeFileSync(stateFile, JSON.stringify({ ...state, anchor: new Date(nowMs).toISOString() }));
    }
  }
  const idleMinutes = Math.floor((nowMs - progress) / 60000);
  if (nowMs - progress < minutes * 60000)
    return { action: 'none', reason: 'progress', idleMinutes };

  const key = new Date(progress).toISOString();
  if (state.notifiedFor === key) return { action: 'none', reason: 'already-notified', idleMinutes };

  const message = `Drain stalled: ${eligible} eligible task(s) queued, no verdict or heartbeat for ${idleMinutes} min`;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    deps.run('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title "ai-sdlc dispatch stall"`,
    ]);
  } else {
    deps.run('notify-send', ['ai-sdlc dispatch stall', message]);
  }
  mkdirSync(deps.boardDir, { recursive: true });
  appendFileSync(
    path.join(deps.boardDir, DIGEST_FILE),
    `${new Date(nowMs).toISOString()} ${message}\n`,
  );
  writeFileSync(stateFile, JSON.stringify({ ...state, notifiedFor: key }));
  return { action: 'notified', reason: 'stalled', idleMinutes, message };
}
