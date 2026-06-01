/**
 * Hermetic tests for the session heartbeat reaper (AISDLC-481).
 *
 * Coverage:
 *   AC-5.1 — stale heartbeat is reaped: session file marked failed;
 *             board inflight entry also swept (two-substrate reconcile).
 *   AC-5.2 — cancel signal honored at next step boundary: session marked
 *             cancelled; board diagnostic written; signal file removed.
 *   AC-5.3 — two-substrate consistency after reap: a session with no board
 *             inflight entry still gets a diagnostic written to failed/;
 *             a board inflight entry with no session file is swept by the
 *             board-level pass and appears in boardOnlyReaped.
 *
 * All I/O goes to per-test temp directories (injected boardDir + injected
 * clock). No real time, no tmux, no external processes.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from './board.js';
import {
  cancelFilePath,
  readCancelSignal,
  readSession,
  type SessionStatus,
  writeSession,
  writeCancelSignal,
  type CancelSignal,
  type DispatchSession,
} from './sessions.js';
import { honorCancelIfRequested, reapStaleSessions } from './session-reaper.js';
import type { DispatchManifest, InflightHeartbeat } from './types.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function mkBoardDir(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'session-reaper-test-'));
  return path.join(tmp, 'dispatch');
}

function mkSession(
  taskId: string,
  status: SessionStatus,
  overrides: Partial<DispatchSession> = {},
): DispatchSession {
  return {
    schemaVersion: 'v1',
    taskId,
    tmuxSession: 'ai-sdlc-parallel',
    tmuxWindow: `exec-${taskId.toLowerCase()}`,
    paneId: '%42',
    spawnedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    status,
    ...overrides,
  };
}

function mkManifest(taskId: string, dispatchedAt: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-test`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'deadbeef'.repeat(5).slice(0, 40),
    workerKind: 'in-session-agent',
    dispatchedAt,
    dispatchedBy: 'test',
    spec: {
      taskFile: `backlog/tasks/${taskId}.md`,
      verifyCommands: [],
    },
  };
}

function mkHeartbeat(taskId: string, lastHeartbeat: string): InflightHeartbeat {
  return {
    taskId,
    workerId: 'worker-test',
    workerKind: 'in-session-agent',
    startedAt: lastHeartbeat,
    lastHeartbeat,
  };
}

/** Move a manifest from queue/ to inflight/ (simulates a Worker claiming it). */
function claimManifest(boardDir: string, taskId: string): void {
  const queuePath = path.join(boardDir, 'queue', `${taskId}.dispatch.json`);
  const inflightPath = path.join(boardDir, 'inflight', `${taskId}.dispatch.json`);
  renameSync(queuePath, inflightPath);
}

