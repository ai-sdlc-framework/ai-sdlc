/**
 * cli/attestation.test.ts — tests for the `cli-attestation` CLI router.
 *
 * Drives the yargs program in-process and asserts on stdout/stderr output.
 * Uses a tmp directory with fixture JSONL files; no actual subagent dispatch.
 *
 * Covers both Phase 1.1 (383.1) transcripts subcommands and Phase 1.2 (383.2)
 * merkle-root + merkle-proof subcommands.
 *
 * @see pipeline-cli/src/cli/attestation.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nonceMarkerLiteral } from '../attestation/harness-transcript.js';
import { V6_REFUSED_CODE } from '../attestation/v6-refusal.js';
import { buildAttestationCli, readAgentIdSidecar } from './attestation.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

/**
 * AISDLC-570 round-2 review: mocked so the `emit-leaf --claude-session-id`
 * positive-path test (below) can create a fake `~/.claude/projects/<slug>/`
 * tree without touching the real home directory. `tmpdir` and every other
 * `node:os` export pass through unmocked via `importOriginal`.
 */
const fakeHomeDirForHarnessTests = '';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHomeDirForHarnessTests || actual.homedir() };
});

/** Records the reviews ledger holds under `repoRoot`, across every task. */
function ledgerRecords(repoRoot: string): string[] {
  const dir = join(repoRoot, '.ai-sdlc', 'reviews');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
}

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

function flushStderr(): string {
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

  removeFixtureDir(tmpRoot);
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

/**
 * Write a verdict JSON file under `<tmpRoot>/.ai-sdlc/verdicts/<name>` so it
 * satisfies the AISDLC-391 traversal-hardening guard. Returns the absolute path.
 */
function writeVerdict(name: string, contents: unknown): string {
  const verdictsDir = join(tmpRoot, '.ai-sdlc', 'verdicts');
  mkdirSync(verdictsDir, { recursive: true });
  const verdictPath = join(verdictsDir, name);
  writeFileSync(verdictPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return verdictPath;
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
      removeFixtureDir(tmpRoot2);
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
    expect(caught?.message).toMatch(/process\.exit.*["']?0["']?/);
  });
});

// ── CLI: missing subcommand ───────────────────────────────────────────────────

describe('cli-attestation verify — v6 is refused (RFC-0061 phase 3)', () => {
  it('refuses with the named error and exits 1 for any head/base', async () => {
    await buildAttestationCli([
      'verify',
      '--head',
      'a'.repeat(40),
      '--base',
      'b'.repeat(40),
    ]).parseAsync();
    expect(flushStdout()).toContain('status=invalid');
    expect(flushStdout()).toContain(`reason=${V6_REFUSED_CODE}`);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('names the schema a v6 envelope file declares', async () => {
    const envelope = join(tmpRoot, 'x.v6.dsse.json');
    const statement = { predicate: { schemaVersion: 'v6' } };
    writeFileSync(
      envelope,
      JSON.stringify({ payload: Buffer.from(JSON.stringify(statement)).toString('base64') }),
    );
    await buildAttestationCli(['verify', '--envelope', envelope]).parseAsync();
    expect(flushStdout()).toContain(V6_REFUSED_CODE);
    expect(flushStdout()).toContain('declares schema v6');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe('cli-attestation missing subcommand', () => {
  it('exits non-zero when no subcommand is provided', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli([]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit.*["']?[1-9]/);
  });
});

// ── CLI: reviewer-set (AISDLC-722) ────────────────────────────────────────────

describe('reviewer-set', () => {
  it('prints the classification as JSON and fails closed to three outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reviewer-set-'));
    try {
      await buildAttestationCli(['reviewer-set', '--repo-root', dir]).parseAsync();
      const parsed = JSON.parse(flushStdout()) as { set: string; reason: string };
      expect(parsed).toMatchObject({ set: 'three', reason: 'diff-unavailable' });
    } finally {
      removeFixtureDir(dir);
    }
  });
});

describe('reviewer-set (git-backed)', () => {
  it('forwards --base-ref/--head-ref: an ordinary diff is two, a hook diff is three', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reviewer-set-git-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@e.com');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'seed.txt'), 's');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'x');
      git('add', '-A');
      git('commit', '-q', '-m', 'src');
      await buildAttestationCli([
        'reviewer-set',
        '--repo-root',
        dir,
        '--base-ref',
        'main',
        '--head-ref',
        'HEAD',
      ]).parseAsync();
      const first = flushStdout();
      expect(JSON.parse(first)).toMatchObject({ set: 'two' });
      mkdirSync(join(dir, 'ai-sdlc-plugin', 'hooks'), { recursive: true });
      writeFileSync(join(dir, 'ai-sdlc-plugin', 'hooks', 'h.js'), 'x');
      git('add', '-A');
      git('commit', '-q', '-m', 'hook');
      await buildAttestationCli([
        'reviewer-set',
        '--repo-root',
        dir,
        '--base-ref',
        'main',
      ]).parseAsync();
      // The captured stdout accumulates across calls; take only what the second call wrote.
      const all = flushStdout();
      const second = all.startsWith(first) ? all.slice(first.length) : all;
      expect(JSON.parse(second)).toMatchObject({
        set: 'three',
        triggeringPaths: ['ai-sdlc-plugin/hooks/h.js'],
      });
    } finally {
      removeFixtureDir(dir);
    }
  });
});

describe('reviewer-set-window', () => {
  it('prints an empty open window for a fresh artifacts dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reviewer-window-'));
    try {
      await buildAttestationCli(['reviewer-set-window', '--artifacts-dir', dir]).parseAsync();
      expect(JSON.parse(flushStdout())).toMatchObject({ windowOpen: true, prs: 0 });
    } finally {
      removeFixtureDir(dir);
    }
  });
});

