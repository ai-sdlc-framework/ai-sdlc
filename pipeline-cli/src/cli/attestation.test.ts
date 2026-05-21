/**
 * cli/attestation.test.ts — tests for the `cli-attestation` CLI router.
 *
 * Drives the yargs program in-process and asserts on stdout/stderr output.
 * Uses a tmp directory with fixture JSONL files; no actual subagent dispatch.
 *
 * @see pipeline-cli/src/cli/attestation.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAttestationCli } from './attestation.js';

// ── Test infrastructure ───────────────────────────────────────────────────────

let tmpRoot: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedEnvRepoRoot: string | undefined;

function flushStdout(): string {
  return stdoutChunks.join('');
}

function _flushStderr(): string {
  return stderrChunks.join('');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cli-attestation-test-'));

  stdoutChunks = [];
  stderrChunks = [];

  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  savedEnvRepoRoot = process.env['REPO_ROOT'];

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

  process.env['REPO_ROOT'] = tmpRoot;
});

afterEach(() => {
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;

  if (savedEnvRepoRoot === undefined) {
    delete process.env['REPO_ROOT'];
  } else {
    process.env['REPO_ROOT'] = savedEnvRepoRoot;
  }

  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeTranscript(taskId: string, reviewer: string): void {
  const dir = join(tmpRoot, '.ai-sdlc', 'transcripts', taskId);
  mkdirSync(dir, { recursive: true });
  const events = [
    {
      role: 'user',
      content: `[transcript-init] ${reviewer} prompt received for task ${taskId}`,
      timestamp: '2026-05-21T10:00:00.000Z',
      event: 'prompt-received',
    },
    {
      role: 'assistant',
      content: 'No critical findings.',
      timestamp: '2026-05-21T10:01:00.000Z',
      event: 'verdict-formed',
    },
  ];
  writeFileSync(
    join(dir, `${reviewer}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// ── CLI: transcripts list ─────────────────────────────────────────────────────

describe('cli-attestation transcripts list', () => {
  it('shows "no transcripts found" when directory is empty', async () => {
    await expect(buildAttestationCli(['transcripts', 'list']).parseAsync()).resolves.not.toThrow();
    expect(flushStdout()).toContain('no transcripts found');
  });

  it('lists a single transcript file', async () => {
    makeTranscript('aisdlc-383.1', 'code-reviewer');

    await expect(buildAttestationCli(['transcripts', 'list']).parseAsync()).resolves.not.toThrow();

    const out = flushStdout();
    expect(out).toContain('aisdlc-383.1');
    expect(out).toContain('code-reviewer');
    expect(out).toContain('2'); // 2 events
    expect(out).toContain('yes'); // well-formed
  });

  it('filters by task-id', async () => {
    makeTranscript('aisdlc-383.1', 'code-reviewer');
    makeTranscript('aisdlc-384', 'test-reviewer');

    await expect(
      buildAttestationCli(['transcripts', 'list', 'aisdlc-383.1']).parseAsync(),
    ).resolves.not.toThrow();

    const out = flushStdout();
    expect(out).toContain('aisdlc-383.1');
    expect(out).not.toContain('aisdlc-384');
  });

  it('shows summary line with totals', async () => {
    makeTranscript('aisdlc-383.1', 'code-reviewer');
    makeTranscript('aisdlc-383.1', 'test-reviewer');

    await expect(buildAttestationCli(['transcripts', 'list']).parseAsync()).resolves.not.toThrow();

    const out = flushStdout();
    expect(out).toContain('Summary:');
    expect(out).toContain('2 file(s)');
    expect(out).toContain('4 event(s)'); // 2 events × 2 reviewers
  });

  it('emits JSON when --json flag is set', async () => {
    makeTranscript('aisdlc-383.1', 'code-reviewer');

    await expect(
      buildAttestationCli(['transcripts', 'list', '--json']).parseAsync(),
    ).resolves.not.toThrow();

    const out = flushStdout();
    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const first = parsed[0] as Record<string, unknown>;
    expect(first['taskId']).toBe('aisdlc-383.1');
    expect(first['reviewerName']).toBe('code-reviewer');
    expect(first['eventCount']).toBe(2);
    expect(first['isWellFormed']).toBe(true);
  });

  it('uses --repo-root override', async () => {
    // tmpRoot2 is a different directory with its own transcripts
    const tmpRoot2 = mkdtempSync(join(tmpdir(), 'cli-attestation-test-override-'));
    try {
      const dir = join(tmpRoot2, '.ai-sdlc', 'transcripts', 'aisdlc-override');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'code-reviewer.jsonl'),
        JSON.stringify({
          role: 'user',
          content: 'prompt',
          timestamp: '2026-05-21T12:00:00.000Z',
        }) + '\n',
      );

      await expect(
        buildAttestationCli(['transcripts', 'list', '--repo-root', tmpRoot2]).parseAsync(),
      ).resolves.not.toThrow();

      const out = flushStdout();
      expect(out).toContain('aisdlc-override');
    } finally {
      rmSync(tmpRoot2, { recursive: true, force: true });
    }
  });

  it('shows no transcripts message when filterTaskId matches nothing', async () => {
    makeTranscript('aisdlc-383.1', 'code-reviewer');

    await expect(
      buildAttestationCli(['transcripts', 'list', 'aisdlc-999']).parseAsync(),
    ).resolves.not.toThrow();

    const out = flushStdout();
    expect(out).toContain('no transcripts found');
  });
});

// ── CLI: --help ───────────────────────────────────────────────────────────────

describe('cli-attestation --help', () => {
  it('exits with exit code 0 on --help', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(['--help']).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    // yargs exits 0 on --help; our stub throws with exit code 0 in the message
    expect(caught?.message).toMatch(/process\.exit.*["']?0["']?/);
  });
});

// ── CLI: missing subcommand ───────────────────────────────────────────────────

describe('cli-attestation missing subcommand', () => {
  it('exits non-zero when no subcommand is provided', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli([]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    // strict mode exits non-zero on missing required command
    expect(caught?.message).toMatch(/process\.exit.*["']?[1-9]/);
  });
});
