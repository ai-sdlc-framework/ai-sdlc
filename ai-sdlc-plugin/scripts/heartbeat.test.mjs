/**
 * Hermetic tests for the update_session_state shell function (AISDLC-462).
 *
 * Finding #9: the heartbeat shell function in execute.md was untested at the
 * shell-glue level. This file exercises the key behaviors by:
 *   1. Creating a synthetic session file in a temp directory.
 *   2. Running a small bash script that defines update_session_state (the same
 *      function body as in execute.md) and calls it.
 *   3. Reading the resulting JSON to verify fields were updated correctly.
 *
 * Covered paths:
 *   - starting → in-progress transition on first heartbeat
 *   - currentStep updated on each call
 *   - lastHeartbeat is set to a valid ISO-8601 timestamp
 *   - status → 'done' when step === 'done'
 *   - No-op (exit 0) when session file does not exist
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ─── Canonical update_session_state function (single source of truth) ─────────
// AISDLC-464: rather than copying the function body inline (which silently
// drifts from the real implementation), the test SOURCES the canonical shell
// snippet that execute-parallel.md also sources. Any change to the real helper
// is therefore exercised by these tests automatically.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_SESSION_STATE_LIB = path.join(__dirname, 'lib', 'update-session-state.sh');

// ─── Helper: set up a temp dir, optionally write a session file, run heartbeat ─

function runHeartbeat({ taskIdLower, step, sessionContent }) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'heartbeat-test-'));
  const sessionsDir = path.join(tmpDir, '.ai-sdlc', 'dispatch', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, taskIdLower + '.session.json');
  if (sessionContent !== undefined) {
    writeFileSync(sessionFile, JSON.stringify(sessionContent, null, 2), 'utf8');
  }

  // Build a bash script that cd's into tmpDir and calls the function.
  // The function resolves the session file relative to cwd — matching execute.md behavior.
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${JSON.stringify(tmpDir)}`,
    // Source the canonical helper rather than re-declaring it (AISDLC-464).
    `source ${JSON.stringify(UPDATE_SESSION_STATE_LIB)}`,
    `update_session_state ${JSON.stringify(taskIdLower)} ${JSON.stringify(step)}`,
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  let updatedSession = null;
  try {
    updatedSession = JSON.parse(readFileSync(sessionFile, 'utf8'));
  } catch {
    // File may not exist (no-op path when no session was created)
  }

  rmSync(tmpDir, { recursive: true, force: true });

  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    session: updatedSession,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('update_session_state (heartbeat shell function)', () => {
  it('exits 0 when session file does not exist (no-op path)', () => {
    // sessionContent is undefined → no session file created
    const result = runHeartbeat({
      taskIdLower: 'aisdlc-462',
      step: '05-dev',
    });
    assert.equal(
      result.exitCode,
      0,
      `expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`,
    );
    assert.equal(result.session, null, 'session file should not be created by no-op call');
  });

  it('transitions starting → in-progress on first heartbeat', () => {
    const result = runHeartbeat({
      taskIdLower: 'aisdlc-462',
      step: '03-worktree',
      sessionContent: {
        schemaVersion: 'v1',
        taskId: 'AISDLC-462',
        tmuxSession: 'ai-sdlc-parallel',
        tmuxWindow: 'exec-aisdlc-462',
        paneId: '',
        spawnedAt: '2026-05-28T18:30:00.000Z',
        status: 'starting',
      },
    });
    assert.equal(result.exitCode, 0, `exitCode: ${result.exitCode}\nstderr: ${result.stderr}`);
    assert.equal(
      result.session?.status,
      'in-progress',
      'status should transition starting → in-progress',
    );
    assert.equal(result.session?.currentStep, '03-worktree');
    assert.ok(result.session?.lastHeartbeat, 'lastHeartbeat must be set');
    // Verify it's a valid ISO-8601 date
    assert.ok(
      !isNaN(new Date(result.session.lastHeartbeat).getTime()),
      'lastHeartbeat must be a valid ISO-8601 date',
    );
  });

  it('updates currentStep without changing in-progress status on subsequent heartbeat', () => {
    const result = runHeartbeat({
      taskIdLower: 'aisdlc-462',
      step: '07-reviewers',
      sessionContent: {
        schemaVersion: 'v1',
        taskId: 'AISDLC-462',
        tmuxSession: 'ai-sdlc-parallel',
        tmuxWindow: 'exec-aisdlc-462',
        paneId: '%14',
        spawnedAt: '2026-05-28T18:30:00.000Z',
        status: 'in-progress',
        currentStep: '05-dev',
        lastHeartbeat: '2026-05-28T18:35:00.000Z',
      },
    });
    assert.equal(result.exitCode, 0, `exitCode: ${result.exitCode}\nstderr: ${result.stderr}`);
    assert.equal(
      result.session?.status,
      'in-progress',
      'in-progress status preserved on subsequent heartbeat',
    );
    assert.equal(result.session?.currentStep, '07-reviewers');
  });

  it("transitions to 'done' when step is 'done'", () => {
    const result = runHeartbeat({
      taskIdLower: 'aisdlc-462',
      step: 'done',
      sessionContent: {
        schemaVersion: 'v1',
        taskId: 'AISDLC-462',
        tmuxSession: 'ai-sdlc-parallel',
        tmuxWindow: 'exec-aisdlc-462',
        paneId: '%14',
        spawnedAt: '2026-05-28T18:30:00.000Z',
        status: 'in-progress',
        currentStep: '13-cleanup',
        lastHeartbeat: '2026-05-28T19:00:00.000Z',
      },
    });
    assert.equal(result.exitCode, 0, `exitCode: ${result.exitCode}\nstderr: ${result.stderr}`);
    assert.equal(result.session?.status, 'done', "status must become 'done' when step === 'done'");
    assert.equal(result.session?.currentStep, 'done');
  });
});

// ─── Drift guard: command + test share the canonical helper (AISDLC-464) ──────

describe('update_session_state single-source-of-truth', () => {
  it('the canonical shell lib defines update_session_state', () => {
    const lib = readFileSync(UPDATE_SESSION_STATE_LIB, 'utf8');
    assert.match(lib, /update_session_state\(\)\s*\{/, 'lib must define the function');
  });

  it('this test sources the canonical lib rather than copying the body', () => {
    // The test file must reference the lib path and must NOT re-declare the
    // function body inline (the drift the AISDLC-464 fix removes).
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.match(
      self,
      /lib\/update-session-state\.sh/,
      'heartbeat.test.mjs must source scripts/lib/update-session-state.sh',
    );
    assert.ok(
      !/const UPDATE_SESSION_STATE_FUNC\s*=/.test(self),
      'heartbeat.test.mjs must NOT inline an UPDATE_SESSION_STATE_FUNC body',
    );
  });
});
