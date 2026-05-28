/**
 * Tests for the Dispatch Session helpers (AISDLC-462).
 *
 * Hermetic: all I/O targets a temp directory created per-test.
 *
 * Coverage:
 *   - writeSession / readSession round-trip
 *   - isSessionActive: returns true for starting/in-progress, false for done/failed/absent
 *   - countActiveSessions: counts only active ones
 *   - listSessions / listActiveSessions
 *   - updateSession: merges fields; no-op when file absent
 *   - archiveSession: moves file to sessions/archived/; returns false if absent
 *   - Mutual-awareness check: refuse if existing session is not in done|failed
 *   - Schema validation (taskId pattern, status enum) via Ajv2020
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveSession,
  countActiveSessions,
  isSessionActive,
  listActiveSessions,
  listSessions,
  readSession,
  sessionsArchiveDir,
  sessionsDir,
  sessionFilePath,
  updateSession,
  writeSession,
  type DispatchSession,
} from './sessions.js';

// ─── Schema loader ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'spec', 'schemas');

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSession = ajv.compile(
  JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'dispatch-session.v1.schema.json'), 'utf-8')),
);

// ─── Fixtures ──────────────────────────────────────────────────────────────

function mkBoardDir(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dispatch-sessions-test-'));
  return path.join(tmp, 'dispatch');
}

function mkSession(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    schemaVersion: 'v1',
    taskId: 'AISDLC-462',
    tmuxSession: 'ai-sdlc-parallel',
    tmuxWindow: 'exec-aisdlc-462',
    paneId: '%14',
    spawnedAt: '2026-05-28T18:30:00.000Z',
    status: 'starting',
    ...overrides,
  };
}

// ─── Test state ────────────────────────────────────────────────────────────

let boardDir: string;

beforeEach(() => {
  boardDir = mkBoardDir();
});

afterEach(() => {
  rmSync(path.dirname(boardDir), { recursive: true, force: true });
});

// ─── Round-trip: write + read ──────────────────────────────────────────────

describe('writeSession / readSession', () => {
  it('round-trips a minimal session', () => {
    const s = mkSession();
    writeSession(boardDir, s);
    const r = readSession(boardDir, s.taskId);
    expect(r).toEqual(s);
  });

  it('creates the sessions directory if missing', () => {
    const s = mkSession();
    writeSession(boardDir, s);
    expect(existsSync(sessionsDir(boardDir))).toBe(true);
  });

  it('returns null when the session file does not exist', () => {
    expect(readSession(boardDir, 'AISDLC-999')).toBeNull();
  });

  it('overwrites an existing session on second write', () => {
    const s = mkSession({ status: 'starting' });
    writeSession(boardDir, s);
    const s2 = mkSession({ status: 'in-progress', currentStep: '05-dev' });
    writeSession(boardDir, s2);
    const r = readSession(boardDir, s.taskId);
    expect(r?.status).toBe('in-progress');
    expect(r?.currentStep).toBe('05-dev');
  });

  it('session file validates against dispatch-session.v1.schema.json', () => {
    const s = mkSession();
    writeSession(boardDir, s);
    const raw = JSON.parse(readFileSync(sessionFilePath(boardDir, s.taskId), 'utf-8'));
    const ok = validateSession(raw);
    if (!ok) {
      const errs = (validateSession.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`schema rejected valid session:\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe('dispatch-session.v1.schema.json', () => {
  it('validates a complete session (all fields)', () => {
    const s: DispatchSession = {
      ...mkSession({ status: 'done' }),
      currentStep: 'done',
      lastHeartbeat: '2026-05-28T19:00:00.000Z',
      prUrl: 'https://github.com/org/repo/pull/800',
      prNumber: 800,
    };
    expect(validateSession(s)).toBe(true);
  });

  it('validates a session with null prUrl / prNumber', () => {
    const s = { ...mkSession(), prUrl: null, prNumber: null };
    expect(validateSession(s)).toBe(true);
  });

  it('rejects an invalid status value', () => {
    const s = { ...mkSession(), status: 'running' };
    expect(validateSession(s)).toBe(false);
  });

  it('rejects a missing required taskId', () => {
    const s = { ...mkSession() } as Partial<DispatchSession>;
    delete s.taskId;
    expect(validateSession(s)).toBe(false);
  });

  it('rejects a taskId that does not match the pattern (lowercase)', () => {
    const s = { ...mkSession(), taskId: 'aisdlc-462' };
    expect(validateSession(s)).toBe(false);
  });

  it('rejects unknown top-level properties', () => {
    const s = { ...mkSession(), rogueField: 'extra' };
    expect(validateSession(s)).toBe(false);
  });

  it('rejects a prNumber below minimum (0)', () => {
    const s = { ...mkSession(), prNumber: 0 };
    expect(validateSession(s)).toBe(false);
  });

  it('accepts an empty paneId (initial reservation before tmux assigns pane)', () => {
    // Spawn writes paneId: '' at reservation time — schema must accept this.
    // Finding #4: the old minLength:1 incorrectly rejected every freshly-spawned session.
    const s = { ...mkSession(), paneId: '' };
    const ok = validateSession(s);
    if (!ok) {
      const errs = (validateSession.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`schema incorrectly rejected empty paneId:\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });
});

// ─── isSessionActive ────────────────────────────────────────────────────────

describe('isSessionActive', () => {
  it('returns true for status=starting', () => {
    writeSession(boardDir, mkSession({ status: 'starting' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(true);
  });

  it('returns true for status=in-progress', () => {
    writeSession(boardDir, mkSession({ status: 'in-progress' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(true);
  });

  it('returns false for status=done', () => {
    writeSession(boardDir, mkSession({ status: 'done' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(false);
  });

  it('returns false for status=failed', () => {
    writeSession(boardDir, mkSession({ status: 'failed' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(false);
  });

  it('returns false when no session file exists', () => {
    expect(isSessionActive(boardDir, 'AISDLC-999')).toBe(false);
  });
});

// ─── Mutual-awareness check (AISDLC-462 AC#9) ──────────────────────────────

describe('mutual-awareness check', () => {
  it('detects an already-active session (status=starting)', () => {
    writeSession(boardDir, mkSession({ status: 'starting' }));
    // The wrapper should refuse to spawn — verify isSessionActive returns true
    const alreadyRunning = isSessionActive(boardDir, 'AISDLC-462');
    expect(alreadyRunning).toBe(true);
  });

  it('allows spawn when prior session is done', () => {
    writeSession(boardDir, mkSession({ status: 'done' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(false);
  });

  it('allows spawn when prior session is failed', () => {
    writeSession(boardDir, mkSession({ status: 'failed' }));
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(false);
  });

  it('allows spawn when no session file exists (first run)', () => {
    expect(isSessionActive(boardDir, 'AISDLC-462')).toBe(false);
  });
});

// ─── countActiveSessions ───────────────────────────────────────────────────

describe('countActiveSessions', () => {
  it('returns 0 when no sessions exist', () => {
    expect(countActiveSessions(boardDir)).toBe(0);
  });

  it('counts only active sessions', () => {
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-100', status: 'starting' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-101', status: 'in-progress' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-102', status: 'done' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-103', status: 'failed' }));
    expect(countActiveSessions(boardDir)).toBe(2);
  });

  it('counts up to 5 (cap verification)', () => {
    for (let i = 0; i < 5; i++) {
      writeSession(boardDir, mkSession({ taskId: `AISDLC-${200 + i}`, status: 'starting' }));
    }
    expect(countActiveSessions(boardDir)).toBe(5);
  });
});

// ─── listSessions / listActiveSessions ─────────────────────────────────────

describe('listSessions', () => {
  it('returns empty array when no sessions dir exists', () => {
    expect(listSessions(boardDir)).toEqual([]);
  });

  it('returns all sessions including done/failed', () => {
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-100', status: 'starting' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-101', status: 'done' }));
    const sessions = listSessions(boardDir);
    expect(sessions).toHaveLength(2);
  });

  it('listActiveSessions returns only starting/in-progress', () => {
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-100', status: 'starting' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-101', status: 'done' }));
    writeSession(boardDir, mkSession({ taskId: 'AISDLC-102', status: 'in-progress' }));
    expect(listActiveSessions(boardDir)).toHaveLength(2);
  });
});

// ─── updateSession ──────────────────────────────────────────────────────────

describe('updateSession', () => {
  it('merges fields onto an existing session', () => {
    writeSession(boardDir, mkSession({ status: 'starting' }));
    updateSession(boardDir, 'AISDLC-462', {
      status: 'in-progress',
      currentStep: '05-dev',
      lastHeartbeat: '2026-05-28T18:35:00.000Z',
    });
    const r = readSession(boardDir, 'AISDLC-462');
    expect(r?.status).toBe('in-progress');
    expect(r?.currentStep).toBe('05-dev');
    expect(r?.lastHeartbeat).toBe('2026-05-28T18:35:00.000Z');
    // Original fields preserved
    expect(r?.tmuxSession).toBe('ai-sdlc-parallel');
  });

  it('is a no-op when the session file does not exist', () => {
    // Should not throw
    expect(() => updateSession(boardDir, 'AISDLC-999', { status: 'done' })).not.toThrow();
  });
});

// ─── atomic write safety ────────────────────────────────────────────────────

describe('writeSession atomic safety', () => {
  it('does not leave a .tmp file after a successful write', () => {
    const s = mkSession();
    writeSession(boardDir, s);
    const tmpPath = sessionFilePath(boardDir, s.taskId) + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('session written with empty paneId validates against schema', () => {
    // Finding #4 + #10: freshly-spawned session must pass schema validation.
    const s = mkSession({ paneId: '' });
    writeSession(boardDir, s);
    const raw = JSON.parse(readFileSync(sessionFilePath(boardDir, s.taskId), 'utf-8'));
    const ok = validateSession(raw);
    if (!ok) {
      const errs = (validateSession.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`schema rejected spawn-time session (empty paneId):\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });
});

// ─── archiveSession ─────────────────────────────────────────────────────────

describe('archiveSession', () => {
  it('moves the session file to sessions/archived/', () => {
    const s = mkSession();
    writeSession(boardDir, s);
    const originalPath = sessionFilePath(boardDir, s.taskId);
    expect(existsSync(originalPath)).toBe(true);

    const result = archiveSession(boardDir, s.taskId);
    expect(result).toBe(true);

    // Original gone
    expect(existsSync(originalPath)).toBe(false);

    // Archive exists
    const archivePath = path.join(sessionsArchiveDir(boardDir), `aisdlc-462.session.json`);
    expect(existsSync(archivePath)).toBe(true);
  });

  it('returns false when the session file does not exist', () => {
    expect(archiveSession(boardDir, 'AISDLC-999')).toBe(false);
  });

  it('preserves session content after archive', () => {
    const s = mkSession({ status: 'done', prUrl: 'https://github.com/org/repo/pull/800' });
    writeSession(boardDir, s);
    archiveSession(boardDir, s.taskId);
    const archivePath = path.join(sessionsArchiveDir(boardDir), `aisdlc-462.session.json`);
    const r = JSON.parse(readFileSync(archivePath, 'utf-8')) as DispatchSession;
    expect(r.prUrl).toBe('https://github.com/org/repo/pull/800');
  });
});
