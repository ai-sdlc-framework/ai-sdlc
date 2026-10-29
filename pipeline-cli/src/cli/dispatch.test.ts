/**
 * Tests for `cli-dispatch` — the operator CLI surface for the Dispatch Board
 * (RFC-0041 §4.4, AISDLC-377.1).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computePatchId } from '../attestation/patch-id.js';
import { dispatchEnsureBoardDirs, dispatchWriteManifest } from '../index.js';
import type { DispatchManifest } from '../index.js';

import { approvalEnvelopeMatches, findTaskFile, parseArgv, runDispatchCli } from './dispatch.js';

describe('parseArgv', () => {
  it('parses subcommand + key/value flag pairs', () => {
    const { subcommand, flags } = parseArgv([
      'claim',
      '--worker-kind',
      'in-session-agent',
      '--board-dir',
      '/tmp/x',
    ]);
    expect(subcommand).toBe('claim');
    expect(flags).toEqual({
      'worker-kind': 'in-session-agent',
      'board-dir': '/tmp/x',
    });
  });

  it('treats bare flags as true', () => {
    const { flags } = parseArgv(['collect-verdicts', '--include-failed']);
    expect(flags['include-failed']).toBe('true');
  });

  it('handles empty argv', () => {
    expect(parseArgv([])).toEqual({ subcommand: '', flags: {} });
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive each subcommand and assert on the JSON it prints
// to stdout + the on-disk side effects.
// ---------------------------------------------------------------------------

function mkBoard(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'dispatch-cli-')), 'dispatch');
}

function mkManifest(taskId: string, overrides: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`,
      verifyCommands: ['pnpm build'],
    },
    ...overrides,
  };
}

interface CapturedStdout {
  lines: string[];
  raw: string;
}

function captureStdout(fn: () => Promise<number>): Promise<{
  exit: number;
  captured: CapturedStdout;
}> {
  const lines: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write);
  return fn().then((exit) => {
    writeSpy.mockRestore();
    return { exit, captured: { lines, raw: lines.join('') } };
  });
}

function readLastJson(out: CapturedStdout): unknown {
  const trimmed = out.raw.trim().split('\n').filter(Boolean);
  return JSON.parse(trimmed[trimmed.length - 1]);
}

describe('runDispatchCli', () => {
  let boardDir: string;

  beforeEach(() => {
    boardDir = mkBoard();
    dispatchEnsureBoardDirs(boardDir);
  });
  afterEach(() => {
    try {
      rmSync(path.dirname(boardDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('close-superseded rejects a non-numeric PR before touching GitHub (DEC-0266)', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli(['close-superseded', 'abc', '--board-dir', boardDir]),
    );
    expect(exit).toBe(2);
  });

  it('peek returns zero counts on a fresh board', async () => {
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['peek', '--board-dir', boardDir]),
    );
    expect(exit).toBe(0);
    expect(readLastJson(captured)).toEqual({
      queued: 0,
      inflight: 0,
      done: 0,
      failed: 0,
    });
  });

  it('claim returns claimed:false when queue is empty', async () => {
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']),
    );
    expect(exit).toBe(0);
    expect(readLastJson(captured)).toEqual({ claimed: false });
  });

  it('claim requires --worker-kind', async () => {
    const { exit } = await captureStdout(() => runDispatchCli(['claim', '--board-dir', boardDir]));
    expect(exit).toBe(2);
  });

  it('claim rejects invalid worker kinds', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'not-a-kind']),
    );
    expect(exit).toBe(2);
  });

  it('claim succeeds and prints the manifest', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2000'));
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']),
    );
    expect(exit).toBe(0);
    const result = readLastJson(captured) as {
      claimed: boolean;
      manifest: DispatchManifest;
    };
    expect(result.claimed).toBe(true);
    expect(result.manifest.taskId).toBe('AISDLC-2000');
  });

  it('write-verdict routes success to done/', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2001'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    const { exit } = await captureStdout(() =>
      runDispatchCli([
        'write-verdict',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-2001',
        '--outcome',
        'success',
        '--worker-id',
        'w1',
        '--worker-kind',
        'in-session-agent',
        '--commit-sha',
        'def5678',
        '--verifications',
        JSON.stringify({ build: 'passed', test: 'passed' }),
        '--acceptance-criteria-met',
        '[1,2,3]',
        '--duration-ms',
        '12345',
      ]),
    );
    expect(exit).toBe(0);
    const verdict = JSON.parse(
      readFileSync(path.join(boardDir, 'done', 'AISDLC-2001.verdict.json'), 'utf-8'),
    );
    expect(verdict.outcome).toBe('success');
    expect(verdict.commitSha).toBe('def5678');
    expect(verdict.verifications).toEqual({ build: 'passed', test: 'passed' });
    expect(verdict.acceptanceCriteriaMet).toEqual([1, 2, 3]);
    expect(verdict.durationMs).toBe(12345);
  });

  it('write-verdict routes quota-exhausted to failed/ with retryAfter', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2002'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'write-verdict',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2002',
      '--outcome',
      'quota-exhausted',
      '--worker-id',
      'w1',
      '--cause',
      'quota-exhausted',
      '--retry-after',
      '600',
      '--notes',
      'simulated 429',
    ]);
    const diag = JSON.parse(
      readFileSync(path.join(boardDir, 'failed', 'AISDLC-2002.verdict.json'), 'utf-8'),
    );
    expect(diag.outcome).toBe('quota-exhausted');
    expect(diag.retryAfter).toBe(600);
    expect(diag.notes).toBe('simulated 429');
  });

  it('collect-verdicts prints done verdicts as JSON array', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2010'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'write-verdict',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2010',
      '--outcome',
      'success',
      '--worker-id',
      'w1',
    ]);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['collect-verdicts', '--board-dir', boardDir]),
    );
    const verdicts = readLastJson(captured) as unknown[];
    expect(Array.isArray(verdicts)).toBe(true);
    expect((verdicts[0] as { taskId: string }).taskId).toBe('AISDLC-2010');
  });

  it('remove-verdict idempotent for missing files', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli(['remove-verdict', '--board-dir', boardDir, '--task-id', 'AISDLC-9992']),
    );
    expect(exit).toBe(0);
  });

  it('heartbeat writes inflight state file', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2020'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'heartbeat',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2020',
      '--worker-id',
      'w1',
      '--worker-kind',
      'in-session-agent',
      '--current-step',
      'pnpm test',
      '--pid',
      '99999',
    ]);
    const state = JSON.parse(
      readFileSync(path.join(boardDir, 'inflight', 'AISDLC-2020.state.json'), 'utf-8'),
    );
    expect(state.currentStep).toBe('pnpm test');
    expect(state.pid).toBe(99999);
  });

  it('record-agent persists the recovery key; sessions reads it; complete marks it done (AISDLC-564)', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2040'));
    await runDispatchCli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'w1',
    ]);
    const rec = await captureStdout(() =>
      runDispatchCli([
        'record-agent',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-2040',
        '--agent-id',
        'abc123',
        '--worktree',
        '/wt/aisdlc-2040',
        '--transcript',
        '/t/agent-abc123.jsonl',
      ]),
    );
    expect(rec.exit).toBe(0);
    const listed = await captureStdout(() =>
      runDispatchCli(['sessions', '--board-dir', boardDir, '--json']),
    );
    expect(JSON.parse(listed.captured.raw)[0]).toMatchObject({
      taskId: 'AISDLC-2040',
      agentId: 'abc123',
      worktreePath: '/wt/aisdlc-2040',
      status: 'in-progress',
    });
    const text = await captureStdout(() => runDispatchCli(['sessions', '--board-dir', boardDir]));
    expect(text.captured.raw).toContain('SendMessage abc123');
    const done = await captureStdout(() =>
      runDispatchCli([
        'complete',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-2040',
        '--outcome',
        'success',
        '--worker',
        'w1',
      ]),
    );
    expect(done.exit).toBe(0);
    const after = await captureStdout(() =>
      runDispatchCli(['sessions', '--board-dir', boardDir, '--json']),
    );
    expect(JSON.parse(after.captured.raw)[0].status).toBe('done');
  });

  it('record-agent rejects a bad task id; sessions reports empty', async () => {
    const bad = await captureStdout(() =>
      runDispatchCli([
        'record-agent',
        '--board-dir',
        boardDir,
        '--task-id',
        'nope',
        '--agent-id',
        'a',
        '--worktree',
        '/w',
      ]),
    );
    expect(bad.exit).toBe(2);
    const none = await captureStdout(() => runDispatchCli(['sessions', '--board-dir', boardDir]));
    expect(none.captured.raw).toContain('no session records');
  });

  it('record-agent ignores a bare --transcript flag instead of storing "true" (AISDLC-564)', async () => {
    const rec = await captureStdout(() =>
      runDispatchCli([
        'record-agent',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-2090',
        '--agent-id',
        'a1',
        '--worktree',
        '/w',
        '--transcript',
      ]),
    );
    expect(rec.exit).toBe(0);
    const listed = await captureStdout(() =>
      runDispatchCli(['sessions', '--board-dir', boardDir, '--json']),
    );
    const [session] = JSON.parse(listed.captured.raw) as Array<Record<string, unknown>>;
    expect(session.agentId).toBe('a1');
    expect(session.transcriptPath).toBeUndefined();
  });

  it('sweep returns no reaped IDs when nothing is stale', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2030'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'heartbeat',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2030',
      '--worker-id',
      'w1',
      '--worker-kind',
      'in-session-agent',
    ]);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['sweep', '--board-dir', boardDir, '--stale-ms', '60000']),
    );
    expect(readLastJson(captured)).toEqual({ reapedTaskIds: [] });
  });

  it('release moves inflight back to queue', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2040'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['release', '--board-dir', boardDir, '--task-id', 'AISDLC-2040']),
    );
    expect(readLastJson(captured)).toEqual({ released: true });
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-2040.dispatch.json'))).toBe(true);
  });

  it('write-manifest reads a JSON file and queues it', async () => {
    const tmpFile = path.join(boardDir, '..', 'manifest.json');
    writeFileSync(tmpFile, JSON.stringify(mkManifest('AISDLC-2050')), 'utf-8');
    const { exit } = await captureStdout(() =>
      runDispatchCli(['write-manifest', '--board-dir', boardDir, '--json', tmpFile]),
    );
    expect(exit).toBe(0);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-2050.dispatch.json'))).toBe(true);
  });

  it('write-manifest --branch replaces a queued branch and refuses an inflight task (AISDLC-901)', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2060'));
    const { exit } = await captureStdout(() =>
      runDispatchCli([
        'write-manifest',
        'AISDLC-2060',
        '--branch',
        'ai-sdlc/aisdlc-2060-long-slug',
        '--board-dir',
        boardDir,
      ]),
    );
    expect(exit).toBe(0);
    const queued = JSON.parse(
      readFileSync(path.join(boardDir, 'queue', 'AISDLC-2060.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(queued.branch).toBe('ai-sdlc/aisdlc-2060-long-slug');
    expect(queued.baseSha).toBe(mkManifest('AISDLC-2060').baseSha);

    renameSync(
      path.join(boardDir, 'queue', 'AISDLC-2060.dispatch.json'),
      path.join(boardDir, 'inflight', 'AISDLC-2060.dispatch.json'),
    );
    const refused = await captureStdout(() =>
      runDispatchCli([
        'write-manifest',
        '--task-id',
        'AISDLC-2060',
        '--branch',
        'x',
        '--board-dir',
        boardDir,
      ]),
    );
    expect(refused.exit).toBe(1);
    const missing = await captureStdout(() =>
      runDispatchCli(['write-manifest', '--branch', 'x', '--board-dir', boardDir]),
    );
    expect(missing.exit).toBe(2);
  });

  it('help subcommand prints usage', async () => {
    const { exit, captured } = await captureStdout(() => runDispatchCli(['help']));
    expect(exit).toBe(0);
    expect(captured.raw).toMatch(/cli-dispatch/);
    expect(captured.raw).toMatch(/Subcommands/);
  });

  it('help mentions Phase 1.5 iteration subcommands', async () => {
    const { captured } = await captureStdout(() => runDispatchCli(['help']));
    expect(captured.raw).toMatch(/write-resume-signal/);
    expect(captured.raw).toMatch(/probe-iteration-budget/);
    expect(captured.raw).toMatch(/write-iteration-exhausted/);
  });

  it('unknown subcommand exits 2', async () => {
    const { exit } = await captureStdout(() => runDispatchCli(['no-such-cmd']));
    expect(exit).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Phase 1.5 (AISDLC-377.2) — iteration subcommands
  // -------------------------------------------------------------------------

  describe('write-resume-signal / read-resume-signal / remove-resume-signal', () => {
    it('writes a resume signal next to an inflight manifest', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4000', { iterationsAttempted: 1, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'write-resume-signal',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-4000',
          '--feedback',
          'reviewer wants edge-case coverage on path P',
          '--prior-iteration',
          '1',
          '--triggered-by',
          'conductor-test',
        ]),
      );
      expect(exit).toBe(0);
      const result = readLastJson(captured) as { ok: boolean; path: string };
      expect(result.ok).toBe(true);
      expect(result.path).toMatch(/AISDLC-4000\.resume\.json$/);
    });

    it('refuses when iteration budget already exhausted (exit 1, {ok:false,error})', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4001', { iterationsAttempted: 2, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'write-resume-signal',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-4001',
          '--feedback',
          'fb',
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/iteration budget exhausted/i);
    });

    it('refuses when no inflight manifest exists', async () => {
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'write-resume-signal',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-9992',
          '--feedback',
          'fb',
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { ok: boolean; error: string };
      expect(result.error).toMatch(/no inflight manifest/i);
    });

    it('read-resume-signal returns {present:false} when no signal exists', async () => {
      const { captured } = await captureStdout(() =>
        runDispatchCli(['read-resume-signal', '--board-dir', boardDir, '--task-id', 'AISDLC-9992']),
      );
      expect(readLastJson(captured)).toEqual({ present: false });
    });

    it('read-resume-signal returns the parsed signal when present', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4002', { iterationsAttempted: 1, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      await runDispatchCli([
        'write-resume-signal',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-4002',
        '--feedback',
        'fb',
        '--prior-iteration',
        '1',
      ]);
      const { captured } = await captureStdout(() =>
        runDispatchCli(['read-resume-signal', '--board-dir', boardDir, '--task-id', 'AISDLC-4002']),
      );
      const result = readLastJson(captured) as {
        present: boolean;
        signal: { feedback: string; priorIteration: number };
      };
      expect(result.present).toBe(true);
      expect(result.signal.feedback).toBe('fb');
      expect(result.signal.priorIteration).toBe(1);
    });

    it('remove-resume-signal is idempotent on missing files', async () => {
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'remove-resume-signal',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-9992',
        ]),
      );
      expect(exit).toBe(0);
      expect(readLastJson(captured)).toEqual({ ok: true });
    });

    it('remove-resume-signal deletes an existing signal', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4003', { iterationsAttempted: 1, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      await runDispatchCli([
        'write-resume-signal',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-4003',
        '--feedback',
        'fb',
      ]);
      await runDispatchCli([
        'remove-resume-signal',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-4003',
      ]);
      expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-4003.resume.json'))).toBe(false);
    });
  });

  describe('probe-iteration-budget', () => {
    it('reports defaults for a v1.0 manifest with no iteration fields', async () => {
      dispatchWriteManifest(boardDir, mkManifest('AISDLC-4100'));
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      const { captured } = await captureStdout(() =>
        runDispatchCli([
          'probe-iteration-budget',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-4100',
        ]),
      );
      const result = readLastJson(captured) as {
        attempts: number;
        budget: number;
        exhausted: boolean;
        hasManifest: boolean;
      };
      expect(result.attempts).toBe(0);
      expect(result.budget).toBe(2); // DEFAULT_ITERATION_BUDGET
      expect(result.exhausted).toBe(false);
      expect(result.hasManifest).toBe(true);
    });

    it('reports exhausted=true when attempts >= budget', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4101', { iterationsAttempted: 2, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      const { captured } = await captureStdout(() =>
        runDispatchCli([
          'probe-iteration-budget',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-4101',
        ]),
      );
      const result = readLastJson(captured) as { exhausted: boolean };
      expect(result.exhausted).toBe(true);
    });

    it('reports hasManifest=false when no inflight manifest exists', async () => {
      const { captured } = await captureStdout(() =>
        runDispatchCli([
          'probe-iteration-budget',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-9991',
        ]),
      );
      const result = readLastJson(captured) as { hasManifest: boolean };
      expect(result.hasManifest).toBe(false);
    });
  });

  describe('write-iteration-exhausted', () => {
    it('writes an iteration-exhausted diagnostic to failed/', async () => {
      dispatchWriteManifest(
        boardDir,
        mkManifest('AISDLC-4200', { iterationsAttempted: 2, iterationBudget: 2 }),
      );
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      const { exit } = await captureStdout(() =>
        runDispatchCli([
          'write-iteration-exhausted',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-4200',
          '--iterations-attempted',
          '2',
          '--iteration-budget',
          '2',
          '--worker-kind',
          'in-session-agent',
        ]),
      );
      expect(exit).toBe(0);
      const diag = JSON.parse(
        readFileSync(path.join(boardDir, 'failed', 'AISDLC-4200.diagnostic.json'), 'utf-8'),
      );
      expect(diag.outcome).toBe('iteration-exhausted');
      expect(diag.cause).toBe('iteration-budget-exhausted');
      expect(diag.iterationsAttempted).toBe(2);
      expect(diag.workerKind).toBe('in-session-agent');
    });
  });

  describe('write-verdict --iterations-attempted + --session-id', () => {
    it('threads iterationsAttempted + sessionId onto the verdict JSON', async () => {
      dispatchWriteManifest(boardDir, mkManifest('AISDLC-4300'));
      await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
      await runDispatchCli([
        'write-verdict',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-4300',
        '--outcome',
        'success',
        '--worker-id',
        'w1',
        '--iterations-attempted',
        '2',
        '--session-id',
        'abc-uuid',
      ]);
      const verdict = JSON.parse(
        readFileSync(path.join(boardDir, 'done', 'AISDLC-4300.verdict.json'), 'utf-8'),
      );
      expect(verdict.iterationsAttempted).toBe(2);
      expect(verdict.sessionId).toBe('abc-uuid');
    });
  });

  // -------------------------------------------------------------------------
  // Pattern X (AISDLC-396) — bg-agent-request coordination subcommands
  // -------------------------------------------------------------------------

  describe('dispatch-bg-agent / list-bg-agent-requests / remove-bg-agent-request', () => {
    /**
     * Write a manifest to inflight/ directly (skipping the claim/queue
     * dance) — Pattern X tests want a pre-claimed manifest to dispatch
     * against without exercising the dispatch-board atomic-claim path.
     */
    function writeManifestToInflight(taskId: string): string {
      const manifest = mkManifest(taskId);
      const inflightDir = path.join(boardDir, 'inflight');
      const target = path.join(inflightDir, `${taskId}.dispatch.json`);
      writeFileSync(target, JSON.stringify(manifest, null, 2), 'utf-8');
      return target;
    }

    it('writes a bg-agent-request to bg-agent-request/<task>.request.json', async () => {
      const manifestPath = writeManifestToInflight('AISDLC-5000');
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDir,
          '--manifest-path',
          manifestPath,
          '--requested-at',
          '2026-05-22T10:00:00.000Z',
          '--requested-by',
          'conductor-test',
        ]),
      );
      expect(exit).toBe(0);
      const result = readLastJson(captured) as { ok: boolean; path: string; taskId: string };
      expect(result.ok).toBe(true);
      expect(result.taskId).toBe('AISDLC-5000');
      expect(result.path).toMatch(/bg-agent-request[/\\]AISDLC-5000\.request\.json$/);
      const request = JSON.parse(readFileSync(result.path, 'utf-8'));
      expect(request.schemaVersion).toBe('v1');
      expect(request.taskId).toBe('AISDLC-5000');
      expect(request.subagentType).toBe('developer');
      expect(request.worktree).toBe('.worktrees/aisdlc-5000');
      expect(request.requestedBy).toBe('conductor-test');
      expect(request.requestedAt).toBe('2026-05-22T10:00:00.000Z');
      expect(request.status).toBe('pending');
      expect(typeof request.prompt).toBe('string');
      expect(request.prompt).toMatch(/AISDLC-5000/);
    });

    it('refuses when the in-flight cap is already saturated (AC-5)', async () => {
      // Pre-populate inflight/ with 4 manifests (the default cap).
      writeManifestToInflight('AISDLC-5100');
      writeManifestToInflight('AISDLC-5101');
      writeManifestToInflight('AISDLC-5102');
      writeManifestToInflight('AISDLC-5103');
      // The 5th task — its manifest is the one we'd be dispatching for.
      // Conductor wrote it to inflight/ before calling dispatch-bg-agent.
      const manifestPath = writeManifestToInflight('AISDLC-5104');
      // 5 in inflight; cap = 4; subtracting the current task gives 4 OTHER
      // in-flight, which is >= cap → refuse.
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDir,
          '--manifest-path',
          manifestPath,
          '--max-sessions',
          '4',
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as {
        ok: boolean;
        error: string;
        inFlight: number;
        maxSessions: number;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/in-flight count .* already meets cap/);
      expect(result.inFlight).toBe(4);
      expect(result.maxSessions).toBe(4);
    });

    it('honors --max-sessions to override the default cap', async () => {
      writeManifestToInflight('AISDLC-5200');
      writeManifestToInflight('AISDLC-5201');
      const manifestPath = writeManifestToInflight('AISDLC-5202');
      // 3 in inflight, cap = 1 → 2 other in-flight >= 1 → refuse.
      const { exit } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDir,
          '--manifest-path',
          manifestPath,
          '--max-sessions',
          '1',
        ]),
      );
      expect(exit).toBe(1);
    });

    it('refuses duplicate request when one already exists for the task', async () => {
      const manifestPath = writeManifestToInflight('AISDLC-5300');
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        manifestPath,
      ]);
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDir,
          '--manifest-path',
          manifestPath,
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already exists/);
    });

    it('list-bg-agent-requests returns oldest-first by requestedAt', async () => {
      const m1 = writeManifestToInflight('AISDLC-5400');
      const m2 = writeManifestToInflight('AISDLC-5401');
      const m3 = writeManifestToInflight('AISDLC-5402');
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        m1,
        '--requested-at',
        '2026-05-22T10:00:00.000Z',
      ]);
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        m2,
        '--requested-at',
        '2026-05-22T09:00:00.000Z',
      ]);
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        m3,
        '--requested-at',
        '2026-05-22T11:00:00.000Z',
      ]);
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli(['list-bg-agent-requests', '--board-dir', boardDir]),
      );
      expect(exit).toBe(0);
      const result = readLastJson(captured) as {
        requests: Array<{ taskId: string; requestedAt: string }>;
      };
      expect(result.requests).toHaveLength(3);
      expect(result.requests.map((r) => r.taskId)).toEqual([
        'AISDLC-5401', // 09:00
        'AISDLC-5400', // 10:00
        'AISDLC-5402', // 11:00
      ]);
    });

    it('remove-bg-agent-request is idempotent (AC-2 cleanup path)', async () => {
      const manifestPath = writeManifestToInflight('AISDLC-5500');
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        manifestPath,
      ]);
      const requestFile = path.join(boardDir, 'bg-agent-request', 'AISDLC-5500.request.json');
      expect(existsSync(requestFile)).toBe(true);
      await runDispatchCli([
        'remove-bg-agent-request',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-5500',
      ]);
      expect(existsSync(requestFile)).toBe(false);
      // Second call must be a clean no-op (file already gone).
      const { exit } = await captureStdout(() =>
        runDispatchCli([
          'remove-bg-agent-request',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-5500',
        ]),
      );
      expect(exit).toBe(0);
    });

    it('count-in-flight-bg-agents dedupes when both inflight and request exist for same task', async () => {
      const manifestPath = writeManifestToInflight('AISDLC-5600');
      writeManifestToInflight('AISDLC-5601');
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        manifestPath,
      ]);
      // AISDLC-5600 has BOTH inflight + request; AISDLC-5601 has only inflight.
      // Dedup must give count = 2 (not 3).
      const { captured } = await captureStdout(() =>
        runDispatchCli(['count-in-flight-bg-agents', '--board-dir', boardDir]),
      );
      const result = readLastJson(captured) as { count: number };
      expect(result.count).toBe(2);
    });

    it('prune-orphaned-bg-agent-requests removes requests whose inflight manifest is gone (AC-6 reaper safety)', async () => {
      const manifestPath = writeManifestToInflight('AISDLC-5700');
      writeManifestToInflight('AISDLC-5701');
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        manifestPath,
      ]);
      const m2Path = path.join(boardDir, 'inflight', 'AISDLC-5701.dispatch.json');
      // Simulate writing a second request, then the stale-heartbeat sweeper
      // reaping AISDLC-5701's manifest to failed/ (we just delete it here).
      await runDispatchCli([
        'dispatch-bg-agent',
        '--board-dir',
        boardDir,
        '--manifest-path',
        m2Path,
      ]);
      rmSync(m2Path);
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli(['prune-orphaned-bg-agent-requests', '--board-dir', boardDir]),
      );
      expect(exit).toBe(0);
      const result = readLastJson(captured) as { pruned: string[] };
      expect(result.pruned).toEqual(['AISDLC-5701']);
      // The healthy request for AISDLC-5700 is preserved.
      expect(existsSync(path.join(boardDir, 'bg-agent-request', 'AISDLC-5700.request.json'))).toBe(
        true,
      );
    });

    it('honors yaml inSessionAgentMaxSessions as the max-sessions fallback (AC-5)', async () => {
      // AISDLC-396 round-2 MAJOR-3 fix: when the operator sets a custom
      // inSessionAgentMaxSessions in dispatch-config.yaml, the CLI must
      // default --max-sessions from that value (not unconditionally to 4).
      // Build a workDir with .ai-sdlc/dispatch-config.yaml setting cap=2
      // and .ai-sdlc/dispatch/ as the board dir under it.
      const workDir = mkdtempSync(path.join(tmpdir(), 'workdir-yaml-'));
      const aiSdlcDir = path.join(workDir, '.ai-sdlc');
      const boardDirUnderWork = path.join(aiSdlcDir, 'dispatch');
      dispatchEnsureBoardDirs(boardDirUnderWork);
      writeFileSync(
        path.join(aiSdlcDir, 'dispatch-config.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: DispatchConfig
spec:
  defaultWorkerKind: in-session-agent
  parallelism:
    inSessionAgentMaxSessions: 2
`,
        'utf8',
      );
      // Pre-populate inflight/ with 2 manifests — at cap=2 from yaml, the
      // 3rd dispatch must be refused even though no --max-sessions was passed.
      const manifestA = mkManifest('AISDLC-5800');
      const manifestB = mkManifest('AISDLC-5801');
      const manifestC = mkManifest('AISDLC-5802');
      const writeInflight = (m: DispatchManifest): string => {
        const target = path.join(boardDirUnderWork, 'inflight', `${m.taskId}.dispatch.json`);
        writeFileSync(target, JSON.stringify(m, null, 2), 'utf-8');
        return target;
      };
      writeInflight(manifestA);
      writeInflight(manifestB);
      const manifestPath = writeInflight(manifestC);
      // 3 in inflight; subtract current → 2 OTHER; cap from yaml = 2 → refuse.
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDirUnderWork,
          '--manifest-path',
          manifestPath,
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { maxSessions: number };
      expect(result.maxSessions).toBe(2);
      rmSync(workDir, { recursive: true, force: true });
    });

    it('falls back to default cap=4 when yaml is missing AND --max-sessions not passed', async () => {
      // Sanity check for the cap precedence: with no yaml + no flag, the
      // CLI must use DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS (4). Place 5
      // manifests so the 5th dispatch trips the default cap.
      writeManifestToInflight('AISDLC-5810');
      writeManifestToInflight('AISDLC-5811');
      writeManifestToInflight('AISDLC-5812');
      writeManifestToInflight('AISDLC-5813');
      const manifestPath = writeManifestToInflight('AISDLC-5814');
      // 5 in inflight; subtract current → 4 OTHER; default cap = 4 → refuse.
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDir,
          '--manifest-path',
          manifestPath,
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { maxSessions: number };
      expect(result.maxSessions).toBe(4);
    });

    it('explicit --max-sessions still overrides yaml (cap precedence: flag > yaml > default)', async () => {
      // Build workDir with yaml cap=8 and pass --max-sessions=1 → flag wins.
      const workDir = mkdtempSync(path.join(tmpdir(), 'workdir-precedence-'));
      const aiSdlcDir = path.join(workDir, '.ai-sdlc');
      const boardDirUnderWork = path.join(aiSdlcDir, 'dispatch');
      dispatchEnsureBoardDirs(boardDirUnderWork);
      writeFileSync(
        path.join(aiSdlcDir, 'dispatch-config.yaml'),
        `spec:
  parallelism:
    inSessionAgentMaxSessions: 8
`,
        'utf8',
      );
      const writeInflight = (taskId: string): string => {
        const m = mkManifest(taskId);
        const target = path.join(boardDirUnderWork, 'inflight', `${m.taskId}.dispatch.json`);
        writeFileSync(target, JSON.stringify(m, null, 2), 'utf-8');
        return target;
      };
      writeInflight('AISDLC-5820');
      writeInflight('AISDLC-5821');
      const manifestPath = writeInflight('AISDLC-5822');
      // 3 in inflight; subtract current → 2 OTHER. With --max-sessions=1
      // we refuse; if we'd respected yaml (8) we'd accept. Asserts flag-wins.
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'dispatch-bg-agent',
          '--board-dir',
          boardDirUnderWork,
          '--manifest-path',
          manifestPath,
          '--max-sessions',
          '1',
        ]),
      );
      expect(exit).toBe(1);
      const result = readLastJson(captured) as { maxSessions: number };
      expect(result.maxSessions).toBe(1);
      rmSync(workDir, { recursive: true, force: true });
    });

    it('help mentions Pattern X subcommands', async () => {
      const { captured } = await captureStdout(() => runDispatchCli(['help']));
      expect(captured.raw).toMatch(/dispatch-bg-agent/);
      expect(captured.raw).toMatch(/list-bg-agent-requests/);
      expect(captured.raw).toMatch(/Pattern X/);
    });

    it('help mentions the reverify subcommands (AISDLC-449)', async () => {
      const { captured } = await captureStdout(() => runDispatchCli(['help']));
      expect(captured.raw).toMatch(/reverify-blocked-prs/);
      expect(captured.raw).toMatch(/reverify-k/);
    });
  });

  // -------------------------------------------------------------------------
  // Stale-cache reverify (AISDLC-449).
  // -------------------------------------------------------------------------
  describe('reverify-blocked-prs', () => {
    let board: string;

    beforeEach(() => {
      board = mkBoard();
    });

    afterEach(() => {
      rmSync(path.dirname(board), { recursive: true, force: true });
    });

    const blocked = JSON.stringify([
      { prNumber: '4321', checkSignature: 'attestation:failure:v6-envelope' },
    ]);

    it('does not fire on the first sighting and persists state', async () => {
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'reverify-blocked-prs',
          '--board-dir',
          board,
          '--blocked-prs',
          blocked,
          '--dispatch-count',
          '0',
        ]),
      );
      expect(exit).toBe(0);
      const r = readLastJson(captured) as {
        shouldReverify: boolean;
        consecutiveNoChangeTicks: number;
        k: number;
      };
      expect(r.shouldReverify).toBe(false);
      expect(r.consecutiveNoChangeTicks).toBe(0);
      expect(r.k).toBe(2);
      // State file persisted.
      expect(existsSync(path.join(board, 'passive-state.json'))).toBe(true);
    });

    it('fires shouldReverify after K=2 consecutive no-change ticks', async () => {
      // Seed.
      await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      // Tick N+1 → counter 1.
      await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      // Tick N+2 → counter 2 == K → fires.
      const { captured } = await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      const r = readLastJson(captured) as {
        shouldReverify: boolean;
        consecutiveNoChangeTicks: number;
      };
      expect(r.consecutiveNoChangeTicks).toBe(2);
      expect(r.shouldReverify).toBe(true);
    });

    it('classifies same-blocker vs new-signal when --fresh is supplied', async () => {
      // Seed the cached blocked-PR set.
      await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      // Next tick reverifies with a fresh signature that DIFFERS → new-signal.
      const fresh = JSON.stringify({ '4321': 'attestation:failure:merkle-root-mismatch' });
      const { captured } = await captureStdout(() =>
        runDispatchCli([
          'reverify-blocked-prs',
          '--board-dir',
          board,
          '--blocked-prs',
          blocked,
          '--fresh',
          fresh,
        ]),
      );
      const r = readLastJson(captured) as {
        classifications: Array<{ prNumber: string; kind: string }>;
      };
      expect(r.classifications).toHaveLength(1);
      expect(r.classifications[0]?.kind).toBe('new-signal');
    });

    it('rejects malformed --blocked-prs JSON', async () => {
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', '{bad']),
      );
      expect(exit).toBe(1);
      const r = readLastJson(captured) as { ok: boolean };
      expect(r.ok).toBe(false);
    });

    it('rejects malformed --fresh JSON', async () => {
      // Seed so there's a cached observation to classify against.
      await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli([
          'reverify-blocked-prs',
          '--board-dir',
          board,
          '--blocked-prs',
          blocked,
          '--fresh',
          '{bad',
        ]),
      );
      expect(exit).toBe(1);
      const r = readLastJson(captured) as { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/invalid --fresh JSON/);
    });

    it('--dry-run does NOT advance the counter or mutate the state file', async () => {
      const statePath = path.join(board, 'passive-state.json');
      // Seed once so a non-empty unchanged blocked set exists to re-observe.
      await captureStdout(() =>
        runDispatchCli(['reverify-blocked-prs', '--board-dir', board, '--blocked-prs', blocked]),
      );
      const seededState = readFileSync(statePath, 'utf-8');

      // First dry-run probe with the SAME (unchanged) blocked set.
      const first = await captureStdout(() =>
        runDispatchCli([
          'reverify-blocked-prs',
          '--board-dir',
          board,
          '--blocked-prs',
          blocked,
          '--dry-run',
          'true',
        ]),
      );
      // Second dry-run probe — counter must NOT have advanced between them.
      const second = await captureStdout(() =>
        runDispatchCli([
          'reverify-blocked-prs',
          '--board-dir',
          board,
          '--blocked-prs',
          blocked,
          '--dry-run',
          'true',
        ]),
      );

      const r1 = readLastJson(first.captured) as { consecutiveNoChangeTicks: number };
      const r2 = readLastJson(second.captured) as { consecutiveNoChangeTicks: number };
      // Both probes report the same (computed-but-not-persisted) next count, so
      // the counter never advances across repeated dry-runs.
      expect(r1.consecutiveNoChangeTicks).toBe(r2.consecutiveNoChangeTicks);
      // The on-disk state file is byte-identical to the seeded state.
      expect(readFileSync(statePath, 'utf-8')).toBe(seededState);
    });

    it('reverify-k prints the resolved K', async () => {
      const { exit, captured } = await captureStdout(() =>
        runDispatchCli(['reverify-k', '--board-dir', board, '--k', '3']),
      );
      expect(exit).toBe(0);
      const r = readLastJson(captured) as { k: number };
      expect(r.k).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// enqueue / board / unblock / reap
// ---------------------------------------------------------------------------

describe('runDispatchCli ordering commands', () => {
  let root: string;
  let boardDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dispatch-enqueue-'));
    boardDir = path.join(root, 'dispatch');
    dispatchEnsureBoardDirs(boardDir);
    mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
    for (const id of ['t-1', 't-2']) {
      writeFileSync(path.join(root, 'backlog', 'tasks', `${id} - x.md`), '');
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const base = () => ['--board-dir', boardDir, '--work-dir', root, '--base-sha', 'abc1234'];

  it('enqueues repeated --task with shared ordering flags, then refuses a repeat', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli([
        'enqueue',
        '--task',
        'T-1',
        '--task',
        'T-2',
        '--group',
        'g',
        '--wave',
        '1',
        '--priority',
        '2',
        '--after',
        'T-9',
        ...base(),
      ]),
    );
    expect(exit).toBe(0);
    const m = JSON.parse(readFileSync(path.join(boardDir, 'queue', 'T-1.dispatch.json'), 'utf-8'));
    expect(m).toMatchObject({ sequenceGroup: 'g', wave: 1, priority: 2, after: ['T-9'] });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const again = await runDispatchCli(['enqueue', '--task', 'T-1', ...base()]);
    expect(again).toBe(1);
    expect(err.mock.calls.join('')).toContain('already on the board');
    err.mockRestore();
  });

  it('claim --worker records the name verbatim and completion reuses it', async () => {
    await runDispatchCli(['enqueue', '--task', 'T-1', ...base()]);
    const claim = await captureStdout(() =>
      runDispatchCli([
        'claim',
        '--worker-kind',
        'in-session-agent',
        '--worker',
        'executor-beta',
        '--board-dir',
        boardDir,
      ]),
    );
    expect(
      (readLastJson(claim.captured) as { manifest: { workerId: string } }).manifest.workerId,
    ).toBe('executor-beta');
    const onDisk = JSON.parse(
      readFileSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'), 'utf-8'),
    );
    expect(onDisk.workerId).toBe('executor-beta');
    await runDispatchCli([
      'heartbeat',
      '--task-id',
      'T-1',
      '--worker-kind',
      'in-session-agent',
      '--board-dir',
      boardDir,
    ]);
    const hb = JSON.parse(readFileSync(path.join(boardDir, 'inflight', 'T-1.state.json'), 'utf-8'));
    expect(hb.workerId).toBe('executor-beta');
    await runDispatchCli([
      'write-verdict',
      '--task-id',
      'T-1',
      '--outcome',
      'success',
      '--board-dir',
      boardDir,
    ]);
    const verdict = JSON.parse(
      readFileSync(path.join(boardDir, 'done', 'T-1.verdict.json'), 'utf-8'),
    );
    expect(verdict.workerId).toBe('executor-beta');
  });

  it('claim --worker rejects an empty name', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runDispatchCli([
      'claim',
      '--worker-kind',
      'in-session-agent',
      '--worker',
      '',
      '--board-dir',
      boardDir,
    ]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it('claim blocked by an undelivered PR exits 1 and names the PR on stderr', async () => {
    mkdirSync(path.join(boardDir, 'landing'), { recursive: true });
    writeFileSync(
      path.join(boardDir, 'landing', '7.json'),
      JSON.stringify({
        pr: 7,
        owner: 'executor:alpha',
        taskId: 'AISDLC-1',
        state: 'ci-pending',
        history: [],
      }),
    );
    await runDispatchCli(['enqueue', '--task', 'T-2', ...base()]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let code: number;
    let text: string;
    try {
      code = await runDispatchCli([
        'claim',
        '--worker-kind',
        'in-session-agent',
        '--worker',
        'alpha',
        '--board-dir',
        boardDir,
      ]);
      text = err.mock.calls.join('');
    } finally {
      err.mockRestore();
    }
    expect(code).toBe(1);
    expect(text).toContain('cli-dispatch claim:');
    expect(text).toContain('#7');
  });

  describe('write-verdict claim-holder check (executor callers only)', () => {
    async function claim(taskId: string, worker?: string): Promise<void> {
      dispatchWriteManifest(boardDir, mkManifest(taskId));
      await runDispatchCli([
        'claim',
        '--board-dir',
        boardDir,
        '--worker-kind',
        'in-session-agent',
        ...(worker === undefined ? [] : ['--worker', worker]),
      ]);
    }

    async function writeVerdictAs(
      role: 'executor' | 'planner' | null,
      args: string[],
    ): Promise<{ code: number; err: string }> {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const code = await runDispatchCli(['write-verdict', '--board-dir', boardDir, ...args], {
          callerRole: () => role,
        });
        return { code, err: err.mock.calls.map((c) => String(c[0])).join('') };
      } finally {
        err.mockRestore();
      }
    }

    const verdictExists = (taskId: string): boolean =>
      existsSync(path.join(boardDir, 'done', `${taskId}.verdict.json`)) ||
      existsSync(path.join(boardDir, 'failed', `${taskId}.verdict.json`));
    const inflightExists = (taskId: string): boolean =>
      existsSync(path.join(boardDir, 'inflight', `${taskId}.dispatch.json`));

    it('refuses an executor without --worker and writes nothing', async () => {
      await claim('AISDLC-5701', 'executor-a');
      const { code, err } = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5701',
        '--outcome',
        'success',
      ]);
      expect(code).toBe(2);
      expect(err).toContain('must pass --worker');
      expect(verdictExists('AISDLC-5701')).toBe(false);
      expect(inflightExists('AISDLC-5701')).toBe(true);
    });

    it('refuses an executor that does not hold the claim, writes nothing, keeps the claim', async () => {
      await claim('AISDLC-5702', 'executor-a');
      const { code, err } = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5702',
        '--outcome',
        'success',
        '--worker',
        'executor-b',
      ]);
      expect(code).toBe(1);
      expect(err).toContain("claimed by 'executor-a', not 'executor-b'");
      expect(verdictExists('AISDLC-5702')).toBe(false);
      expect(inflightExists('AISDLC-5702')).toBe(true);
    });

    it('refuses an executor on a claim with no recorded worker and on a task not inflight', async () => {
      await claim('AISDLC-5703');
      const unnamed = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5703',
        '--outcome',
        'failed',
        '--worker',
        'executor-a',
      ]);
      expect(unnamed.code).toBe(1);
      expect(unnamed.err).toContain('no recorded worker');
      const missing = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5704',
        '--outcome',
        'failed',
        '--worker',
        'executor-a',
      ]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain('is not inflight');
      expect(verdictExists('AISDLC-5703')).toBe(false);
      expect(verdictExists('AISDLC-5704')).toBe(false);
    });

    it('refuses an executor with an empty --worker or a disagreeing --worker-id', async () => {
      await claim('AISDLC-5705', 'executor-a');
      const empty = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5705',
        '--outcome',
        'success',
        '--worker',
        '',
      ]);
      expect(empty.code).toBe(2);
      const disagree = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5705',
        '--outcome',
        'success',
        '--worker',
        'executor-a',
        '--worker-id',
        'executor-b',
      ]);
      expect(disagree.code).toBe(2);
      expect(disagree.err).toContain('disagree');
      expect(verdictExists('AISDLC-5705')).toBe(false);
    });

    it('writes the verdict for an executor that holds the claim, under the recorded name', async () => {
      await claim('AISDLC-5706', 'executor-a');
      const { code } = await writeVerdictAs('executor', [
        '--task-id',
        'AISDLC-5706',
        '--outcome',
        'success',
        '--worker',
        'executor-a',
      ]);
      expect(code).toBe(0);
      const verdict = JSON.parse(
        readFileSync(path.join(boardDir, 'done', 'AISDLC-5706.verdict.json'), 'utf-8'),
      );
      expect(verdict.workerId).toBe('executor-a');
      expect(inflightExists('AISDLC-5706')).toBe(false);
    });

    it('keeps the legacy behaviour for a non-executor or unresolved caller with an unnamed claim', async () => {
      for (const [i, role] of ([null, 'planner'] as const).entries()) {
        const id = `AISDLC-571${i}`;
        await claim(id);
        const { code } = await writeVerdictAs(role, [
          '--task-id',
          id,
          '--outcome',
          'success',
          '--worker-id',
          'w1',
        ]);
        expect(code).toBe(0);
        const verdict = JSON.parse(
          readFileSync(path.join(boardDir, 'done', `${id}.verdict.json`), 'utf-8'),
        );
        expect(verdict.workerId).toBe('w1');
      }
    });
  });

  it('enqueues from a brief file', async () => {
    for (const id of ['tt-1', 'tt-2']) {
      writeFileSync(path.join(root, 'backlog', 'tasks', `${id} - x.md`), '');
    }
    const brief = path.join(root, 'brief.md');
    writeFileSync(
      brief,
      [
        '# Brief',
        '',
        '```yaml',
        'dispatchBrief:',
        '  - task: TT-1',
        '    wave: 1',
        '    priority: 2',
        '  - task: TT-2',
        '    after: [TT-1]',
        '    sequenceGroup: g',
        '    wave: 2',
        '```',
        '',
      ].join('\n'),
    );
    const { exit } = await captureStdout(() =>
      runDispatchCli(['enqueue', '--from-brief', brief, ...base()]),
    );
    expect(exit).toBe(0);
    const read = (id: string) =>
      JSON.parse(readFileSync(path.join(boardDir, 'queue', `${id}.dispatch.json`), 'utf-8'));
    expect(read('TT-1')).toMatchObject({ wave: 1, priority: 2 });
    expect(read('TT-1').after).toBeUndefined();
    expect(read('TT-2')).toMatchObject({ after: ['TT-1'], sequenceGroup: 'g', wave: 2 });
    expect(read('TT-2').priority).toBeUndefined();
  });

  it('rejects a one-letter task prefix in a brief while --task still accepts it', async () => {
    const brief = path.join(root, 'short.md');
    writeFileSync(brief, '```yaml\ndispatchBrief:\n  - task: T-1\n    wave: 1\n```\n');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runDispatchCli(['enqueue', '--from-brief', brief, ...base()])).toBe(1);
    expect(err.mock.calls.join('')).toContain('not a valid task id');
    err.mockRestore();
    expect(await runDispatchCli(['enqueue', '--task', 'T-1', ...base()])).toBe(0);
  });

  it('rejects a brief that is not a dispatchBrief block', async () => {
    const brief = path.join(root, 'bad.yaml');
    writeFileSync(brief, '- TT-1\n');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runDispatchCli(['enqueue', '--from-brief', brief, ...base()])).toBe(1);
    err.mockRestore();
    expect(existsSync(path.join(boardDir, 'queue', 'TT-1.dispatch.json'))).toBe(false);
  });

  it('requires a task source', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runDispatchCli(['enqueue', ...base()])).toBe(2);
    err.mockRestore();
  });

  it('prints the board with the reason an ineligible manifest is held', async () => {
    dispatchWriteManifest(boardDir, mkManifest('T-1', { after: ['T-9'] }));
    dispatchWriteManifest(boardDir, mkManifest('T-2'));
    const { captured } = await captureStdout(() =>
      runDispatchCli(['board', '--board-dir', boardDir]),
    );
    expect(captured.raw).toContain('T-2  eligible');
    expect(captured.raw).toContain('T-1  held: task T-9 is not on the board');
    const json = await captureStdout(() =>
      runDispatchCli(['board', '--json', '--board-dir', boardDir]),
    );
    expect((readLastJson(json.captured) as unknown[]).length).toBe(2);
  });

  it('prints an empty board', async () => {
    const { captured } = await captureStdout(() =>
      runDispatchCli(['board', '--board-dir', boardDir]),
    );
    expect(captured.raw).toBe('board is empty\n');
  });

  it('unblocks a parked manifest', async () => {
    writeFileSync(
      path.join(boardDir, 'blocked', 'T-1.dispatch.json'),
      JSON.stringify(mkManifest('T-1', { blockedBy: 'DEC-1' })),
    );
    const { exit } = await captureStdout(() =>
      runDispatchCli(['unblock', '--task-id', 'T-1', '--board-dir', boardDir]),
    );
    expect(exit).toBe(0);
    expect(existsSync(path.join(boardDir, 'queue', 'T-1.dispatch.json'))).toBe(true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runDispatchCli(['unblock', '--task-id', 'T-1', '--board-dir', boardDir])).toBe(1);
    err.mockRestore();
  });

  describe('dequeue (AISDLC-907)', () => {
    const run = (...a: string[]) => runDispatchCli(['dequeue', ...a, '--board-dir', boardDir]);
    const q = (id: string) => path.join(boardDir, 'queue', `${id}.dispatch.json`);

    it('retires a queued manifest with the reason, lowers the peek count, and allows re-emit', async () => {
      writeFileSync(q('T-1'), JSON.stringify(mkManifest('T-1')));
      const { exit } = await captureStdout(() => run('--task-id', 'T-1', '--reason', 'stale'));
      expect(exit).toBe(0);
      expect(existsSync(q('T-1'))).toBe(false);
      const retired = JSON.parse(
        readFileSync(path.join(boardDir, 'retired', 'T-1.dispatch.json'), 'utf-8'),
      );
      expect(retired.retiredReason).toBe('stale');
      const peek = await captureStdout(() => runDispatchCli(['peek', '--board-dir', boardDir]));
      expect((readLastJson(peek.captured) as { queued: number }).queued).toBe(0);
      const file = path.join(boardDir, 'new.json');
      writeFileSync(file, JSON.stringify(mkManifest('T-1')));
      const w = await captureStdout(() =>
        runDispatchCli(['write-manifest', '--json', file, '--board-dir', boardDir]),
      );
      expect(w.exit).toBe(0);
      expect(existsSync(q('T-1'))).toBe(true);
    });

    it('requires --reason', async () => {
      writeFileSync(q('T-1'), JSON.stringify(mkManifest('T-1')));
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(await run('--task-id', 'T-1')).toBe(2);
      err.mockRestore();
      expect(existsSync(q('T-1'))).toBe(true);
    });

    it('refuses an inflight task, a done verdict, and an unqueued task', async () => {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      writeFileSync(q('T-1'), JSON.stringify(mkManifest('T-1')));
      writeFileSync(
        path.join(boardDir, 'inflight', 'T-1.dispatch.json'),
        JSON.stringify(mkManifest('T-1')),
      );
      expect(await run('--task-id', 'T-1', '--reason', 'x')).toBe(1);
      expect(existsSync(q('T-1'))).toBe(true);
      rmSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'));
      writeFileSync(path.join(boardDir, 'done', 'T-1.verdict.json'), '{}');
      expect(await run('--task-id', 'T-1', '--reason', 'x')).toBe(1);
      expect(existsSync(q('T-1'))).toBe(true);
      expect(await run('--task-id', 'T-9', '--reason', 'x')).toBe(1);
      err.mockRestore();
    });
  });

  describe('reprioritize and peek --order (AISDLC-904)', () => {
    const run = (...a: string[]) => runDispatchCli(['reprioritize', ...a, '--board-dir', boardDir]);
    const q = (id: string) => path.join(boardDir, 'queue', `${id}.dispatch.json`);
    const put = (id: string, overrides: Partial<DispatchManifest>, ageSec: number) => {
      writeFileSync(q(id), JSON.stringify(mkManifest(id, overrides), null, 2) + '\n');
      const t = new Date(Date.now() - ageSec * 1000);
      utimesSync(q(id), t, t);
    };

    it('rewrites only priority and keeps every other byte', async () => {
      put('T-1', { priority: 3 }, 10);
      const before = readFileSync(q('T-1'), 'utf-8');
      expect(await run('T-1', '--priority', '0')).toBe(0);
      const after = readFileSync(q('T-1'), 'utf-8');
      expect(after).toBe(before.replace('"priority": 3', '"priority": 0'));
    });

    it('stores the note in reorderNote without creating a resume block, and refuses a note over the limit', async () => {
      put('T-1', {}, 10);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(await run('T-1', '--priority', '0', '--note', 'do the fix first')).toBe(0);
      const written = JSON.parse(readFileSync(q('T-1'), 'utf-8'));
      expect(written.resume).toBeUndefined();
      expect(written.reorderNote).toBe('do the fix first');
      const before = readFileSync(q('T-1'), 'utf-8');
      expect(await run('T-1', '--priority', '5', '--note', 'x'.repeat(4001))).toBe(1);
      expect(readFileSync(q('T-1'), 'utf-8')).toBe(before);
      err.mockRestore();
    });

    it('leaves resume byte-identical and stores the note in reorderNote (AISDLC-1047)', async () => {
      const resume = {
        note: 'cleanup first\nthen fix',
        resumedAt: '2026-10-11T00:00:00.000Z',
        resumedBy: 'dispatch',
      };
      put('T-1', { resume }, 10);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(await run('T-1', '--priority', '0', '--note', 'new')).toBe(0);
      const printed = out.mock.calls.map((c) => String(c[0])).join('');
      out.mockRestore();
      const written = JSON.parse(readFileSync(q('T-1'), 'utf-8'));
      expect(written.resume).toEqual(resume);
      expect(written.resume.note).toBe('cleanup first\nthen fix');
      expect(written.reorderNote).toBe('new');
      expect(printed).toContain('"resumeNote":"cleanup first"');
    });

    it('refuses inflight, done, failed, unqueued and a missing priority', async () => {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      put('T-1', {}, 10);
      writeFileSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'), '{}');
      expect(await run('T-1', '--priority', '0')).toBe(1);
      rmSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'));
      writeFileSync(path.join(boardDir, 'done', 'T-1.verdict.json'), '{}');
      expect(await run('T-1', '--priority', '0')).toBe(1);
      rmSync(path.join(boardDir, 'done', 'T-1.verdict.json'));
      writeFileSync(path.join(boardDir, 'failed', 'T-1.diagnostic.json'), '{}');
      expect(await run('T-1', '--priority', '0')).toBe(1);
      expect(await run('T-9', '--priority', '0')).toBe(1);
      expect(await run('T-1')).toBe(2);
      expect(JSON.parse(readFileSync(q('T-1'), 'utf-8')).priority).toBeUndefined();
      err.mockRestore();
    });

    it('peek --order prints the claim order on a mixed board', async () => {
      put('T-11', { priority: 1 }, 50);
      put('T-12', {}, 60);
      put('T-13', { priority: 1 }, 40);
      put('T-14', { priority: 2, wave: 1 }, 70);
      put('T-15', { priority: 9 }, 30);
      expect(await run('T-15', '--priority', '0')).toBe(0);
      const peek = await captureStdout(() =>
        runDispatchCli(['peek', '--order', '--board-dir', boardDir]),
      );
      const listed = readLastJson(peek.captured) as {
        taskId: string;
        wave: number;
        priority: number | null;
        dispatchedAt: string;
      }[];
      expect(listed[0]).toMatchObject({ wave: 0, priority: 0 });
      expect(listed[0]).toHaveProperty('dispatchedAt');
      const claimed: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await captureStdout(() =>
          runDispatchCli(['claim', '--worker-kind', 'in-session-agent', '--board-dir', boardDir]),
        );
        const c = readLastJson(r.captured) as { claimed: boolean; manifest?: { taskId: string } };
        if (!c.claimed) break;
        claimed.push(c.manifest!.taskId);
        rmSync(path.join(boardDir, 'inflight', `${c.manifest!.taskId}.dispatch.json`));
      }
      expect(listed.map((e) => e.taskId)).toEqual(['T-15', 'T-11', 'T-13', 'T-12', 'T-14']);
      expect(claimed).toEqual(listed.map((e) => e.taskId));
    });
  });

  it('reaps a stale inflight manifest back to the queue', async () => {
    dispatchWriteManifest(boardDir, mkManifest('T-1'));
    await captureStdout(() =>
      runDispatchCli(['claim', '--worker-kind', 'in-session-agent', '--board-dir', boardDir]),
    );
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'), hourAgo, hourAgo);
    const roster = path.join(root, 'roster.json');
    writeFileSync(roster, '["other"]');
    const { captured } = await captureStdout(() =>
      runDispatchCli([
        'reap',
        '--stale-ms',
        '1',
        '--retry-limit',
        '3',
        '--roster',
        roster,
        '--board-dir',
        boardDir,
      ]),
    );
    expect((readLastJson(captured) as { requeued: unknown[] }).requeued).toHaveLength(1);
    expect(existsSync(path.join(boardDir, 'queue', 'T-1.dispatch.json'))).toBe(true);
  });

  it('reap --help prints help and does not run the reap (AISDLC-823)', async () => {
    dispatchWriteManifest(boardDir, mkManifest('T-1'));
    await captureStdout(() =>
      runDispatchCli(['claim', '--worker-kind', 'in-session-agent', '--board-dir', boardDir]),
    );
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'), hourAgo, hourAgo);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = await runDispatchCli(['reap', '--help', '--board-dir', boardDir]);
    const exitShort = await runDispatchCli(['reap', '-h', '--board-dir', boardDir]);
    const printed = spy.mock.calls.map((c) => String(c[0])).join('');
    spy.mockRestore();
    expect([exit, exitShort]).toEqual([0, 0]);
    expect(printed).toContain('reap [--stale-ms');
    expect(existsSync(path.join(boardDir, 'inflight', 'T-1.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'queue', 'T-1.dispatch.json'))).toBe(false);
  });

  it('classify-prs classifies facts from a file and rejects bad input', async () => {
    const input = path.join(root, 'facts.json');
    writeFileSync(input, JSON.stringify([{ prNumber: 3, taskId: 'T-1', merged: true }]));
    const { captured } = await captureStdout(() =>
      runDispatchCli(['classify-prs', '--input', input]),
    );
    expect(readLastJson(captured)).toEqual([
      { prNumber: 3, taskId: 'T-1', state: 'merged', action: 'mark-done-sync-parent-start-next' },
    ]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runDispatchCli(['classify-prs', '--input', path.join(root, 'nope.json')])).toBe(2);
    writeFileSync(input, '{}');
    expect(await runDispatchCli(['classify-prs', '--input', input])).toBe(2);
    err.mockRestore();
  });

  it('classify-prs without --input and pr-facts fail closed when GitHub cannot be read', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const empty = mkdtempSync(path.join(tmpdir(), 'no-gh-'));
    const savedPath = process.env['PATH'];
    process.env['PATH'] = empty; // nothing on PATH, so the GitHub CLI cannot run
    try {
      expect(await runDispatchCli(['classify-prs', '--board-dir', boardDir])).toBe(2);
      expect(await runDispatchCli(['pr-facts', '--board-dir', boardDir])).toBe(1);
    } finally {
      process.env['PATH'] = savedPath;
      err.mockRestore();
    }
  });

  it('rejects non-integer numeric flags and a malformed roster', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = (args: string[]) => runDispatchCli([...args, '--board-dir', boardDir]);
    expect(await run(['enqueue', '--task', 'T-1', '--priority', 'high', '--work-dir', root])).toBe(
      2,
    );
    expect(await run(['enqueue', '--task', 'T-1', '--wave', '1.5', '--work-dir', root])).toBe(2);
    expect(await run(['sweep', '--stale-ms', 'soon'])).toBe(2);
    expect(await run(['reap', '--retry-limit', 'x'])).toBe(2);
    expect(await run(['reap', '--stale-ms', '1e3'])).toBe(2);
    const roster = path.join(root, 'bad-roster.json');
    writeFileSync(roster, '{"a":1}');
    expect(await run(['reap', '--roster', roster])).toBe(2);
    writeFileSync(roster, '[1]');
    expect(await run(['reap', '--roster', roster])).toBe(2);
    writeFileSync(roster, 'not json');
    expect(await run(['reap', '--roster', roster])).toBe(2);
    expect(await run(['unblock', '--task-id', '../../x'])).toBe(2);
    expect(err.mock.calls.join('')).toContain('--priority must be an integer');
    err.mockRestore();
  });
});

