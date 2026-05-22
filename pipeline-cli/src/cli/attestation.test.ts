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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLeaf, loadLeaves, type TranscriptLeaf } from '../attestation/merkle.js';
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

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-383.2',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    signedAt: '2026-05-20T19:14:37.561Z',
    ...overrides,
  };
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
    expect(caught?.message).toMatch(/process\.exit.*["']?[1-9]/);
  });
});

// ── CLI: merkle-root ──────────────────────────────────────────────────────────

describe('merkle-root — no leaves', () => {
  it('prints leaf count 0 in text mode', async () => {
    await buildAttestationCli(['merkle-root']).parseAsync();
    const out = flushStdout();
    expect(out).toContain('leaf count: 0');
    expect(out).toContain('(no leaves)');
  });

  it('emits JSON with root null and leafCount 0', async () => {
    await buildAttestationCli(['merkle-root', '--json']).parseAsync();
    const parsed = JSON.parse(flushStdout()) as { root: null; leafCount: number };
    expect(parsed.root).toBeNull();
    expect(parsed.leafCount).toBe(0);
  });
});

describe('merkle-root — with leaves', () => {
  it('prints leaf count and root hash in text mode', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    appendLeaf(makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }), tmpRoot);
    await buildAttestationCli(['merkle-root']).parseAsync();
    const out = flushStdout();
    expect(out).toContain('leaf count: 2');
    expect(out).toMatch(/root:\s+[0-9a-f]{64}/);
  });

  it('emits JSON with correct leaf count and 64-char root', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    await buildAttestationCli(['merkle-root', '--json']).parseAsync();
    const parsed = JSON.parse(flushStdout()) as { root: string; leafCount: number };
    expect(parsed.leafCount).toBe(1);
    expect(parsed.root).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── CLI: merkle-proof ─────────────────────────────────────────────────────────

describe('merkle-proof', () => {
  it('prints proof for leaf 0 in text mode', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    appendLeaf(makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }), tmpRoot);
    await buildAttestationCli(['merkle-proof', '0']).parseAsync();
    const out = flushStdout();
    expect(out).toContain('leaf index: 0');
    expect(out).toContain('root:');
    expect(out).toContain('proof');
  });

  it('emits JSON with leafIndex, leafHash, root, proof', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    appendLeaf(makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }), tmpRoot);
    await buildAttestationCli(['merkle-proof', '0', '--json']).parseAsync();
    const parsed = JSON.parse(flushStdout()) as {
      leafIndex: number;
      leafHash: string;
      root: string;
      proof: string[];
    };
    expect(parsed.leafIndex).toBe(0);
    expect(parsed.leafHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.root).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(parsed.proof)).toBe(true);
  });

  it('emits verified=true when --verify flag is set', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    await buildAttestationCli(['merkle-proof', '0', '--verify', '--json']).parseAsync();
    const parsed = JSON.parse(flushStdout()) as { verified: boolean };
    expect(parsed.verified).toBe(true);
  });

  it('single-leaf tree: proof is empty array', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    await buildAttestationCli(['merkle-proof', '0', '--json']).parseAsync();
    const parsed = JSON.parse(flushStdout()) as { proof: string[] };
    expect(parsed.proof).toEqual([]);
  });

  it('prints "(empty)" note in text mode for single-leaf tree', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    await buildAttestationCli(['merkle-proof', '0']).parseAsync();
    expect(flushStdout()).toContain('(empty');
  });

  it('exits with error when no leaves exist', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli(['merkle-proof', '0']).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });

  it('exits with error when index is out of range', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0 }), tmpRoot);
    let caught: Error | null = null;
    try {
      await buildAttestationCli(['merkle-proof', '99']).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });
});

// ── CLI: sign-v6 ──────────────────────────────────────────────────────────────

describe('sign-v6', () => {
  let keyPath: string;

  beforeEach(() => {
    // Generate a fresh ed25519 keypair for each test.
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    keyPath = join(tmpRoot, 'test-key.pem');
    writeFileSync(keyPath, pem, { mode: 0o600 });
  });

  it('writes a v6 envelope and prints the output path', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' }), tmpRoot);
    appendLeaf(
      makeLeaf({ leafIndex: 1, taskId: 'AISDLC-383.3', reviewerName: 'test-reviewer' }),
      tmpRoot,
    );

    await expect(
      buildAttestationCli([
        'sign-v6',
        '--task-id',
        'AISDLC-383.3',
        '--head-sha',
        'a'.repeat(40),
        '--key-path',
        keyPath,
      ]).parseAsync(),
    ).resolves.not.toThrow();

    const out = flushStdout();
    expect(out).toContain('.v6.dsse.json');
  });

  it('exits 1 when no leaves match task-id', async () => {
    // No leaves appended.
    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'sign-v6',
        '--task-id',
        'AISDLC-383.3',
        '--head-sha',
        'a'.repeat(40),
        '--key-path',
        keyPath,
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });

  it('exits 1 when key file does not exist', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' }), tmpRoot);

    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'sign-v6',
        '--task-id',
        'AISDLC-383.3',
        '--head-sha',
        'a'.repeat(40),
        '--key-path',
        join(tmpRoot, 'nonexistent.pem'),
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });
});