// ── CLI: emit-leaf ────────────────────────────────────────────────────────────

describe('emit-leaf — --review-head-sha validation (AISDLC-725)', () => {
  it.each(['', 'not-a-sha', 'a'.repeat(39)])('exits 1 on --review-head-sha %j', async (bad) => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-badhead.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'claude-sonnet-4-6',
        '--review-mode',
        'delta',
        '--review-base-sha',
        'b'.repeat(40),
        '--review-head-sha',
        bad,
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });
});

// ── CLI: emit-leaf reviews-ledger integration (AISDLC-616) ────────────────────

describe('emit-leaf — reviews ledger integration (AISDLC-616)', () => {
  it('appends a ledger record alongside the Merkle leaf, with role/verdict/commitSha/iteration', async () => {
    makeTranscript('aisdlc-616', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-616',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-code.json', {
      approved: false,
      findings: [
        { severity: 'critical', file: 'src/foo.ts', line: 10, message: 'SQL injection' },
        { severity: 'minor', message: 'nit' },
      ],
    });

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'code-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'e'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'claude-sonnet-4-6',
      '--iteration',
      '1',
      '--pr-number',
      '4242',
    ]).parseAsync();

    const { loadReviewLedger } = await import('../attestation/reviews-ledger.js');
    const records = loadReviewLedger('AISDLC-616', tmpRoot);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: 'AISDLC-616',
      prNumber: 4242,
      commitSha: 'e'.repeat(40),
      iteration: 1,
      role: 'code',
      harness: 'claude-code',
      verdict: 'rejected',
    });
    expect(records[0].findings).toHaveLength(2);
    expect(records[0].findings[0]).toMatchObject({ severity: 'critical', area: 'src/foo.ts' });
  });

  it('routes the ledger to the task worktree when run from a Pattern C parent (AISDLC-793)', async () => {
    makeTranscript('aisdlc-616', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-616',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-parent.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    const worktree = join(tmpRoot, '.worktrees', 'aisdlc-616');
    mkdirSync(worktree, { recursive: true });

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'code-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'e'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'claude-sonnet-4-6',
    ]).parseAsync();

    const { loadReviewLedger } = await import('../attestation/reviews-ledger.js');
    expect(existsSync(join(tmpRoot, '.ai-sdlc', 'reviews'))).toBe(false);
    expect(loadReviewLedger('AISDLC-616', worktree)).toHaveLength(1);
  });

  it('defaults iteration to 1 and prNumber to null when omitted', async () => {
    makeTranscript('aisdlc-616', 'test-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-616',
      'test-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-test.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'test-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'f'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
    ]).parseAsync();

    const { loadReviewLedger } = await import('../attestation/reviews-ledger.js');
    const records = loadReviewLedger('AISDLC-616', tmpRoot);
    expect(records).toHaveLength(1);
    expect(records[0].iteration).toBe(1);
    expect(records[0].prNumber).toBeNull();
    expect(records[0].verdict).toBe('approved');
  });

  it('a second review iteration APPENDS a new record — the first-pass record is never overwritten', async () => {
    makeTranscript('aisdlc-616', 'security-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-616',
      'security-reviewer.jsonl',
    );

    const verdictPath1 = writeVerdict('verdict-security-1.json', {
      approved: false,
      findings: [{ severity: 'critical', message: 'hardcoded secret' }],
    });
    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'security-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath1,
      '--head-sha',
      'a'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'opus',
      '--iteration',
      '1',
    ]).parseAsync();

    // Second iteration: transcript content changes (different hash → not an
    // idempotent skip), reviewer now approves.
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', iteration: 2 }) + '\n');
    const verdictPath2 = writeVerdict('verdict-security-2.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'security-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath2,
      '--head-sha',
      'a'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'opus',
      '--iteration',
      '2',
    ]).parseAsync();

    const { loadReviewLedger } = await import('../attestation/reviews-ledger.js');
    const records = loadReviewLedger('AISDLC-616', tmpRoot);
    expect(records).toHaveLength(2);
    expect(records[0].iteration).toBe(1);
    expect(records[0].verdict).toBe('rejected');
    expect(records[0].findings[0].severity).toBe('critical');
    expect(records[1].iteration).toBe(2);
    expect(records[1].verdict).toBe('approved');
  });

  it('skips the ledger append (with a stderr warning) for an unrecognized reviewer name', async () => {
    makeTranscript('aisdlc-616', 'some-custom-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-616',
      'some-custom-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-custom.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-616',
      '--reviewer',
      'some-custom-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'a'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
    ]).parseAsync();

    const { loadReviewLedger } = await import('../attestation/reviews-ledger.js');
    expect(loadReviewLedger('AISDLC-616', tmpRoot)).toEqual([]);
    expect(flushStderr()).toContain('does not map to a canonical reviews-ledger role');
    // The Merkle leaf itself must still be written — reviews-ledger skipping
    // must not regress the pre-existing v6 signing path.
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });
});

