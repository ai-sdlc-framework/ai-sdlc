/**
 * Dispatch Session helpers for /ai-sdlc execute-parallel (AISDLC-462).
 *
 * Session files live at:
 *   .ai-sdlc/dispatch/sessions/<task-id-lower>.session.json
 *
 * One file per concurrently-running /ai-sdlc execute invocation. Written by
 * execute-parallel on spawn; updated by the spawned execute session (heartbeat)
 * after each Step 0-13 transition; read by execute-parallel-status for the
 * live table.
 *
 * Schema: spec/schemas/dispatch-session.v1.schema.json
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Subdirectory under .ai-sdlc/dispatch/ for session files. */
export const SESSIONS_SUBDIR = 'sessions';

/** Archive subdir for cleaned-up sessions. */
export const SESSIONS_ARCHIVE_SUBDIR = 'sessions/archived';

/** Filename suffix for session files. */
const SESSION_SUFFIX = '.session.json';

/** Default sessions dir resolved relative to a board root. */
export function sessionsDir(boardDir: string): string {
  return path.join(boardDir, SESSIONS_SUBDIR);
}

/** Archive dir resolved relative to a board root. */
export function sessionsArchiveDir(boardDir: string): string {
  return path.join(boardDir, SESSIONS_ARCHIVE_SUBDIR);
}

/** Session status values (mirrors schema enum). */
export type SessionStatus = 'starting' | 'in-progress' | 'done' | 'failed' | 'cancelled';

/** Filename suffix for cancel control signal files (AISDLC-481). */
const CANCEL_SUFFIX = '.cancel.json';

/**
 * AISDLC-481 — cancel control signal written by the orchestrator next to a
 * session file. A running /ai-sdlc execute session reads this at step
 * boundaries and performs a clean abort, marking the session cancelled.
 */
export interface CancelSignal {
  schemaVersion: 'v1';
  taskId: string;
  /** ISO-8601 timestamp the signal was written. */
  cancelledAt: string;
  /** Human-readable reason (audit trail). */
  reason?: string;
  /** Orchestrator / operator session that wrote the cancel. */
  cancelledBy?: string;
}

// ---------------------------------------------------------------------------
// Cancel back-channel helpers (AISDLC-481)
// ---------------------------------------------------------------------------

/** Full path to the cancel signal file for a task. */
export function cancelFilePath(boardDir: string, taskId: string): string {
  return path.join(sessionsDir(boardDir), `${taskId.toLowerCase()}${CANCEL_SUFFIX}`);
}

/**
 * Orchestrator-side: write a cancel signal for a running session.
 * Atomic write (tmp + rename). Idempotent — a pre-existing signal is
 * overwritten (the Conductor is the sole writer; concurrent writes are not
 * a concern).
 */
export function writeCancelSignal(
  boardDir: string,
  signal: CancelSignal,
  opts: { reason?: string; cancelledBy?: string } = {},
): string {
  ensureSessionsDirs(boardDir);
  const full: CancelSignal = {
    ...signal,
    reason: opts.reason ?? signal.reason,
    cancelledBy: opts.cancelledBy ?? signal.cancelledBy,
  };
  const target = cancelFilePath(boardDir, signal.taskId);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8');
  renameSync(tmp, target);
  return target;
}

/**
 * Worker-side: read the cancel signal for a task. Returns null when no
 * signal exists (the normal case — sessions only check at step boundaries).
 */
export function readCancelSignal(boardDir: string, taskId: string): CancelSignal | null {
  const target = cancelFilePath(boardDir, taskId);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf-8')) as CancelSignal;
  } catch {
    return null;
  }
}

/**
 * Worker-side: remove the cancel signal after the session has honored it.
 * Idempotent on missing files.
 */
