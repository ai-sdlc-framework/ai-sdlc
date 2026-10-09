/**
 * Dispatch-board session heartbeat and cancel back-channel (AISDLC-462,
 * AISDLC-481) for `/ai-sdlc execute`. Both used to be shell helpers inlined in
 * the command body; they are best-effort and never throw.
 *
 * The heartbeat keeps using the canonical `scripts/lib/update-session-state.sh`
 * (single source of truth, AISDLC-464); only the cancel check is ported.
 *
 * @module next-step/session
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextStepContext } from './types.js';

/** Relative path (under the project root) of the canonical heartbeat helper. */
export const UPDATE_SESSION_STATE_LIB = 'lib/update-session-state.sh';

/**
 * Write `currentStep` + `lastHeartbeat` to the session file when one exists
 * (no-op for standalone runs). Delegates to the canonical shell helper.
 */
export async function updateSessionState(
  ctx: NextStepContext,
  taskIdLower: string,
  step: string,
): Promise<void> {
  const lib = join(ctx.pluginScriptsDir, UPDATE_SESSION_STATE_LIB);
  if (!ctx.exists(lib)) return;
  if (
    !ctx.exists(
      join(ctx.workDir, '.ai-sdlc', 'dispatch', 'sessions', `${taskIdLower}.session.json`),
    )
  ) {
    return;
  }
  try {
    await ctx.runner(
      'bash',
      ['-c', 'source "$1"; update_session_state "$2" "$3"', '_', lib, taskIdLower, step],
      { cwd: ctx.workDir, allowFailure: true },
    );
  } catch {
    // non-fatal by contract
  }
}

/** Record the PR on the session file once it is open (non-fatal). */
export function recordSessionPr(ctx: NextStepContext, taskIdLower: string, prUrl: string): void {
  const file = join(ctx.workDir, '.ai-sdlc', 'dispatch', 'sessions', `${taskIdLower}.session.json`);
  if (!existsSync(file)) return;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const m = /\/pull\/(\d+)/.exec(prUrl);
    s.prUrl = prUrl;
    if (m) s.prNumber = Number(m[1]);
    s.currentStep = '11b-pr-opened';
    s.lastHeartbeat = ctx.now().toISOString();
    if (s.status === 'starting') s.status = 'in-progress';
    writeFileSync(file, JSON.stringify(s, null, 2));
  } catch {
    // non-fatal
  }
}

/**
 * Cancel back-channel (AISDLC-481 v1: cancel-only). When a cancel signal file
 * exists, mark the session cancelled, remove the signal, write a board
 * diagnostic and report `true` so the caller aborts cleanly. No-op otherwise.
 */
export function checkCancelSignal(
  ctx: NextStepContext,
  taskIdLower: string,
  taskId: string,
): boolean {
  const sessions = join(ctx.workDir, '.ai-sdlc', 'dispatch', 'sessions');
  const cancelFile = join(sessions, `${taskIdLower}.cancel.json`);
  if (!existsSync(cancelFile)) return false;
  const sessionFile = join(sessions, `${taskIdLower}.session.json`);
  const boardDir = join(ctx.workDir, '.ai-sdlc', 'dispatch');
  let reason = 'operator-cancel';
  let decisionId: string | undefined;
  try {
    const sig = JSON.parse(readFileSync(cancelFile, 'utf8')) as {
      reason?: string;
      decisionId?: string;
    };
    reason = sig.reason || reason;
    decisionId = sig.decisionId;
  } catch {
    // keep defaults
  }
  let realTaskId = taskId;
  try {
    realTaskId =
      (JSON.parse(readFileSync(sessionFile, 'utf8')) as { taskId?: string }).taskId || taskId;
  } catch {
    // keep default
  }
  try {
    rmSync(cancelFile);
  } catch {
    // idempotent
  }
  try {
    const s = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
    s.status = 'cancelled';
    s.lastHeartbeat = ctx.now().toISOString();
    writeFileSync(`${sessionFile}.tmp`, JSON.stringify(s, null, 2));
    renameSync(`${sessionFile}.tmp`, sessionFile);
  } catch {
    // no session file
  }
  try {
    const failedDir = join(boardDir, 'failed');
    mkdirSync(failedDir, { recursive: true });
    const notes = [
      'session cancelled at step boundary',
      `reason: ${reason}`,
      decisionId ? `decision-id: ${decisionId}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    const diagPath = join(failedDir, `${realTaskId}.diagnostic.json`);
    writeFileSync(
      `${diagPath}.tmp`,
      JSON.stringify(
        {
          schemaVersion: 'v1',
          taskId: realTaskId,
          outcome: 'failed',
          completedAt: ctx.now().toISOString(),
          workerId: 'session-cancel-handler',
          cause: 'operator-cancel',
          notes,
        },
        null,
        2,
      ),
    );
    renameSync(`${diagPath}.tmp`, diagPath);
  } catch {
    // diagnostic is best-effort
  }
  return true;
}