// ── CLI: emit-leaf verdictClass detection (AISDLC-568) ─────────────────────────

describe('emit-leaf — verdictClass detection', () => {
  it('the emit-leaf confirmation message includes verdictClass', async () => {
    makeTranscript('aisdlc-568', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-568',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-msg.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-568',
      '--reviewer',
      'code-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'f'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
    ]).parseAsync();

    expect(flushStdout()).toMatch(/verdictClass=self-authored/);
  });
});

describe('emit-leaf — missing-transcript edge case', () => {
  it('exits 1 when transcript file does not exist', async () => {
    const verdictPath = writeVerdict('verdict.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        join(tmpRoot, '.ai-sdlc', 'transcripts', 'nonexistent.jsonl'),
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    const stderrOut = stderrChunks.join('');
    expect(stderrOut).toContain('transcript file not found');
  });

  it('exits 1 when verdict file does not exist', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        join(tmpRoot, '.ai-sdlc', 'verdicts', 'nonexistent-verdict.json'),
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    const stderrOut = stderrChunks.join('');
    expect(stderrOut).toContain('verdict file not found');
  });

  it('exits 1 when verdict file contains invalid JSON', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('bad-verdict.json', 'NOT VALID JSON {{{');

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    const stderrOut = stderrChunks.join('');
    expect(stderrOut).toContain('failed to parse verdict file');
  });
});

// ── CLI: emit-leaf input-validation hardening (AISDLC-391) ────────────────────

describe('emit-leaf — --head-sha shape validation (AISDLC-391 AC-1)', () => {
  /**
   * Build a complete, valid emit-leaf argv with one override slot. The transcript
   * and verdict fixtures are written under `<tmpRoot>/.ai-sdlc/` so they satisfy
   * the AISDLC-391 path-traversal guard — the only knob the test varies is
   * `--head-sha`, isolating the validation under test.
   */
  function buildValidArgsWithHeadSha(headShaValue: string): string[] {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-head-sha-test.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    return [
      'emit-leaf',
      '--task-id',
      'AISDLC-383.8',
      '--reviewer',
      'code-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      headShaValue,
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
    ];
  }

  it('accepts a valid 40-hex-char lowercase SHA', async () => {
    await expect(
      buildAttestationCli(buildValidArgsWithHeadSha('a'.repeat(40))).parseAsync(),
    ).resolves.not.toThrow();
    expect(ledgerRecords(tmpRoot)).toHaveLength(1);
  });

  it('rejects empty string', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgsWithHeadSha('')).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects too-short SHA (39 chars)', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgsWithHeadSha('a'.repeat(39))).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects too-long SHA (41 chars)', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgsWithHeadSha('a'.repeat(41))).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects uppercase hex (git emits lowercase; uppercase indicates caller bug)', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgsWithHeadSha('A'.repeat(40))).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects non-hex characters', async () => {
    let caught: Error | null = null;
    try {
      // 40 chars but with 'z' which isn't hex.
      await buildAttestationCli(buildValidArgsWithHeadSha('z'.repeat(40))).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects multi-line input (newline embedded)', async () => {
    let caught: Error | null = null;
    try {
      // First 39 'a' + newline = 40 chars but newline isn't hex.
      await buildAttestationCli(buildValidArgsWithHeadSha('a'.repeat(39) + '\n')).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--head-sha must be exactly 40 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });
});

