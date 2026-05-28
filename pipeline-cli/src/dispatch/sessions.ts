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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export type SessionStatus = 'starting' | 'in-progress' | 'done' | 'failed';

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
 * Write (create or overwrite) a session file.
 */
export function writeSession(boardDir: string, session: DispatchSession): void {
  ensureSessionsDirs(boardDir);
  const filePath = sessionFilePath(boardDir, session.taskId);
  writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
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
 * Move a session file to the archive subdir. Called by execute-parallel-cleanup
 * after killing the corresponding tmux window.
 *
 * Returns true if the file was archived, false if it did not exist.
 */
export function archiveSession(boardDir: string, taskId: string): boolean {
  const filePath = sessionFilePath(boardDir, taskId);
  if (!existsSync(filePath)) return false;
  ensureSessionsDirs(boardDir);
  const archivePath = path.join(sessionsArchiveDir(boardDir), sessionFilename(taskId));
  const content = readFileSync(filePath, 'utf-8');
  writeFileSync(archivePath, content, 'utf-8');
  rmSync(filePath);
  return true;
}