export function removeCancelSignal(boardDir: string, taskId: string): void {
  const target = cancelFilePath(boardDir, taskId);
  if (existsSync(target)) {
    try {
      rmSync(target);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * In-memory representation of a dispatch session. Matches the JSON shape
 * declared by `dispatch-session.v1.schema.json`.
 */
export interface DispatchSession {
  schemaVersion: 'v1';
  taskId: string;
  tmuxSession: string;
  tmuxWindow: string;
  paneId: string;
  spawnedAt: string;
  status: SessionStatus;
  currentStep?: string;
  lastHeartbeat?: string;
  prUrl?: string | null;
  prNumber?: number | null;
}

/**
 * Derive the canonical session filename from a task ID.
 * Always lowercase to match the per-worktree sentinel convention.
 */
export function sessionFilename(taskId: string): string {
  return `${taskId.toLowerCase()}${SESSION_SUFFIX}`;
}

/**
 * Derive the full path to a session file.
 */
export function sessionFilePath(boardDir: string, taskId: string): string {
  return path.join(sessionsDir(boardDir), sessionFilename(taskId));
}

/**
 * Ensure the sessions (and archive) directories exist.
 */
export function ensureSessionsDirs(boardDir: string): void {
  mkdirSync(path.join(boardDir, SESSIONS_ARCHIVE_SUBDIR), { recursive: true });
}

/**
 * Write (create or overwrite) a session file atomically.
 * Writes to a `.tmp` sibling first, then renames to avoid partial-write
 * corruption that would leave readSession returning null.
 */
export function writeSession(boardDir: string, session: DispatchSession): void {
  ensureSessionsDirs(boardDir);
  const filePath = sessionFilePath(boardDir, session.taskId);
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Read a session file. Returns null if the file does not exist.
 */
export function readSession(boardDir: string, taskId: string): DispatchSession | null {
  const filePath = sessionFilePath(boardDir, taskId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DispatchSession;
  } catch {
    return null;
  }
}

/**
 * Update specific fields on an existing session file. No-op if the file
 * does not exist (backward-compatible — sessions only exist when
 * execute-parallel spawned the task).
 */
export function updateSession(
  boardDir: string,
  taskId: string,
  updates: Partial<DispatchSession>,
): void {
  const existing = readSession(boardDir, taskId);
  if (!existing) return;
  const merged: DispatchSession = { ...existing, ...updates };
  writeSession(boardDir, merged);
}

/**
 * List all session files in the sessions directory (non-archived).
 * Returns an array of parsed DispatchSession objects (invalid files skipped).
 */
export function listSessions(boardDir: string): DispatchSession[] {
  const dir = sessionsDir(boardDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(SESSION_SUFFIX))
    .map((dirent) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, dirent.name), 'utf-8')) as DispatchSession;
      } catch {
        return null;
      }
    })
    .filter((s): s is DispatchSession => s !== null);
}

/**
 * List sessions whose status is still 'active' (starting | in-progress).
 */
export function listActiveSessions(boardDir: string): DispatchSession[] {
  return listSessions(boardDir).filter(
    (s) => s.status === 'starting' || s.status === 'in-progress',
  );
}

/**
 * Mutual-awareness check: returns true if a session for the given task
 * already exists and is NOT in a terminal state (done | failed).
 *
 * execute-parallel uses this to refuse spawning a duplicate pane for an
 * already-running session.
 */
export function isSessionActive(boardDir: string, taskId: string): boolean {
  const session = readSession(boardDir, taskId);
  if (!session) return false;
  return session.status === 'starting' || session.status === 'in-progress';
}

/**
 * Count the number of currently-active sessions.
 * execute-parallel uses this to enforce the hard cap of 5.
 */
export function countActiveSessions(boardDir: string): number {
  return listActiveSessions(boardDir).length;
}

/**
 * Move a session file to the archive subdir atomically. Called by
 * execute-parallel-cleanup after killing the corresponding tmux window.
 *
 * Atomic pattern: write to a tmp file in the archive dir, then rename (atomic
 * on same filesystem), then delete the original — a crash mid-operation never
 * leaves the session in both locations in a way that readSession would return
 * a ghost active session.
 *
 * Returns true if the file was archived, false if it did not exist.
 */
export function archiveSession(boardDir: string, taskId: string): boolean {
  const filePath = sessionFilePath(boardDir, taskId);
  if (!existsSync(filePath)) return false;
  ensureSessionsDirs(boardDir);
  const archivePath = path.join(sessionsArchiveDir(boardDir), sessionFilename(taskId));
  const tmpArchivePath = archivePath + '.tmp';
  const content = readFileSync(filePath, 'utf-8');
  writeFileSync(tmpArchivePath, content, 'utf-8');
  renameSync(tmpArchivePath, archivePath);
  rmSync(filePath);
  return true;
}