describe('emit-leaf — --transcript-path traversal hardening (AISDLC-391 AC-2)', () => {
  it('accepts transcript-path inside .ai-sdlc/', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('v.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    await expect(
      buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync(),
    ).resolves.not.toThrow();

    expect(ledgerRecords(tmpRoot)).toHaveLength(1);
  });

  it('rejects transcript-path outside .ai-sdlc/ (sibling of repo root)', async () => {
    // Write a "transcript" outside .ai-sdlc/ — attacker scenario: path
    // injected via unsanitized bash variable points at /etc/passwd or similar.
    const evilPath = join(tmpRoot, 'evil-transcript.jsonl');
    writeFileSync(evilPath, '{"role":"user","content":"hi"}\n');
    const verdictPath = writeVerdict('v.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        evilPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--transcript-path must resolve inside');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects transcript-path that escapes via ../ segments', async () => {
    // Build a path that LOOKS like it's under .ai-sdlc but ../-escapes out.
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      '..',
      '..',
      'evil-transcript.jsonl',
    );
    // Materialize the file so the existence check (if it ran) wouldn't be the
    // blocker — but the traversal guard runs first.
    writeFileSync(join(tmpRoot, 'evil-transcript.jsonl'), '{"role":"user","content":"hi"}\n');
    const verdictPath = writeVerdict('v.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--transcript-path must resolve inside');
  });

  it('rejects transcript-path at absolute /etc/passwd-style location', async () => {
    const verdictPath = writeVerdict('v.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        '/etc/passwd',
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--transcript-path must resolve inside');
  });
});

describe('emit-leaf — --verdict-path traversal hardening (AISDLC-391 AC-3)', () => {
  it('rejects verdict-path outside .ai-sdlc/', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    // Verdict written directly under tmpRoot (sibling of .ai-sdlc, outside it).
    const evilVerdictPath = join(tmpRoot, 'evil-verdict.json');
    writeFileSync(
      evilVerdictPath,
      JSON.stringify({
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      }),
    );

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        evilVerdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--verdict-path must resolve inside');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects verdict-path that escapes via ../ segments', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    // Path looks like it's under .ai-sdlc but ../-escapes out.
    const verdictPath = join(tmpRoot, '.ai-sdlc', 'verdicts', '..', '..', 'evil-verdict.json');
    writeFileSync(
      join(tmpRoot, 'evil-verdict.json'),
      JSON.stringify({
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      }),
    );

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        'code-reviewer',
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        'a'.repeat(40),
        '--harness',
        'claude-code',
        '--model',
        'sonnet',
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--verdict-path must resolve inside');
  });
});

// ── CLI: emit-leaf harnessTranscriptHash / --nonce (AISDLC-570) ────────────────

describe('emit-leaf — --nonce validation (AISDLC-570)', () => {
  function buildValidArgs(overrides: Record<string, string> = {}): string[] {
    makeTranscript('aisdlc-570', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-570',
      'code-reviewer.jsonl',
    );
    const verdictPath = writeVerdict('verdict-nonce-test.json', {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    const argv: Record<string, string> = {
      '--task-id': 'AISDLC-570',
      '--reviewer': 'code-reviewer',
      '--transcript-path': transcriptPath,
      '--verdict-path': verdictPath,
      '--head-sha': 'a'.repeat(40),
      '--harness': 'claude-code',
      '--model': 'sonnet',
      ...overrides,
    };
    return ['emit-leaf', ...Object.entries(argv).flatMap(([k, v]) => [k, v])];
  }

  it('rejects a malformed --nonce (wrong length)', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgs({ '--nonce': 'a'.repeat(63) })).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--nonce must be exactly 64 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });

  it('rejects a malformed --nonce (non-hex characters)', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(buildValidArgs({ '--nonce': 'z'.repeat(64) })).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toContain('--nonce must be exactly 64 lowercase hex');
    expect(ledgerRecords(tmpRoot)).toHaveLength(0);
  });
});

