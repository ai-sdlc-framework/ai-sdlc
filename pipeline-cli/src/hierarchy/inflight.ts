/**
 * Read-only view of the board's `inflight/` directory, joined to the worker
 * that holds each manifest through its heartbeat file.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { readHeartbeat } from '../dispatch/board.js';
import { isValidTaskId } from './validate.js';

const MANIFEST_SUFFIX = '.dispatch.json';

/** One inflight manifest and, when its heartbeat is present, the worker holding it. */
export interface InflightItem {
  taskId: string;
  workerId?: string;
  /** Phase `next-step` wrote into the heartbeat (AISDLC-1226). */
  phase?: string;
}

/** List inflight manifests. Entries whose task id is malformed are skipped. */
export function listInflight(boardDir: string): InflightItem[] {
  const dir = path.join(boardDir, 'inflight');
  if (!existsSync(dir)) return [];
  const items: InflightItem[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(MANIFEST_SUFFIX)) continue;
    const taskId = file.slice(0, -MANIFEST_SUFFIX.length);
    if (!isValidTaskId(taskId)) continue;
    const hb = readHeartbeat(boardDir, taskId);
    items.push({ taskId, workerId: hb?.workerId, phase: hb?.phase });
  }
  return items.sort((a, b) => a.taskId.localeCompare(b.taskId));
}
