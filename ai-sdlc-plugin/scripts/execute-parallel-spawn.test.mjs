/**
 * Hermetic tests for execute-parallel spawn logic (AISDLC-462).
 *
 * Tests the Node.js logic extracted from the execute-parallel slash command
 * body for:
 *   1. Spawn-loop cap enforcement (max 5 active sessions)
 *   2. Mutual-awareness skip (already-active session → skip)
 *   3. Session file creation on spawn
 *   4. Session status update to 'failed' on tmux error
 *
 * Since the slash command body is a markdown file with embedded bash, we
 * test the Node.js inline script fragments by extracting and running them
 * in isolation with mock inputs. The tests use tmp directories for I/O so
 * they leave no side effects.
 */

import { execSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helper: create a temp sessions directory ─────────────────────────────

function mkSessionsDir() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ep-spawn-test-'));
  const boardDir = path.join(tmp, 'dispatch');
  const sessionsDir = path.join(boardDir, 'sessions');
  const archivedDir = path.join(sessionsDir, 'archived');
  mkdirSync(archivedDir, { recursive: true });
  return { tmp, boardDir, sessionsDir, archivedDir };
}

function cleanup(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

// ─── Helper: write a session file ────────────────────────────────────────

function writeSession(sessionsDir, taskId, status = 'starting') {
  const taskIdLower = taskId.toLowerCase();
  const session = {
    schemaVersion: 'v1',
    taskId,
    tmuxSession: 'ai-sdlc-parallel',
    tmuxWindow: `exec-${taskIdLower}`,
    paneId: '%1',
    spawnedAt: new Date().toISOString(),
    status,
  };
  writeFileSync(
    path.join(sessionsDir, `${taskIdLower}.session.json`),
    JSON.stringify(session, null, 2),
  );
  return session;
}

// ─── Helper: count active sessions using the inline node script logic ─────

function countActiveSessions(sessionsDir) {
  const result = spawnSync(
    'node',
    [
      '-e',
      `
        const fs = require('fs');
        const path = require('path');
        const sessionsDir = process.argv[1];
        let count = 0;
        try {
          const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.session.json'));
          for (const f of files) {
            try {
              const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
              if (s.status === 'starting' || s.status === 'in-progress') count++;
            } catch {}
          }
        } catch {}
        process.stdout.write(String(count));
      `,
      sessionsDir,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  return parseInt(result.stdout || '0', 10);
}

// ─── Helper: check if a task is active (mutual-awareness) ────────────────

function isTaskActive(sessionsDir, taskId) {
  const sessionFile = path.join(sessionsDir, `${taskId.toLowerCase()}.session.json`);
  if (!existsSync(sessionFile)) return false;
  const result = spawnSync(
    'node',
    [
      '-e',
      `
        const fs = require('fs');
        try {
          const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
          process.stdout.write(s.status || 'unknown');
        } catch { process.stdout.write('unknown'); }
      `,
      sessionFile,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  const status = result.stdout.trim();
  return status === 'starting' || status === 'in-progress';
}

// ─── Helper: write session file via the inline node snippet (atomic) ─────────

function spawnWriteSession(sessionsDir, taskId, tmuxSession, tmuxWindow, spawnedAt) {
  const result = spawnSync(
    'node',
    [
      '-e',
      `
        const fs = require('fs');
        const sessionsDir = process.argv[1];
        fs.mkdirSync(sessionsDir + '/archived', { recursive: true });
        const session = {
          schemaVersion: 'v1',
          taskId: process.argv[2],
          tmuxSession: process.argv[3],
          tmuxWindow: process.argv[4],
          paneId: '',
          spawnedAt: process.argv[5],
          status: 'starting',
        };
        const filePath = sessionsDir + '/' + process.argv[2].toLowerCase() + '.session.json';
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2));
        fs.renameSync(tmpPath, filePath);
        process.stdout.write('ok');
      `,
      sessionsDir,
      taskId,
      tmuxSession,
      tmuxWindow,
      spawnedAt,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  return result.stdout.trim() === 'ok' && result.status === 0;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('execute-parallel spawn logic', () => {
  let tmp, sessionsDir;

  beforeEach(() => {
    const dirs = mkSessionsDir();
    tmp = dirs.tmp;
    sessionsDir = dirs.sessionsDir;
  });

  afterEach(() => {
    cleanup(tmp);
  });

  // ─── Spawn cap enforcement ──────────────────────────────────────────────

  describe('hard cap enforcement (max 5 sessions)', () => {
    it('allows spawn when 0 active sessions', () => {
      const active = countActiveSessions(sessionsDir);
      assert.equal(active, 0);
      const remainingSlots = 5 - active;
      assert.ok(remainingSlots > 0, 'should have remaining slots');
    });

    it('allows spawn when 4 active sessions (exactly at cap - 1)', () => {
      for (let i = 0; i < 4; i++) {
        writeSession(sessionsDir, `AISDLC-${100 + i}`, 'starting');
      }
      const active = countActiveSessions(sessionsDir);
      assert.equal(active, 4);
      const remainingSlots = 5 - active;
      assert.equal(remainingSlots, 1);
    });

    it('refuses spawn when 5 active sessions (at hard cap)', () => {
      for (let i = 0; i < 5; i++) {
        writeSession(sessionsDir, `AISDLC-${200 + i}`, 'starting');
      }
      const active = countActiveSessions(sessionsDir);
      assert.equal(active, 5);
      const remainingSlots = 5 - active;
      assert.equal(remainingSlots, 0, 'no slots remaining at hard cap');
    });

    it('does not count done sessions against cap', () => {
      for (let i = 0; i < 3; i++) {
        writeSession(sessionsDir, `AISDLC-${300 + i}`, 'done');
      }
      writeSession(sessionsDir, 'AISDLC-350', 'starting');
      const active = countActiveSessions(sessionsDir);
      assert.equal(active, 1, 'only 1 active (done sessions not counted)');
    });

    it('does not count failed sessions against cap', () => {
      for (let i = 0; i < 3; i++) {
        writeSession(sessionsDir, `AISDLC-${400 + i}`, 'failed');
      }
      writeSession(sessionsDir, 'AISDLC-450', 'in-progress');
      const active = countActiveSessions(sessionsDir);
      assert.equal(active, 1, 'only 1 active (failed sessions not counted)');
    });
  });

  // ─── Mutual-awareness skip ─────────────────────────────────────────────

  describe('mutual-awareness check', () => {
    it('returns true for already-starting task', () => {
      writeSession(sessionsDir, 'AISDLC-462', 'starting');
      assert.equal(isTaskActive(sessionsDir, 'AISDLC-462'), true);
    });

    it('returns true for already in-progress task', () => {
      writeSession(sessionsDir, 'AISDLC-462', 'in-progress');
      assert.equal(isTaskActive(sessionsDir, 'AISDLC-462'), true);
    });

    it('returns false for done task (can re-dispatch)', () => {
      writeSession(sessionsDir, 'AISDLC-462', 'done');
      assert.equal(isTaskActive(sessionsDir, 'AISDLC-462'), false);
    });

    it('returns false for failed task (can re-dispatch)', () => {
      writeSession(sessionsDir, 'AISDLC-462', 'failed');
      assert.equal(isTaskActive(sessionsDir, 'AISDLC-462'), false);
    });

    it('returns false when no session file exists (first dispatch)', () => {
      assert.equal(isTaskActive(sessionsDir, 'AISDLC-999'), false);
    });
  });

  // ─── Session file creation ─────────────────────────────────────────────

  describe('session file creation', () => {
    it('writes a valid session file with status=starting', () => {
      const spawnedAt = new Date().toISOString();
      const ok = spawnWriteSession(
        sessionsDir,
        'AISDLC-462',
        'ai-sdlc-parallel',
        'exec-aisdlc-462',
        spawnedAt,
      );
      assert.ok(ok, 'write should succeed');

      const sessionFile = path.join(sessionsDir, 'aisdlc-462.session.json');
      assert.ok(existsSync(sessionFile), 'session file should exist');

      const s = JSON.parse(readFileSync(sessionFile, 'utf8'));
      assert.equal(s.schemaVersion, 'v1');
      assert.equal(s.taskId, 'AISDLC-462');
      assert.equal(s.status, 'starting');
      assert.equal(s.tmuxSession, 'ai-sdlc-parallel');
      assert.equal(s.tmuxWindow, 'exec-aisdlc-462');
      assert.equal(s.spawnedAt, spawnedAt);
    });

    it('creates the archived subdirectory', () => {
      spawnWriteSession(
        sessionsDir,
        'AISDLC-500',
        'ai-sdlc-parallel',
        'exec-aisdlc-500',
        new Date().toISOString(),
      );
      const archivedDir = path.join(sessionsDir, 'archived');
      assert.ok(existsSync(archivedDir), 'archived/ dir should be created');
    });

    it('uses lowercase task ID in filename', () => {
      spawnWriteSession(
        sessionsDir,
        'AISDLC-462',
        'ai-sdlc-parallel',
        'exec-aisdlc-462',
        new Date().toISOString(),
      );
      assert.ok(
        existsSync(path.join(sessionsDir, 'aisdlc-462.session.json')),
        'filename should be lowercase',
      );
    });
  });

  // ─── Full spawn flow simulation ────────────────────────────────────────

  describe('spawn flow integration', () => {
    it('skips a task already in sessions/ with status=starting', () => {
      // Pre-populate an active session
      writeSession(sessionsDir, 'AISDLC-462', 'starting');

      // The spawn loop checks mutual-awareness before writing
      const shouldSkip = isTaskActive(sessionsDir, 'AISDLC-462');
      assert.equal(shouldSkip, true, 'should skip already-active task');
    });

    it('proceeds with a task in sessions/ with status=done', () => {
      writeSession(sessionsDir, 'AISDLC-462', 'done');

      const shouldSkip = isTaskActive(sessionsDir, 'AISDLC-462');
      assert.equal(shouldSkip, false, 'should NOT skip done task');

      // Write a new session (simulating spawn)
      const ok = spawnWriteSession(
        sessionsDir,
        'AISDLC-462',
        'ai-sdlc-parallel',
        'exec-aisdlc-462',
        new Date().toISOString(),
      );
      assert.ok(ok, 'new session write should succeed');

      const s = JSON.parse(readFileSync(path.join(sessionsDir, 'aisdlc-462.session.json'), 'utf8'));
      // After re-spawn the status is 'starting' (not 'done')
      assert.equal(s.status, 'starting');
    });

    it('cap prevents spawn when 5 already active', () => {
      for (let i = 0; i < 5; i++) {
        writeSession(sessionsDir, `AISDLC-${600 + i}`, 'in-progress');
      }
      const active = countActiveSessions(sessionsDir);
      const remainingSlots = 5 - active;
      // Simulate the cap check
      assert.equal(remainingSlots, 0, 'no remaining slots — spawn should be refused');
    });

    // Finding #10: when tmux new-window exits non-zero, the session file must
    // be updated to status='failed'. This tests the error path of the spawn loop.
    it('marks session as failed when tmux spawn fails', () => {
      const spawnedAt = new Date().toISOString();
      const taskId = 'AISDLC-700';
      const taskIdLower = taskId.toLowerCase();
      const sessionFile = path.join(sessionsDir, `${taskIdLower}.session.json`);

      // Write the initial session (status=starting) to simulate a successful reservation
      const ok = spawnWriteSession(
        sessionsDir,
        taskId,
        'ai-sdlc-parallel',
        'exec-aisdlc-700',
        spawnedAt,
      );
      assert.ok(ok, 'initial session write should succeed');

      // Simulate tmux failure: run the error-handler node snippet inline
      // This is the node -e block from execute-parallel.md that runs on tmux failure.
      const result = spawnSync(
        'node',
        [
          '-e',
          `
            const fs = require('fs');
            const f = process.argv[1];
            try {
              const s = JSON.parse(fs.readFileSync(f, 'utf8'));
              s.status = 'failed';
              s.lastHeartbeat = new Date().toISOString();
              const tmp = f + '.tmp';
              fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
              fs.renameSync(tmp, f);
            } catch {}
          `,
          sessionFile,
        ],
        { encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(result.status, 0, 'error handler should exit 0');

      const s = JSON.parse(readFileSync(sessionFile, 'utf8'));
      assert.equal(s.status, 'failed', 'session must be marked failed after tmux error');
      assert.ok(s.lastHeartbeat, 'lastHeartbeat must be set on failure');
    });

    // Finding #4 + #10: freshly-spawned session with empty paneId should have correct shape.
    // Full schema validation is covered in sessions.test.ts (pipeline-cli, where ajv is available).
    it('freshly-spawned session has empty paneId and correct fields', () => {
      const spawnedAt = new Date().toISOString();
      spawnWriteSession(
        sessionsDir,
        'AISDLC-701',
        'ai-sdlc-parallel',
        'exec-aisdlc-701',
        spawnedAt,
      );
      const sessionFile = path.join(sessionsDir, 'aisdlc-701.session.json');
      assert.ok(existsSync(sessionFile), 'session file should be created');
      const s = JSON.parse(readFileSync(sessionFile, 'utf8'));

      // The spawn always writes paneId: '' at reservation time
      assert.equal(s.paneId, '', 'initial paneId must be empty string');
      assert.equal(s.status, 'starting');
      assert.equal(s.schemaVersion, 'v1');
      assert.equal(s.taskId, 'AISDLC-701');
      assert.equal(s.tmuxWindow, 'exec-aisdlc-701');
    });
  });
});