describe('push-only-check (AISDLC-849)', () => {
  it('refuses with exit 1 and a reason when nothing approves the content', async () => {
    const wt = mkdtempSync(path.join(tmpdir(), 'push-only-'));
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['push-only-check', '--task-id', 'AISDLC-849', '--worktree', wt]),
    );
    expect(exit).toBe(1);
    expect(captured.raw).toContain('"mode":"normal"');
  });

  it('approvalEnvelopeMatches is false outside a git repo', () => {
    expect(approvalEnvelopeMatches(mkdtempSync(path.join(tmpdir(), 'push-only-nogit-')))).toBe(
      false,
    );
  });

  it('accepts a missing verdict file when an approval envelope matches the content', async () => {
    const wt = mkdtempSync(path.join(tmpdir(), 'push-only-'));
    const sh = (a: string[]): string =>
      execFileSync('git', a, { cwd: wt, encoding: 'utf-8' }).trim();
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    writeFileSync(path.join(wt, 'a.txt'), 'a\n');
    sh(['add', 'a.txt']);
    sh(['commit', '-q', '-m', 'base']);
    sh(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    sh(['add', 'b.txt']);
    sh(['commit', '-q', '-m', 'work']);
    const pid = computePatchId(
      sh(['merge-base', 'origin/main', 'HEAD']),
      sh(['rev-parse', 'HEAD']),
      wt,
    );
    expect(pid).toBeTruthy();
    expect(approvalEnvelopeMatches(wt)).toBe(false);
    mkdirSync(path.join(wt, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(path.join(wt, '.ai-sdlc', 'attestations', `${pid}.v6.dsse.json`), '{}');
    expect(approvalEnvelopeMatches(wt)).toBe(true);
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['push-only-check', '--task-id', 'AISDLC-849', '--worktree', wt]),
    );
    expect(exit).toBe(0);
    expect(captured.raw).toContain('"verdictMissing":true');
  });
});