// ── CLI: emit-leaf ────────────────────────────────────────────────────────────

describe('emit-leaf — happy path', () => {
  it('appends one leaf for a single reviewer run', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = join(tmpRoot, 'verdict-code-reviewer.json');
    writeFileSync(
      verdictPath,
      JSON.stringify({
        approved: true,
        findings: { critical: 0, major: 0, minor: 1, suggestion: 2 },
      }),
    );

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
        'claude-sonnet-4-6',
      ]).parseAsync(),
    ).resolves.not.toThrow();

    const leaves = loadLeaves(tmpRoot);
    expect(leaves).toHaveLength(1);
    const leaf = leaves[0];
    expect(leaf.leafIndex).toBe(0);
    expect(leaf.taskId).toBe('AISDLC-383.8');
    expect(leaf.reviewerName).toBe('code-reviewer');
    expect(leaf.harness).toBe('claude-code');
    expect(leaf.model).toBe('claude-sonnet-4-6');
    expect(leaf.verdictApproved).toBe(true);
    expect(leaf.findings).toEqual({ critical: 0, major: 0, minor: 1, suggestion: 2 });
    expect(leaf.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(leaf.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(leaf.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('transcriptHash is SHA-256 of the transcript file content', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = join(tmpRoot, 'verdict.json');
    writeFileSync(
      verdictPath,
      JSON.stringify({
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      }),
    );

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

    const expectedHash = createHash('sha256').update(readFileSync(transcriptPath)).digest('hex');
    const leaves = loadLeaves(tmpRoot);
    expect(leaves[0].transcriptHash).toBe(expectedHash);
  });

  it('sets verdictApproved=false for CHANGES_REQUESTED verdict', async () => {
    makeTranscript('aisdlc-383.8', 'security-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'security-reviewer.jsonl',
    );
    const verdictPath = join(tmpRoot, 'verdict-security.json');
    writeFileSync(
      verdictPath,
      JSON.stringify({
        approved: false,
        findings: { critical: 1, major: 0, minor: 0, suggestion: 0 },
      }),
    );

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-383.8',
      '--reviewer',
      'security-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'b'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'claude-opus-4-5',
    ]).parseAsync();

    const leaves = loadLeaves(tmpRoot);
    expect(leaves[0].verdictApproved).toBe(false);
    expect(leaves[0].findings.critical).toBe(1);
  });

  it('supports verdictApproved key in verdict JSON', async () => {
    makeTranscript('aisdlc-383.8', 'test-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'test-reviewer.jsonl',
    );
    const verdictPath = join(tmpRoot, 'verdict-test.json');
    writeFileSync(
      verdictPath,
      JSON.stringify({
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 1 },
      }),
    );

    await buildAttestationCli([
      'emit-leaf',
      '--task-id',
      'AISDLC-383.8',
      '--reviewer',
      'test-reviewer',
      '--transcript-path',
      transcriptPath,
      '--verdict-path',
      verdictPath,
      '--head-sha',
      'c'.repeat(40),
      '--harness',
      'claude-code',
      '--model',
      'sonnet',
    ]).parseAsync();

    const leaves = loadLeaves(tmpRoot);
    expect(leaves[0].verdictApproved).toBe(true);
  });
});

