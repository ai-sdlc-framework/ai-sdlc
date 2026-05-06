/**
 * Hermetic tests for `completeTaskAtomically()` (AISDLC-203).
 *
 * Covers the duplicate-detection regression described in AISDLC-203:
 * Codex/external completion paths were copying the completed file without
 * removing the original from backlog/tasks/, causing the same task ID to
 * appear in BOTH directories.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { completeTaskAtomically, DuplicateTaskFileError } from './complete-task.js';

// ── Fixtures ───────────────────────────────────────────────────────────

let workDir: string;

const TASK_FM =
  '---\nid: AISDLC-203\ntitle: test task\nstatus: In Progress\n---\n\n## Description\n\nTest.\n';
const TASK_FILENAME = 'aisdlc-203 - test-task.md';

function setupWorkDir(): void {
  workDir = mkdtempSync(join(tmpdir(), 'cli-complete-task-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(workDir, 'backlog', 'completed'), { recursive: true });
}

function teardownWorkDir(): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function writeTaskFile(subdir: 'tasks' | 'completed', content = TASK_FM): string {
  const path = join(workDir, 'backlog', subdir, TASK_FILENAME);
  writeFileSync(path, content, 'utf8');
  return path;
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(setupWorkDir);
afterEach(teardownWorkDir);

describe('completeTaskAtomically — happy path', () => {
  it('moves the file from tasks/ to completed/', () => {
    const src = writeTaskFile('tasks');
    const result = completeTaskAtomically('AISDLC-203', workDir);

    expect(result.alreadyDone).toBe(false);
    if (result.alreadyDone) return; // type-narrow

    const dest = join(workDir, 'backlog', 'completed', TASK_FILENAME);
    expect(result.from).toBe(src);
    expect(result.to).toBe(dest);
    expect(result.verified).toBe(true);

    // Source must be gone.
    expect(existsSync(src)).toBe(false);
    // Destination must exist.
    expect(existsSync(dest)).toBe(true);
  });

  it('patches status to Done in the moved file', () => {
    writeTaskFile('tasks');
    const result = completeTaskAtomically('AISDLC-203', workDir);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    const content = readFileSync(result.to, 'utf8');
    expect(content).toContain('status: Done');
    expect(content).not.toContain('status: In Progress');
  });

  it('preserves unknown frontmatter keys when patching status', () => {
    const withExtra =
      '---\nid: AISDLC-203\ntitle: test task\nstatus: In Progress\ncustom_key: preserved\nassignee: []\n---\n\n## Body\n';
    writeTaskFile('tasks', withExtra);
    const result = completeTaskAtomically('AISDLC-203', workDir);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    const content = readFileSync(result.to, 'utf8');
    expect(content).toContain('custom_key: preserved');
    expect(content).toContain('assignee: []');
    expect(content).toContain('status: Done');
  });

  it('is case-insensitive for task ID lookup', () => {
    writeTaskFile('tasks');
    const result = completeTaskAtomically('aisdlc-203', workDir);
    expect(result.alreadyDone).toBe(false);
    if (!result.alreadyDone) {
      expect(existsSync(result.to)).toBe(true);
    }
  });
});

describe('completeTaskAtomically — idempotency (already in completed/)', () => {
  it('returns AlreadyDoneResult when file is only in completed/', () => {
    const dest = writeTaskFile('completed');
    const result = completeTaskAtomically('AISDLC-203', workDir);

    expect(result.alreadyDone).toBe(true);
    if (!result.alreadyDone) return; // type-narrow
    expect(result.location).toBe(dest);
  });

  it('does not throw on idempotent call', () => {
    writeTaskFile('completed');
    expect(() => completeTaskAtomically('AISDLC-203', workDir)).not.toThrow();
  });
});

describe('completeTaskAtomically — duplicate detection (regression AISDLC-203)', () => {
  it('throws DuplicateTaskFileError when file exists in BOTH tasks/ and completed/', () => {
    // Simulate the Codex copy-only pattern: original in tasks/, copy in completed/.
    writeTaskFile('tasks');
    writeTaskFile('completed');

    expect(() => completeTaskAtomically('AISDLC-203', workDir)).toThrow(DuplicateTaskFileError);
  });

  it('DuplicateTaskFileError message identifies both file paths', () => {
    writeTaskFile('tasks');
    writeTaskFile('completed');

    let caught: unknown;
    try {
      completeTaskAtomically('AISDLC-203', workDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DuplicateTaskFileError);
    const err = caught as DuplicateTaskFileError;
    expect(err.message).toContain('backlog/tasks');
    expect(err.message).toContain('backlog/completed');
    expect(err.taskId).toBe('AISDLC-203');
    expect(err.tasksPath).toContain(TASK_FILENAME);
    expect(err.completedPath).toContain(TASK_FILENAME);
  });
});

describe('completeTaskAtomically — error: task not found', () => {
  it('throws when task file is absent from both directories', () => {
    expect(() => completeTaskAtomically('AISDLC-999', workDir)).toThrow(
      /Task file not found for AISDLC-999/,
    );
  });
});