describe('findTaskFile', () => {
  it('resolves both filename shapes and avoids prefix collisions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'find-task-'));
    try {
      const tasks = path.join(dir, 'backlog', 'tasks');
      mkdirSync(tasks, { recursive: true });
      writeFileSync(path.join(tasks, 'aisdlc-954-some-slug.md'), '');
      writeFileSync(path.join(tasks, 'AISDLC-962 - Titled task.md'), '');
      writeFileSync(path.join(tasks, 'aisdlc-631.1 - Subtask.md'), '');
      expect(findTaskFile(dir, 'AISDLC-954')).toBe('backlog/tasks/aisdlc-954-some-slug.md');
      expect(findTaskFile(dir, 'AISDLC-962')).toBe('backlog/tasks/AISDLC-962 - Titled task.md');
      expect(findTaskFile(dir, 'AISDLC-95')).toBeUndefined();
      expect(findTaskFile(dir, 'AISDLC-631')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reenter --developer-round resumePath (AISDLC-1053)', () => {
  const TASK = 'AISDLC-950';
  const BRANCH = 'ai-sdlc/aisdlc-950-x';
  let root: string;
  let board: string;

  const gh = (file: string, args: readonly string[]) => {
    if (file === 'git' && args[0] === 'ls-remote') {
      return { status: 0, stdout: `aaaaaaa1111111\trefs/heads/${BRANCH}\n`, stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          number: 7,
          title: `feat: thing (${TASK})`,
          state: 'OPEN',
          headRefName: BRANCH,
          headRefOid: 'aaaaaaa1111111',
          isDraft: true,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            {
              name: 'ai-sdlc/pr-ready',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              title: 'test foo failed',
            },
          ],
        }),
      };
    }
    if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: '4242\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'dispatch-reenter-'));
    board = path.join(root, '.ai-sdlc', 'dispatch');
    dispatchEnsureBoardDirs(board);
    const { claimNext } = await import('../dispatch/board.js');
    const { completeTask } = await import('../dispatch/complete.js');
    dispatchWriteManifest(board, mkManifest(TASK, { branch: BRANCH }));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    completeTask(board, { taskId: TASK, outcome: 'failed', workerId: 'exec-a', prNumber: 7 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = async (extra: string[]): Promise<Record<string, unknown>> => {
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(
        [
          'reenter',
          '7',
          '--board-dir',
          board,
          '--work-dir',
          root,
          '--base-sha',
          'abc1234',
          ...extra,
        ],
        {
          ghRun: gh,
          operational: new Set(['requeue']),
          identity: {
            readSessions: () => [
              { name: 'operator-dispatch', role: 'operator-dispatch', pid: 400, status: 'running' },
            ],
            parentPid: (pid: number) => (pid === 500 ? 400 : null),
            comm: (pid: number) => (pid === 400 ? 'claude' : 'zsh'),
            startPid: 500,
          },
        },
      ),
    );
    expect(exit).toBe(0);
    return readLastJson(captured) as Record<string, unknown>;
  };

  it('prints resumePath developer-round when the flag is set', async () => {
    const r = await run(['--developer-round']);
    expect(r.resumePath).toBe('developer-round');
    expect((r.resume as { developerRound?: boolean }).developerRound).toBe(true);
  });

  it('prints full without the flag when the task has no worktree', async () => {
    const r = await run([]);
    expect(r.resumePath).toBe('full');
  });

  it('wires --decision into the guard release (unknown record is refused)', async () => {
    await run([]);
    const { exit } = await captureStdout(() =>
      runDispatchCli(
        [
          'reenter',
          '7',
          '--board-dir',
          board,
          '--work-dir',
          root,
          '--base-sha',
          'abc1234',
          '--decision',
          'DEC-9999',
        ],
        {
          ghRun: gh,
          operational: new Set(['requeue']),
          identity: {
            readSessions: () => [
              { name: 'operator-dispatch', role: 'operator-dispatch', pid: 400, status: 'running' },
            ],
            parentPid: (pid: number) => (pid === 500 ? 400 : null),
            comm: (pid: number) => (pid === 400 ? 'claude' : 'zsh'),
            startPid: 500,
          },
        },
      ),
    );
    expect(exit).not.toBe(0);
  });
});