describe('emit-leaf — leafIndex monotonicity across multiple reviewers', () => {
  it('three sequential calls produce leafIndex 0, 1, 2', async () => {
    const reviewers = ['code-reviewer', 'test-reviewer', 'security-reviewer'] as const;
    for (const reviewer of reviewers) {
      makeTranscript('aisdlc-383.8', reviewer);
      const transcriptPath = join(
        tmpRoot,
        '.ai-sdlc',
        'transcripts',
        'aisdlc-383.8',
        `${reviewer}.jsonl`,
      );
      const verdictPath = join(tmpRoot, `verdict-${reviewer}.json`);
      writeFileSync(
        verdictPath,
        JSON.stringify({
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        }),
      );

      // Reset stdout for next call.
      stdoutChunks.length = 0;
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        'AISDLC-383.8',
        '--reviewer',
        reviewer,
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
    }

    const leaves = loadLeaves(tmpRoot);
    expect(leaves).toHaveLength(3);
    expect(leaves[0].leafIndex).toBe(0);
    expect(leaves[1].leafIndex).toBe(1);
    expect(leaves[2].leafIndex).toBe(2);
    expect(leaves[0].reviewerName).toBe('code-reviewer');
    expect(leaves[1].reviewerName).toBe('test-reviewer');
    expect(leaves[2].reviewerName).toBe('security-reviewer');
  });

  it('leafIndex continues sequentially across multiple task runs', async () => {
    // Simulate two different task runs, 2 reviewers each.
    const tasks = [
      { taskId: 'AISDLC-383.8', reviewer: 'code-reviewer' },
      { taskId: 'AISDLC-383.8', reviewer: 'test-reviewer' },
      { taskId: 'AISDLC-400', reviewer: 'code-reviewer' },
      { taskId: 'AISDLC-400', reviewer: 'security-reviewer' },
    ];

    for (const { taskId, reviewer } of tasks) {
      const taskIdLower = taskId.toLowerCase();
      makeTranscript(taskIdLower, reviewer);
      const transcriptPath = join(
        tmpRoot,
        '.ai-sdlc',
        'transcripts',
        taskIdLower,
        `${reviewer}.jsonl`,
      );
      const verdictPath = join(tmpRoot, `verdict-${taskIdLower}-${reviewer}.json`);
      writeFileSync(
        verdictPath,
        JSON.stringify({
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        }),
      );

      stdoutChunks.length = 0;
      await buildAttestationCli([
        'emit-leaf',
        '--task-id',
        taskId,
        '--reviewer',
        reviewer,
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
    }

    const leaves = loadLeaves(tmpRoot);
    expect(leaves).toHaveLength(4);
    // leafIndex must be strictly monotonic regardless of taskId.
    expect(leaves.map((l) => l.leafIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe('emit-leaf — idempotent re-emission', () => {
  it('skips on second call with same (taskId, reviewerName, transcriptHash)', async () => {
    makeTranscript('aisdlc-383.8', 'code-reviewer');
    const transcriptPath = join(
      tmpRoot,
      '.ai-sdlc',
      'transcripts',
      'aisdlc-383.8',
      'code-reviewer.jsonl',
    );
    const verdictPath = join(tmpRoot, 'verdict.json');
    writeFileSync(
      verdictPath,
      JSON.stringify({
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      }),
    );

    const args = [
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
    ];

    // First call — should append.
    await buildAttestationCli(args).parseAsync();
    expect(loadLeaves(tmpRoot)).toHaveLength(1);

    // Second call — should skip (idempotent).
    stdoutChunks.length = 0;
    await buildAttestationCli(args).parseAsync();
    expect(loadLeaves(tmpRoot)).toHaveLength(1);
    expect(flushStdout()).toContain('skipping (idempotent)');
  });
});

describe('emit-leaf — missing-transcript edge case', () => {
  it('exits 1 when transcript file does not exist', async () => {
    const verdictPath = join(tmpRoot, 'verdict.json');
    writeFileSync(
      verdictPath,
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
        join(tmpRoot, 'nonexistent.jsonl'),
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
        join(tmpRoot, 'nonexistent-verdict.json'),
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
    const verdictPath = join(tmpRoot, 'bad-verdict.json');
    writeFileSync(verdictPath, 'NOT VALID JSON {{{');

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

// ── CLI: inspect-v6 ───────────────────────────────────────────────────────────

describe('inspect-v6', () => {
  let keyPath: string;

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    keyPath = join(tmpRoot, 'inspect-test-key.pem');
    writeFileSync(keyPath, pem, { mode: 0o600 });
  });

  it('pretty-prints a v6 envelope in text mode', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' }), tmpRoot);

    // Sign first.
    await buildAttestationCli([
      'sign-v6',
      '--task-id',
      'AISDLC-383.3',
      '--head-sha',
      'b'.repeat(40),
      '--key-path',
      keyPath,
    ]).parseAsync();

    const envelopePath = join(
      tmpRoot,
      '.ai-sdlc',
      'attestations',
      `${'b'.repeat(40)}.v6.dsse.json`,
    );

    // Clear stdout buffer, then inspect.
    stdoutChunks.length = 0;
    await buildAttestationCli(['inspect-v6', envelopePath]).parseAsync();

    const out = flushStdout();
    expect(out).toContain('Schema version : v6');
    expect(out).toContain('Leaf count     : 1');
  });

  it('emits JSON when --json flag is set', async () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' }), tmpRoot);

    await buildAttestationCli([
      'sign-v6',
      '--task-id',
      'AISDLC-383.3',
      '--head-sha',
      'c'.repeat(40),
      '--key-path',
      keyPath,
    ]).parseAsync();

    const envelopePath = join(
      tmpRoot,
      '.ai-sdlc',
      'attestations',
      `${'c'.repeat(40)}.v6.dsse.json`,
    );

    stdoutChunks.length = 0;
    await buildAttestationCli(['inspect-v6', envelopePath, '--json']).parseAsync();

    const parsed = JSON.parse(flushStdout()) as { schemaVersion: string };
    expect(parsed.schemaVersion).toBe('v6');
  });

  it('exits 1 when envelope file does not exist', async () => {
    let caught: Error | null = null;
    try {
      await buildAttestationCli([
        'inspect-v6',
        join(tmpRoot, 'nonexistent.v6.dsse.json'),
      ]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });

  it('exits 1 when envelope has wrong schemaVersion', async () => {
    const fakePath = join(tmpRoot, 'bad.v6.dsse.json');
    writeFileSync(fakePath, JSON.stringify({ schemaVersion: 'v5' }), 'utf8');

    let caught: Error | null = null;
    try {
      await buildAttestationCli(['inspect-v6', fakePath]).parseAsync();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/process\.exit\(1\)/);
  });
});
