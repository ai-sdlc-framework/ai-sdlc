/**
 * Hermetic tests for the execute-parallel-cleanup command body (AISDLC-464).
 *
 * The cleanup logic lives as an embedded `node -e "..."` block inside
 * ai-sdlc-plugin/commands/execute-parallel-cleanup.md (Step 3). Rather than
 * copy that body here (which would drift), this test EXTRACTS the real node
 * script from the markdown and executes it against temp directories. So the
 * tests exercise exactly what ships.
 *
 * Covered behaviors:
 *   1. TMUX_WINDOW_RE derives the prefix — a non-`aisdlc-` task prefix
 *      (e.g. ACME-123) is archived by cleanup (not silently skipped).
 *   2. TASK_ID_RE rejects a path-traversal taskId before any path join, so a
 *      crafted session file cannot escape the sessions dir.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLEANUP_MD = path.join(__dirname, '..', 'commands', 'execute-parallel-cleanup.md');

/**
 * Extract the Step 3 kill/archive `node -e "<script>"` payload from the cleanup
 * command md. The md has two `node -e` blocks: Step 1 (candidate collector,
 * terminated by `" "$SESSIONS_DIR" "$EXPLICIT_TASKS"`) and Step 3 (kill +
 * archive, terminated by `" "$SESSIONS_DIR" "$ARCHIVE_DIR"`). We target Step 3
 * by its unique terminator so the test exercises the real path-guard + window
 * matcher (AISDLC-464).
 */
function extractCleanupNodeScript() {
  const md = readFileSync(CLEANUP_MD, 'utf8');
  const TERMINATOR = '" "$SESSIONS_DIR" "$ARCHIVE_DIR"';
  const end = md.indexOf(TERMINATOR);
  assert.ok(end !== -1, 'cleanup md must contain the Step 3 node -e block');
  // Find the `node -e "` that opens the block ending at TERMINATOR (the last
  // such opener before the terminator).
  const opener = 'node -e "';
  const start = md.lastIndexOf(opener, end);
  assert.ok(start !== -1, 'Step 3 node -e opener not found');
  return md.slice(start + opener.length, end);
}

function runCleanup(sessions) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ep-cleanup-test-'));
  const sessionsDir = path.join(tmp, 'sessions');
  const archiveDir = path.join(sessionsDir, 'archived');
  mkdirSync(archiveDir, { recursive: true });

  for (const s of sessions) {
    // Write each session file keyed by a SAFE filename so the file exists on
    // disk regardless of whether s.taskId is malicious (the traversal case
    // writes evil.session.json but carries a malicious taskId in its body).
    const fname = (s.__file || (s.taskId || 'x').toLowerCase()) + '.session.json';
    writeFileSync(path.join(sessionsDir, fname), JSON.stringify(s));
  }

  // A sentinel OUTSIDE the sessions dir that a traversal payload would target.
  const sentinel = path.join(tmp, 'sentinel.txt');
  writeFileSync(sentinel, 'keep');

  const script = extractCleanupNodeScript();
  // Build the candidates JSON the way the md does (Step 1 output), stripping
  // our internal __file helper key.
  const candidates = sessions.map(({ __file, ...rest }) => rest);
  const res = spawnSync(
    'node',
    ['-e', script, sessionsDir, archiveDir, 'ai-sdlc-parallel', JSON.stringify(candidates)],
    { encoding: 'utf8', timeout: 10_000 },
  );

  return { tmp, sessionsDir, archiveDir, sentinel, res };
}

describe('execute-parallel-cleanup command body (AISDLC-464)', () => {
  it('archives a non-aisdlc prefix session (TMUX_WINDOW_RE derives prefix)', () => {
    const { tmp, sessionsDir, archiveDir, res } = runCleanup([
      {
        schemaVersion: 'v1',
        taskId: 'ACME-123',
        tmuxSession: 'ai-sdlc-parallel',
        tmuxWindow: 'exec-acme-123',
        status: 'done',
      },
    ]);
    try {
      assert.equal(
        res.status,
        0,
        `cleanup exited non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`,
      );
      assert.ok(
        existsSync(path.join(archiveDir, 'acme-123.session.json')),
        'non-aisdlc session must be archived',
      );
      assert.ok(
        !existsSync(path.join(sessionsDir, 'acme-123.session.json')),
        'original session file must be removed',
      );
      assert.match(res.stdout, /Archived session: ACME-123/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a path-traversal taskId without escaping the sessions dir', () => {
    const { tmp, sentinel, res } = runCleanup([
      {
        __file: 'evil',
        schemaVersion: 'v1',
        taskId: '../../../sentinel',
        tmuxSession: 'ai-sdlc-parallel',
        tmuxWindow: 'exec-evil',
        status: 'done',
      },
    ]);
    try {
      assert.match(
        res.stdout + res.stderr,
        /path traversal|does not match the canonical task-ID/i,
        'cleanup must report the rejected taskId',
      );
      assert.ok(existsSync(sentinel), 'sentinel outside the sessions dir must survive');
      // The traversal payload must NOT have been archived into the sessions dir.
      assert.ok(
        !res.stdout.includes('Archived session: ../'),
        'a path-traversal taskId must not be archived',
      );
      // The Step 3 summary line counts the rejected session as an error.
      assert.match(res.stdout, /errors=1/, 'the rejected session must be counted as an error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
