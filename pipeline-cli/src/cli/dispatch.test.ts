/**
 * Tests for `cli-dispatch` — the operator CLI surface for the Dispatch Board
 * (RFC-0041 §4.4, AISDLC-377.1).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchEnsureBoardDirs, dispatchWriteManifest } from '../index.js';
import type { DispatchManifest } from '../index.js';

import { parseArgv, runDispatchCli } from './dispatch.js';

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
      runDispatchCli(['remove-verdict', '--board-dir', boardDir, '--task-id', 'AISDLC-NOPE']),
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
          'AISDLC-NOPE',
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
        runDispatchCli(['read-resume-signal', '--board-dir', boardDir, '--task-id', 'AISDLC-NOPE']),
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
          'AISDLC-NOPE',
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
          'AISDLC-MISSING',
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

    it('help mentions Pattern X subcommands', async () => {
      const { captured } = await captureStdout(() => runDispatchCli(['help']));
      expect(captured.raw).toMatch(/dispatch-bg-agent/);
      expect(captured.raw).toMatch(/list-bg-agent-requests/);
      expect(captured.raw).toMatch(/Pattern X/);
    });
  });
});