/** Read all filenames in failed/ (returns [] if dir absent). */
function listFailed(boardDir: string): string[] {
  const failedDir = path.join(boardDir, 'failed');
  return existsSync(failedDir) ? readdirSync(failedDir) : [];
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let boardDir: string;

beforeEach(() => {
  boardDir = mkBoardDir();
  ensureBoardDirs(boardDir);
});

afterEach(() => {
  rmSync(path.dirname(boardDir), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-5.1 — stale heartbeat is reaped
// ---------------------------------------------------------------------------

describe('AC-5.1 stale heartbeat reap', () => {
  it('marks session failed when lastHeartbeat is older than staleMs', () => {
    const taskId = 'AISDLC-481';
    const staleTime = new Date(Date.now() - 60 * 60 * 1000); // 1h ago

    writeSession(
      boardDir,
      mkSession(taskId, 'in-progress', {
        lastHeartbeat: staleTime.toISOString(),
      }),
    );

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000, // 30 min threshold
      now: () => new Date(),
    });

    expect(result.reaped).toHaveLength(1);
    expect(result.reaped[0].taskId).toBe(taskId);

    const session = readSession(boardDir, taskId);
    expect(session?.status).toBe('failed');
  });

  it('does NOT reap a session with a fresh heartbeat', () => {
    const taskId = 'AISDLC-481';
    const freshTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago

    writeSession(
      boardDir,
      mkSession(taskId, 'in-progress', {
        lastHeartbeat: freshTime.toISOString(),
      }),
    );

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });

    expect(result.reaped).toHaveLength(0);
    const session = readSession(boardDir, taskId);
    expect(session?.status).toBe('in-progress');
  });

  it('uses spawnedAt when lastHeartbeat is absent', () => {
    const taskId = 'AISDLC-481';
    const staleSpawnTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago

    const s = mkSession(taskId, 'starting', {
      spawnedAt: staleSpawnTime.toISOString(),
    });
    // Deliberately omit lastHeartbeat (it is optional in the schema).
    delete (s as Partial<DispatchSession>).lastHeartbeat;
    writeSession(boardDir, s);

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });

    expect(result.reaped).toHaveLength(1);
    const session = readSession(boardDir, taskId);
    expect(session?.status).toBe('failed');
  });

  it('does not reap terminal sessions (done | failed | cancelled)', () => {
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    for (const [idx, status] of (['done', 'failed', 'cancelled'] as const).entries()) {
      const taskId = `AISDLC-${48 + idx + 2}`;
      writeSession(boardDir, mkSession(taskId, status, { lastHeartbeat: staleTime }));
    }

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });
    expect(result.reaped).toHaveLength(0);
  });

  it('reconciles the board inflight entry when one exists for the stale session', () => {
    const taskId = 'AISDLC-481';
    const staleTimeIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Session file (stale).
    writeSession(boardDir, mkSession(taskId, 'in-progress', { lastHeartbeat: staleTimeIso }));

    // Corresponding board inflight entry.
    writeManifest(boardDir, mkManifest(taskId, staleTimeIso));
    claimManifest(boardDir, taskId);
    writeHeartbeat(boardDir, mkHeartbeat(taskId, staleTimeIso));

    const inflightPath = path.join(boardDir, 'inflight', `${taskId}.dispatch.json`);

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });

    expect(result.reaped).toHaveLength(1);
    expect(result.reaped[0].boardReconciled).toBe(true);

    // Board inflight entry should be gone.
    expect(existsSync(inflightPath)).toBe(false);

    // Board failed/ should have a diagnostic.
    expect(listFailed(boardDir).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5.2 — cancel signal honored at step boundary
// ---------------------------------------------------------------------------

describe('AC-5.2 cancel signal honored at step boundary', () => {
  it('returns true and marks session cancelled when cancel signal exists', () => {
    const taskId = 'AISDLC-481';
    const now = () => new Date('2026-06-01T10:00:00.000Z');

    writeSession(boardDir, mkSession(taskId, 'in-progress'));

    const signal: CancelSignal = {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: now().toISOString(),
      reason: 'operator requested cancel',
      cancelledBy: 'orchestrator-session-abc',
    };
    writeCancelSignal(boardDir, signal);

    const result = honorCancelIfRequested(boardDir, taskId, { now });

    expect(result).toBe(true);

    // Session file updated to cancelled.
    const session = readSession(boardDir, taskId);
    expect(session?.status).toBe('cancelled');

    // Signal file removed.
    expect(readCancelSignal(boardDir, taskId)).toBeNull();
  });

  it('returns false and leaves session unchanged when no cancel signal', () => {
    const taskId = 'AISDLC-481';
    writeSession(boardDir, mkSession(taskId, 'in-progress'));

    const result = honorCancelIfRequested(boardDir, taskId);

    expect(result).toBe(false);
    const session = readSession(boardDir, taskId);
    expect(session?.status).toBe('in-progress');
  });

  it('writes a board diagnostic on cancel so Conductor sees it', () => {
    const taskId = 'AISDLC-481';
    const now = () => new Date('2026-06-01T10:00:00.000Z');

    writeSession(boardDir, mkSession(taskId, 'in-progress'));
    writeCancelSignal(boardDir, {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: now().toISOString(),
      reason: 'test cancel',
    });

    honorCancelIfRequested(boardDir, taskId, { now });

    // Board failed/ directory should have a diagnostic.
    expect(listFailed(boardDir).length).toBeGreaterThan(0);
  });

  it('removes cancel signal before updating session (idempotent on crash recovery)', () => {
    const taskId = 'AISDLC-481';
    writeSession(boardDir, mkSession(taskId, 'in-progress'));
    writeCancelSignal(boardDir, {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: new Date().toISOString(),
    });

    honorCancelIfRequested(boardDir, taskId);

    // Signal must be gone after honor.
    expect(readCancelSignal(boardDir, taskId)).toBeNull();
  });

  it('includes decisionId in diagnostic notes when provided', () => {
    const taskId = 'AISDLC-481';
    const now = () => new Date('2026-06-01T12:00:00.000Z');

    writeSession(boardDir, mkSession(taskId, 'in-progress'));
    writeCancelSignal(boardDir, {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: now().toISOString(),
    });

    honorCancelIfRequested(boardDir, taskId, { now, decisionId: 'DEC-0042' });

    // Check that the diagnostic in failed/ mentions the decisionId.
    const failedDir = path.join(boardDir, 'failed');
    const entries = existsSync(failedDir) ? readdirSync(failedDir) : [];
    const found = entries.some((e) => {
      try {
        const content = readFileSync(path.join(failedDir, e), 'utf-8');
        return content.includes('DEC-0042');
      } catch {
        return false;
      }
    });
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5.3 — two-substrate consistency after reap
// ---------------------------------------------------------------------------

describe('AC-5.3 two-substrate consistency', () => {
  it('writes a board diagnostic when session is stale but no board inflight entry exists', () => {
    const taskId = 'AISDLC-481';
    const staleTimeIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Session file only — no board inflight entry.
    writeSession(boardDir, mkSession(taskId, 'in-progress', { lastHeartbeat: staleTimeIso }));

    reapStaleSessions({ boardDir, staleMs: 30 * 60 * 1000, now: () => new Date() });

    // Board failed/ should have a diagnostic despite no inflight entry.
    expect(listFailed(boardDir).length).toBeGreaterThan(0);
  });

  it('sweeps board-only inflight entry (no session file) and includes in boardOnlyReaped', () => {
    const taskId = 'AISDLC-482';
    const staleTimeIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Board inflight entry only — no session file.
    writeManifest(boardDir, mkManifest(taskId, staleTimeIso));
    claimManifest(boardDir, taskId);
    writeHeartbeat(boardDir, mkHeartbeat(taskId, staleTimeIso));

    const inflightPath = path.join(boardDir, 'inflight', `${taskId}.dispatch.json`);

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });

    expect(result.boardOnlyReaped).toContain(taskId);
    // Inflight entry gone.
    expect(existsSync(inflightPath)).toBe(false);
  });

  it('does not double-count a task reaped from both substrates', () => {
    const taskId = 'AISDLC-481';
    const staleTimeIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    writeSession(boardDir, mkSession(taskId, 'in-progress', { lastHeartbeat: staleTimeIso }));
    writeManifest(boardDir, mkManifest(taskId, staleTimeIso));
    claimManifest(boardDir, taskId);
    writeHeartbeat(boardDir, mkHeartbeat(taskId, staleTimeIso));

    const result = reapStaleSessions({
      boardDir,
      staleMs: 30 * 60 * 1000,
      now: () => new Date(),
    });

    // Should appear in reaped (not in boardOnlyReaped).
    expect(result.reaped.map((r) => r.taskId)).toContain(taskId);
    expect(result.boardOnlyReaped).not.toContain(taskId);
  });
});

// ---------------------------------------------------------------------------
// CancelSignal round-trip (sessions.ts helpers)
// ---------------------------------------------------------------------------

describe('CancelSignal round-trip', () => {
  it('writes and reads a cancel signal', () => {
    const taskId = 'AISDLC-481';
    const signal: CancelSignal = {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: '2026-06-01T10:00:00.000Z',
      reason: 'test',
      cancelledBy: 'conductor',
    };
    writeCancelSignal(boardDir, signal);
    const read = readCancelSignal(boardDir, taskId);
    expect(read).toEqual(signal);
  });

  it('returns null when no cancel signal file exists', () => {
    expect(readCancelSignal(boardDir, 'AISDLC-999')).toBeNull();
  });

  it('does not leave a .tmp file after write', () => {
    const taskId = 'AISDLC-481';
    writeCancelSignal(boardDir, {
      schemaVersion: 'v1',
      taskId,
      cancelledAt: new Date().toISOString(),
    });
    const tmpPath = cancelFilePath(boardDir, taskId) + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);
  });
});
