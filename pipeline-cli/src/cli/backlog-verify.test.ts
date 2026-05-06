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
import {
  buildBacklogVerifyCli,
  extractTaskIdFromFilename,
  verifyBacklogIntegrity,
} from './backlog-verify.js';

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

// ── CLI handler tests (yargs router) ───────────────────────────────────

describe('buildBacklogVerifyCli — yargs handler exit codes + output', () => {
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
    process.argv = ['node', 'cli-backlog-verify', ...args];
  }

  async function runCli(): Promise<{ exitCode: number | null; thrown?: unknown }> {
    try {
      await buildBacklogVerifyCli().parseAsync();
      return { exitCode: null };
    } catch (e) {
      const m = (e as Error).message?.match(/^process\.exit\((\d+)\)$/);
      if (m) return { exitCode: Number(m[1]) };
      return { exitCode: null, thrown: e };
    }
  }

  it('clean state — text: exits 0 with OK summary', async () => {
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'aisdlc-1 - foo.md'),
      '---\nid: AISDLC-1\n---\n',
      'utf8',
    );
    setArgv('--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toContain('OK');
    expect(stdoutChunks.join('')).toContain('1 task file(s) scanned');
  });

  it('clean state with --quiet: exits 0 with no output', async () => {
    setArgv('--work-dir', workDir, '--quiet');
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toBe('');
  });

  it('clean state with --format json: emits structured ok=true', async () => {
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'aisdlc-1 - foo.md'),
      '---\nid: AISDLC-1\n---\n',
      'utf8',
    );
    setArgv('--work-dir', workDir, '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(true);
    expect(json.duplicates).toEqual([]);
    expect(json.locations).toHaveLength(1);
  });

  it('duplicates detected — text: exits 1 with stderr listing', async () => {
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'aisdlc-1 - dup.md'),
      '---\nid: AISDLC-1\n---\n',
      'utf8',
    );
    writeFileSync(
      join(workDir, 'backlog', 'completed', 'aisdlc-1 - dup.md'),
      '---\nid: AISDLC-1\nstatus: Done\n---\n',
      'utf8',
    );
    setArgv('--work-dir', workDir);
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    const err = stderrChunks.join('');
    expect(err).toContain('DUPLICATE TASK IDs DETECTED');
    expect(err).toContain('aisdlc-1');
    expect(err).toContain('[tasks]');
    expect(err).toContain('[completed]');
    expect(err).toContain('cli-task-complete.mjs');
  });

  it('duplicates detected --format json: exits 1 with structured payload', async () => {
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'aisdlc-1 - dup.md'),
      '---\nid: AISDLC-1\n---\n',
      'utf8',
    );
    writeFileSync(
      join(workDir, 'backlog', 'completed', 'aisdlc-1 - dup.md'),
      '---\nid: AISDLC-1\nstatus: Done\n---\n',
      'utf8',
    );
    setArgv('--work-dir', workDir, '--format', 'json');
    const r = await runCli();
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(stdoutChunks.join('').trim());
    expect(json.ok).toBe(false);
    expect(json.duplicates).toContain('aisdlc-1');
    expect(json.locations).toHaveLength(2);
  });
});
