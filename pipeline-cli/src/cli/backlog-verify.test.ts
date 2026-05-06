/**
 * Hermetic tests for `verifyBacklogIntegrity()` (AISDLC-203).
 *
 * Guards the duplicate-detection gate that closes the Codex copy-only
 * completion pattern (AISDLC-175, 181, 184, 191, 197, 201, 203).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractTaskIdFromFilename, verifyBacklogIntegrity } from './backlog-verify.js';

// ── Fixtures ───────────────────────────────────────────────────────────

let workDir: string;

function setupWorkDir(): void {
  workDir = mkdtempSync(join(tmpdir(), 'cli-backlog-verify-test-'));
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

function touch(bucket: 'tasks' | 'completed', filename: string): void {
  writeFileSync(
    join(workDir, 'backlog', bucket, filename),
    `---\nid: test\nstatus: ${bucket === 'completed' ? 'Done' : 'In Progress'}\n---\n`,
    'utf8',
  );
}

beforeEach(setupWorkDir);
afterEach(teardownWorkDir);

// ── extractTaskIdFromFilename ──────────────────────────────────────────

describe('extractTaskIdFromFilename', () => {
  it('extracts lowercase taskId from standard backlog filename', () => {
    expect(extractTaskIdFromFilename('aisdlc-203 - codex-workflow-atomic.md')).toBe('aisdlc-203');
  });

  it('handles mixed-case prefix', () => {
    expect(extractTaskIdFromFilename('AISDLC-203 - Some Title.md')).toBe('aisdlc-203');
  });

  it('handles dotted sub-task IDs', () => {
    expect(extractTaskIdFromFilename('aisdlc-203.1 - sub-task.md')).toBe('aisdlc-203.1');
  });

  it('returns null for filenames that do not match the convention', () => {
    expect(extractTaskIdFromFilename('README.md')).toBeNull();
    expect(extractTaskIdFromFilename('some-file-without-separator.md')).toBeNull();
    expect(extractTaskIdFromFilename('not-a-task.md')).toBeNull();
  });
});

// ── verifyBacklogIntegrity ─────────────────────────────────────────────

describe('verifyBacklogIntegrity — clean state', () => {
  it('returns ok=true when both directories are empty', () => {
    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(true);
    expect(result.duplicates).toEqual([]);
    expect(result.locations).toHaveLength(0);
  });

  it('returns ok=true when tasks have no overlap', () => {
    touch('tasks', 'aisdlc-200 - task-200.md');
    touch('completed', 'aisdlc-199 - task-199.md');

    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(true);
    expect(result.duplicates).toEqual([]);
    expect(result.locations).toHaveLength(2);
  });

  it('collects bucket metadata correctly', () => {
    touch('tasks', 'aisdlc-200 - task-200.md');
    const result = verifyBacklogIntegrity(workDir);
    expect(result.locations[0].bucket).toBe('tasks');
    expect(result.locations[0].idLower).toBe('aisdlc-200');
    expect(result.locations[0].relativePath).toContain('backlog/tasks/');
  });
});

describe('verifyBacklogIntegrity — duplicate detection (regression AISDLC-203)', () => {
  it('returns ok=false when a task ID appears in both tasks/ and completed/', () => {
    // Simulate the Codex copy-only pattern.
    touch('tasks', 'aisdlc-201 - existing-task.md');
    touch('completed', 'aisdlc-201 - existing-task.md');

    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(false);
    expect(result.duplicates).toContain('aisdlc-201');
  });

  it('identifies multiple duplicate task IDs when multiple are present', () => {
    touch('tasks', 'aisdlc-201 - task-201.md');
    touch('completed', 'aisdlc-201 - task-201.md');
    touch('tasks', 'aisdlc-175 - task-175.md');
    touch('completed', 'aisdlc-175 - task-175.md');
    // Clean one stays clean.
    touch('tasks', 'aisdlc-204 - task-204.md');

    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(false);
    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates).toContain('aisdlc-201');
    expect(result.duplicates).toContain('aisdlc-175');
    // Non-duplicate not listed.
    expect(result.duplicates).not.toContain('aisdlc-204');
  });

  it('locations list contains all files (including duplicates) for reporting', () => {
    touch('tasks', 'aisdlc-201 - task-201.md');
    touch('completed', 'aisdlc-201 - task-201.md');

    const result = verifyBacklogIntegrity(workDir);
    const forTask = result.locations.filter((l) => l.idLower === 'aisdlc-201');
    expect(forTask).toHaveLength(2);
    const buckets = forTask.map((l) => l.bucket).sort();
    expect(buckets).toEqual(['completed', 'tasks']);
  });
});

describe('verifyBacklogIntegrity — resilience', () => {
  it('skips non-.md files', () => {
    writeFileSync(join(workDir, 'backlog', 'tasks', 'README.txt'), 'ignore me', 'utf8');
    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(true);
    expect(result.locations).toHaveLength(0);
  });

  it('skips files that do not match the backlog filename convention', () => {
    writeFileSync(join(workDir, 'backlog', 'tasks', 'some-random-notes.md'), '# notes', 'utf8');
    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(true);
    expect(result.locations).toHaveLength(0);
  });

  it('handles missing backlog directories gracefully', () => {
    // Remove both dirs.
    rmSync(join(workDir, 'backlog'), { recursive: true, force: true });
    const result = verifyBacklogIntegrity(workDir);
    expect(result.ok).toBe(true);
    expect(result.locations).toHaveLength(0);
  });
});