// ── CLI: generate-nonce / nonce-marker (AISDLC-573) ────────────────────────────
//
// AISDLC-570 shipped the machinery (`generateNonce`, `nonceMarkerLiteral`,
// `emit-leaf --nonce`) but had no CLI surface for the orchestrating dispatch
// to call BEFORE any reviewer subagent is spawned (it doesn't have the
// TypeScript module graph available — it's a bash-driven slash-command body).
// These two subcommands are that surface: `generate-nonce` produces the value,
// `nonce-marker` renders the exact embeddable literal from it.

describe('generate-nonce', () => {
  it('prints a 64-char hex nonce derived from --head-sha', async () => {
    await expect(
      buildAttestationCli(['generate-nonce', '--head-sha', 'a'.repeat(40)]).parseAsync(),
    ).resolves.not.toThrow();

    const output = flushStdout().trim();
    expect(output).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different nonce on every call (random component)', async () => {
    await buildAttestationCli(['generate-nonce', '--head-sha', 'b'.repeat(40)]).parseAsync();
    const first = flushStdout().trim();

    stdoutChunks = [];
    await buildAttestationCli(['generate-nonce', '--head-sha', 'b'.repeat(40)]).parseAsync();
    const second = flushStdout().trim();

    expect(first).not.toBe(second);
  });

  it('rejects a malformed --head-sha', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(['generate-nonce', '--head-sha', 'not-a-sha']).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toMatch(/--head-sha must be exactly 40 lowercase hex/);
  });
});

describe('nonce-marker', () => {
  it('prints the exact nonceMarkerLiteral() string for a valid nonce', async () => {
    const nonce = 'c'.repeat(64);
    await expect(
      buildAttestationCli(['nonce-marker', '--nonce', nonce]).parseAsync(),
    ).resolves.not.toThrow();

    expect(flushStdout().trim()).toBe(nonceMarkerLiteral(nonce));
  });

  it('rejects a malformed --nonce', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(['nonce-marker', '--nonce', 'too-short']).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
    expect(stderrChunks.join('')).toMatch(/--nonce must be exactly 64 lowercase hex/);
  });
});

// ── emit-leaf: leaf-to-reviewer binding (marker role, agent id, sidecar) ─────

describe('emit-leaf — binds the leaf to its own reviewer run', () => {
  async function emit(reviewer: string, extra: string[] = []): Promise<void> {
    makeTranscript('aisdlc-697', reviewer);
    const verdictPath = writeVerdict(`${reviewer}-aisdlc-697.json`, {
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    });
    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-697',
      '--reviewer',
      reviewer,
      '--transcript-path',
      join(tmpRoot, '.ai-sdlc', 'transcripts', 'aisdlc-697', `${reviewer}.jsonl`),
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'e'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
      ...extra,
    ]).parseAsync();
  }

  it('rejects an --agent-id with characters outside the allowed set', async () => {
    await expect(emit('code-reviewer', ['--agent-id', '../../etc/passwd'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(flushStderr()).toMatch(/--agent-id may only contain/);
  });
});

describe('readAgentIdSidecar', () => {
  it('returns the id for a well-formed sidecar and undefined otherwise', () => {
    const dir = join(tmpRoot, 'sidecars');
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'code-reviewer.jsonl');

    expect(readAgentIdSidecar(transcript)).toBeUndefined();

    writeFileSync(join(dir, 'code-reviewer.agent-id'), 'a1b2c3d4e5f60718\n');
    expect(readAgentIdSidecar(transcript)).toBe('a1b2c3d4e5f60718');

    writeFileSync(join(dir, 'code-reviewer.agent-id'), 'two words\n');
    expect(readAgentIdSidecar(transcript)).toBeUndefined();

    writeFileSync(join(dir, 'code-reviewer.agent-id'), '../escape');
    expect(readAgentIdSidecar(transcript)).toBeUndefined();

    writeFileSync(join(dir, 'code-reviewer.agent-id'), 'x'.repeat(300));
    expect(readAgentIdSidecar(transcript)).toBeUndefined();

    expect(readAgentIdSidecar(join(dir, 'code-reviewer.txt'))).toBeUndefined();
  });
});
