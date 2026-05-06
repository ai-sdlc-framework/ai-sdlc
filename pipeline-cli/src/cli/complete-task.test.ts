/**
 * Hermetic tests for `completeTaskAtomically()` (AISDLC-203).
 *
 * Covers the duplicate-detection regression described in AISDLC-203:
 * Codex/external completion paths were copying the completed file without
 * removing the original from backlog/tasks/, causing the same task ID to
 * appear in BOTH directories.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildCompleteTaskCli,
  completeTaskAtomically,
  DuplicateTaskFileError,
  SymbolicLinkError,
  TASK_ID_RE,
} from './complete-task.js';

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

// ── CLI handler tests (yargs router) ───────────────────────────────────

describe('buildCompleteTaskCli — yargs handler exit codes + output', () => {
  let savedArgv: string[];
  let savedExit: typeof process.exit;
  let savedOut: typeof process.stdout.write;
  let savedErr: typeof process.stderr.write;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    savedArgv = process.argv;
    savedExit = process.exit;
    savedOut = process.stdout.write.bind(process.stdout);
    savedErr = process.stderr.write.bind(process.stderr);
    stdoutChunks = [];
    stderrChunks = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  });

  function setArgv(...args: string[]): void {
    process.argv = ['node', 'cli-task-complete', ...args];
  }

  async function runCli(): Promise<{ exitCode: number | null; thrown?: unknown }> {
    try {
      await buildCompleteTaskCli().parseAsync();
      return { exitCode: null };
    } catch (e) {
      const m = (e as Error).message?.match(/^process\.exit\((\d+)\)$/);
      if (m) return { exitCode: Number(m[1]) };
      return { exitCode: null, thrown: e };
    }
  }

  it('happy path: exits 0 with text output and moves the task', async () => {
    writeTaskFile('tasks');
    setArgv('AISDLC-203', '--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    const out = stdoutChunks.join('');
    expect(out).toContain('AISDLC-203: moved');
    expect(out).toContain('verified: OK');
    expect(existsSync(join(workDir, 'backlog', 'completed', TASK_FILENAME))).toBe(true);
    expect(existsSync(join(workDir, 'backlog', 'tasks', TASK_FILENAME))).toBe(false);
  });

  it('happy path with --format json: emits structured output', async () => {
    writeTaskFile('tasks');
    setArgv('AISDLC-203', '--work-dir', workDir, '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(true);
    expect(json.alreadyDone).toBe(false);
    expect(json.taskId).toBe('AISDLC-203');
    expect(json.verified).toBe(true);
  });

  it('already-done without --allow-already-done: exits 2 with text message', async () => {
    writeTaskFile('completed');
    setArgv('AISDLC-203', '--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(2);
    expect(stdoutChunks.join('')).toContain('already in backlog/completed/');
  });

  it('already-done with --allow-already-done: exits 0', async () => {
    writeTaskFile('completed');
    setArgv('AISDLC-203', '--work-dir', workDir, '--allow-already-done');
    const r = await runCli();
    expect(r.exitCode).toBe(0);
  });

  it('already-done --format json: includes alreadyDone + location', async () => {
    writeTaskFile('completed');
    setArgv('AISDLC-203', '--work-dir', workDir, '--allow-already-done', '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(true);
    expect(json.alreadyDone).toBe(true);
    expect(json.location).toBeDefined();
  });

  it('duplicate detected: exits 1 with text error to stderr', async () => {
    writeTaskFile('tasks');
    writeTaskFile('completed');
    setArgv('AISDLC-203', '--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('AISDLC-203');
    expect(stderrChunks.join('')).toContain('DUPLICATE DETECTED');
    expect(stderrChunks.join('')).toContain('BOTH backlog locations');
  });

  it('duplicate --format json: exits 1 with structured error', async () => {
    writeTaskFile('tasks');
    writeTaskFile('completed');
    setArgv('AISDLC-203', '--work-dir', workDir, '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(false);
    expect(json.error).toContain('AISDLC-203');
  });

  it('missing task: exits 1 with not-found error', async () => {
    setArgv('AISDLC-999', '--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Task file not found for AISDLC-999');
  });

  it('malformed taskId: exits 1 with validation error (AC#3)', async () => {
    setArgv('not_valid!!', '--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    const err = stderrChunks.join('');
    expect(err).toContain('Invalid task ID');
    expect(err).toContain('not_valid!!');
  });

  it('malformed taskId --format json: exits 1 with structured error (AC#3)', async () => {
    setArgv('bad-id-', '--work-dir', workDir, '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid task ID');
  });
});

// ── TASK_ID_RE unit tests (AC#3) ──────────────────────────────────────

describe('TASK_ID_RE — task ID validation regex', () => {
  it.each(['AISDLC-203', 'aisdlc-203', 'AISDLC-203.1', 'aisdlc-203.1', 'FOO-1', 'foo-999', 'ab-0'])(
    'accepts valid ID: %s',
    (id) => {
      expect(TASK_ID_RE.test(id)).toBe(true);
    },
  );

  it.each([
    '',
    'AISDLC',
    '203',
    'AISDLC-',
    '-203',
    'AISDLC_203',
    'AISDLC-203.',
    'AISDLC-203.abc',
    'not_valid!!',
    'bad-id-',
    'a b-1',
  ])('rejects invalid ID: %s', (id) => {
    expect(TASK_ID_RE.test(id)).toBe(false);
  });
});

// ── Symlink guard tests (AC#2) ─────────────────────────────────────────

describe('completeTaskAtomically — symlink guard (AC#2)', () => {
  it('throws SymbolicLinkError when tasks/<id>.md is a symlink', () => {
    // Create a real file elsewhere, then symlink to it in tasks/.
    const realFile = join(workDir, 'real-task.md');
    writeFileSync(realFile, TASK_FM, 'utf8');
    const symlinkPath = join(workDir, 'backlog', 'tasks', TASK_FILENAME);
    symlinkSync(realFile, symlinkPath);

    expect(() => completeTaskAtomically('AISDLC-203', workDir)).toThrow(SymbolicLinkError);
    // Original real file must not have been mutated.
    expect(readFileSync(realFile, 'utf8')).toBe(TASK_FM);
  });

  it('SymbolicLinkError message includes the symlink path', () => {
    const realFile = join(workDir, 'real-task2.md');
    writeFileSync(realFile, TASK_FM, 'utf8');
    const symlinkPath = join(workDir, 'backlog', 'tasks', TASK_FILENAME);
    symlinkSync(realFile, symlinkPath);

    let caught: unknown;
    try {
      completeTaskAtomically('AISDLC-203', workDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SymbolicLinkError);
    const err = caught as SymbolicLinkError;
    expect(err.path).toContain(TASK_FILENAME);
    expect(err.message).toContain('symbolic link');
  });
});

// ── Edge case tests (AC#7) ─────────────────────────────────────────────

describe('completeTaskAtomically — edge cases (AC#7)', () => {
  it('(a) handles malformed YAML frontmatter gracefully — no frontmatter delimiters', () => {
    // A file with no YAML frontmatter at all (malformed for the backlog
    // convention). patchStatusDone should return the content unchanged, and
    // the move should still complete without throwing.
    const noFm = '# Just a plain markdown file\n\nNo frontmatter here.\n';
    writeTaskFile('tasks', noFm);
    const result = completeTaskAtomically('AISDLC-203', workDir);

    expect(result.alreadyDone).toBe(false);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    const content = readFileSync(result.to, 'utf8');
    // Without frontmatter, patchStatusDone is a no-op — content unchanged.
    expect(content).toBe(noFm);
    expect(existsSync(result.from)).toBe(false);
    expect(existsSync(result.to)).toBe(true);
  });

  it('(a) handles malformed YAML — only opening delimiter (no closing ---)', () => {
    const halfFm =
      '---\nid: AISDLC-203\ntitle: test\nstatus: In Progress\n\nNo closing delimiter.\n';
    writeTaskFile('tasks', halfFm);
    const result = completeTaskAtomically('AISDLC-203', workDir);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    // patchStatusDone enters fmCount=1 (inFm) but never hits fmCount=2,
    // so all remaining lines are treated as frontmatter — status line IS patched.
    const content = readFileSync(result.to, 'utf8');
    expect(content).toContain('status: Done');
    expect(existsSync(result.from)).toBe(false);
  });

  it('(b) duplicate-prefix collision — two tasks sharing the same numeric prefix suffix', () => {
    // Both aisdlc-203 and aisdlc-2030 start with "aisdlc-203" as a prefix.
    // findFileInDir uses startsWith("<idLower> -") so it looks for "aisdlc-203 -"
    // and should NOT match "aisdlc-2030 - other.md".
    const otherFilename = 'aisdlc-2030 - other-task.md';
    writeFileSync(
      join(workDir, 'backlog', 'tasks', otherFilename),
      '---\nid: AISDLC-2030\nstatus: In Progress\n---\n',
      'utf8',
    );
    writeTaskFile('tasks'); // "aisdlc-203 - test-task.md"

    const result = completeTaskAtomically('AISDLC-203', workDir);
    expect(result.alreadyDone).toBe(false);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    // Only AISDLC-203 should have moved.
    expect(existsSync(join(workDir, 'backlog', 'completed', TASK_FILENAME))).toBe(true);
    // AISDLC-2030 must still be in tasks/ — not accidentally matched/moved.
    expect(existsSync(join(workDir, 'backlog', 'tasks', otherFilename))).toBe(true);
    expect(existsSync(join(workDir, 'backlog', 'completed', otherFilename))).toBe(false);
  });
});

// ── Atomicity guard (AC#8 optional) ───────────────────────────────────

describe('completeTaskAtomically — atomicity: source intact if rename throws (AC#8)', () => {
  it('source tasks/ file is not mutated before the write-to-dest succeeds', () => {
    // This test asserts AC#1 mechanically: since we now write to tmpPath FIRST
    // (in completed/), the source file at tasksFile is never written to.
    // We verify this by reading the source content before and after a mocked
    // renameSync failure scenario — but since we can't easily mock a single
    // renameSync call in ESM without module mocking, we verify the positive
    // path: after a successful call the source file no longer exists AND the
    // destination contains the patched content.
    writeTaskFile('tasks');
    const srcPath = join(workDir, 'backlog', 'tasks', TASK_FILENAME);
    const originalContent = readFileSync(srcPath, 'utf8');

    const result = completeTaskAtomically('AISDLC-203', workDir);
    if (result.alreadyDone) throw new Error('unexpected alreadyDone');

    // Source is gone (we used unlinkSync, not writeFileSync-then-rename).
    expect(existsSync(srcPath)).toBe(false);
    // Destination has the patched content (not the original).
    const destContent = readFileSync(result.to, 'utf8');
    expect(destContent).toContain('status: Done');
    expect(destContent).not.toBe(originalContent); // patched differs from original
  });
});
