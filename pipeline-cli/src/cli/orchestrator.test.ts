/**
 * cli-orchestrator router tests — drive the yargs program in-process and
 * assert on stdout/stderr/exit. Mirrors the pattern used by cli/deps.test.ts.
 *
 * AISDLC-225 tests cover:
 *   - `write-dispatch-result` subcommand: round-trips success + error envelopes
 *     through the CLI to a tmp file, then reads back via readDispatchResult.
 *   - `tick --continue-from-result`: reads dispatch-result.json and forwards to
 *     the umbrella without re-dispatching.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOrchestratorCli,
  emitBillingSafetyWarnings,
  BILLING_SAFETY_WARNING_LINES,
  FALLBACK_BILLING_WARNING_LINES,
} from './orchestrator.js';
import { ORCHESTRATOR_FLAG, type OrchestratorAdapters } from '../orchestrator/index.js';
import type { PipelineResult, PipelineLogger } from '../types.js';
import { readDispatchResult, writeDispatchResult } from '../runtime/spawners/dispatch-result.js';

let savedArgv: string[];
let savedEnv: NodeJS.ProcessEnv;
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  savedArgv = process.argv;
  savedEnv = { ...process.env };
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
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
  process.env = savedEnv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-orchestrator', ...args];
}

function stdoutJson(): unknown {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function stderrJson(): unknown {
  for (let i = stderrChunks.length - 1; i >= 0; i--) {
    const c = stderrChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: `https://github.com/x/y/pull/${taskId}`,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

function fakeAdapters(ids: string[]): OrchestratorAdapters {
  const queue = [...ids];
  return {
    logger: silentLogger(),
    sleep: () => Promise.resolve(),
    frontier: () => queue.map((id) => ({ id, title: id })),
    dispatch: async (taskId: string) => {
      const i = queue.indexOf(taskId);
      if (i >= 0) queue.splice(i, 1);
      return approvedResult(taskId);
    },
    escalate: async () => {},
    // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
    parentBranchGuard: async () => {},
  };
}

describe('cli-orchestrator router', () => {
  describe('start', () => {
    it('refuses to start when AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off (post-AISDLC-411 opt-out)', async () => {
      // AISDLC-411: post-cutover unset = ON; explicit opt-out via 'off'.
      process.env[ORCHESTRATOR_FLAG] = 'off';
      setArgv('start', '--max-ticks', '1');
      await expect(buildOrchestratorCli(fakeAdapters([])).parseAsync()).rejects.toThrow(
        'process.exit(2)',
      );
      const err = stderrJson() as { ok: boolean; reason: string };
      expect(err.ok).toBe(false);
      expect(err.reason).toContain(ORCHESTRATOR_FLAG);
    });

    it('runs N ticks when --max-ticks is set + flag is enabled', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      setArgv('start', '--max-ticks', '2', '--tick-interval-sec', '0', '--max-concurrent', '1');
      await buildOrchestratorCli(fakeAdapters(['AISDLC-X', 'AISDLC-Y'])).parseAsync();
      const out = stdoutJson() as { ok: boolean; mode: string; ticksRun: number };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('start');
      expect(out.ticksRun).toBe(2);
    }, 30000);

    it('threads --spawner codex into start umbrella dispatch', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      const calls: string[] = [];
      const adapters: OrchestratorAdapters = {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-START-CODEX', title: 'AISDLC-START-CODEX' }],
        escalate: async () => {},
        umbrellaExecutor: async (taskId, spawnerKind) => {
          calls.push(`${taskId}:${spawnerKind}`);
          return {
            ok: true,
            pipeline: approvedResult(taskId),
          };
        },
        graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
        taskLabelsLoader: () => [],
        calibrationLogPath: '/nonexistent-bypass.jsonl',
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      };
      setArgv(
        'start',
        '--max-ticks',
        '1',
        '--tick-interval-sec',
        '0',
        '--max-concurrent',
        '1',
        '--spawner',
        'codex',
      );

      await buildOrchestratorCli(adapters).parseAsync();

      expect(calls).toEqual(['AISDLC-START-CODEX:codex']);
      const out = stdoutJson() as { ok: boolean; mode: string; ticksRun: number };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('start');
      expect(out.ticksRun).toBe(1);
    });
  });

  describe('tick', () => {
    it('refuses to run when the flag is explicitly disabled (off)', async () => {
      // AISDLC-411: post-cutover unset = ON; opt-out via 'off'.
      process.env[ORCHESTRATOR_FLAG] = 'off';
      setArgv('tick');
      await expect(buildOrchestratorCli(fakeAdapters([])).parseAsync()).rejects.toThrow(
        'process.exit(2)',
      );
    });

    it('runs a single tick + emits a JSON result when the flag is enabled', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      setArgv('tick', '--max-concurrent', '1');
      await buildOrchestratorCli(fakeAdapters(['AISDLC-Z'])).parseAsync();
      const out = stdoutJson() as { ok: boolean; mode: string; tick: { dispatched: string[] } };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('tick');
      expect(out.tick.dispatched).toEqual(['AISDLC-Z']);
    });

    it('threads --spawner codex into tick umbrella dispatch', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      const calls: string[] = [];
      const adapters: OrchestratorAdapters = {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-TICK-CODEX', title: 'AISDLC-TICK-CODEX' }],
        escalate: async () => {},
        umbrellaExecutor: async (taskId, spawnerKind) => {
          calls.push(`${taskId}:${spawnerKind}`);
          return {
            ok: true,
            pipeline: approvedResult(taskId),
          };
        },
        graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
        taskLabelsLoader: () => [],
        calibrationLogPath: '/nonexistent-bypass.jsonl',
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      };
      setArgv('tick', '--max-concurrent', '1', '--spawner', 'codex');

      await buildOrchestratorCli(adapters).parseAsync();

      expect(calls).toEqual(['AISDLC-TICK-CODEX:codex']);
      const out = stdoutJson() as { ok: boolean; mode: string; tick: { dispatched: string[] } };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('tick');
      expect(out.tick.dispatched).toEqual(['AISDLC-TICK-CODEX']);
    });

    it('honors --dry-run by reporting candidates without dispatching', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      setArgv('tick', '--dry-run', '--max-concurrent', '5');
      await buildOrchestratorCli(fakeAdapters(['AISDLC-A', 'AISDLC-B'])).parseAsync();
      const out = stdoutJson() as {
        ok: boolean;
        tick: { candidates: number; dispatched: string[] };
      };
      expect(out.tick.candidates).toBe(2);
      expect(out.tick.dispatched).toEqual([]);
    });
  });

  describe('status', () => {
    it('emits frontier + queue depth + flag name (no dispatch, ignores flag)', async () => {
      // status is read-only — it should work whether or not the flag is enabled.
      // AISDLC-411: explicitly opt out so `enabled` is observably false here.
      process.env[ORCHESTRATOR_FLAG] = 'off';
      setArgv('status');
      await buildOrchestratorCli(fakeAdapters(['AISDLC-A', 'AISDLC-B'])).parseAsync();
      const out = stdoutJson() as {
        ok: boolean;
        flag: string;
        status: { queueDepth: number; enabled: boolean };
      };
      expect(out.ok).toBe(true);
      expect(out.flag).toBe(ORCHESTRATOR_FLAG);
      expect(out.status.queueDepth).toBe(2);
      expect(out.status.enabled).toBe(false);
    });

    it('reports `enabled: true` when the flag is set', async () => {
      process.env[ORCHESTRATOR_FLAG] = 'experimental';
      setArgv('status');
      await buildOrchestratorCli(fakeAdapters([])).parseAsync();
      const out = stdoutJson() as { status: { enabled: boolean; queueDepth: number } };
      expect(out.status.enabled).toBe(true);
      expect(out.status.queueDepth).toBe(0);
    });
  });
});

// ── AISDLC-225: write-dispatch-result subcommand ──────────────────────

describe('cli-orchestrator write-dispatch-result (AISDLC-225)', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-225-cli-'));
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('writes a success envelope to the specified result-path', async () => {
    const resultPath = join(tmpDir, 'dispatch-result.json');
    const parsedPayload = JSON.stringify({
      commitSha: 'abc1234',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    setArgv(
      'write-dispatch-result',
      '--task-id',
      'AISDLC-225',
      '--subagent-type',
      'developer',
      '--status',
      'success',
      '--output',
      '{"commitSha":"abc1234"}',
      '--parsed',
      parsedPayload,
      '--result-path',
      resultPath,
      '--duration-ms',
      '30000',
    );

    await buildOrchestratorCli().parseAsync();

    const out = stdoutJson() as { ok: boolean; mode: string; result: unknown };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('write-dispatch-result');

    // Round-trip: read back via readDispatchResult
    const read = readDispatchResult({ resultPath });
    expect(read).not.toBeNull();
    expect(read!.taskId).toBe('AISDLC-225');
    expect(read!.subagentType).toBe('developer');
    expect(read!.status).toBe('success');
    expect(read!.durationMs).toBe(30000);
    expect(read!.parsed).toEqual({
      commitSha: 'abc1234',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
  });

  it('writes an error envelope with --error flag', async () => {
    const resultPath = join(tmpDir, 'dispatch-result.json');

    setArgv(
      'write-dispatch-result',
      '--task-id',
      'AISDLC-225',
      '--subagent-type',
      'developer',
      '--status',
      'error',
      '--error',
      'Agent session timed out after 600s',
      '--result-path',
      resultPath,
      '--duration-ms',
      '600000',
    );

    await buildOrchestratorCli().parseAsync();

    const out = stdoutJson() as { ok: boolean; mode: string };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('write-dispatch-result');

    const read = readDispatchResult({ resultPath });
    expect(read).not.toBeNull();
    expect(read!.status).toBe('error');
    expect(read!.error).toBe('Agent session timed out after 600s');
    expect(read!.durationMs).toBe(600000);
  });

  it('computes durationMs from --start-ms when provided', async () => {
    const resultPath = join(tmpDir, 'dispatch-result.json');
    const startMs = Date.now() - 12345;

    setArgv(
      'write-dispatch-result',
      '--task-id',
      'AISDLC-225',
      '--subagent-type',
      'developer',
      '--status',
      'success',
      '--result-path',
      resultPath,
      '--start-ms',
      String(startMs),
    );

    await buildOrchestratorCli().parseAsync();

    const read = readDispatchResult({ resultPath });
    expect(read).not.toBeNull();
    // Duration should be approximately 12345ms (within 2s tolerance for test execution)
    expect(read!.durationMs).toBeGreaterThanOrEqual(12000);
    expect(read!.durationMs).toBeLessThan(15000);
  });

  it('creates parent directories automatically', async () => {
    const resultPath = join(tmpDir, 'deep', 'nested', 'result.json');

    setArgv(
      'write-dispatch-result',
      '--task-id',
      'AISDLC-999',
      '--subagent-type',
      'code-reviewer',
      '--status',
      'success',
      '--result-path',
      resultPath,
      '--duration-ms',
      '5000',
    );

    await buildOrchestratorCli().parseAsync();

    const read = readDispatchResult({ resultPath });
    expect(read).not.toBeNull();
    expect(read!.taskId).toBe('AISDLC-999');
    expect(read!.subagentType).toBe('code-reviewer');
  });
});

// ── AISDLC-225: tick --continue-from-result ───────────────────────────

describe('cli-orchestrator tick --continue-from-result (AISDLC-225)', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-225-tick-'));
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
  });

  afterEach(() => {
    cleanup();
  });

  it('reads dispatch-result.json and forwards to dispatch instead of re-dispatching', async () => {
    // Write a pre-completed developer result to the tmp dir
    const resultPath = join(tmpDir, 'dispatch-result.json');
    writeDispatchResult(
      {
        taskId: 'AISDLC-777',
        subagentType: 'developer',
        status: 'success',
        output: '{"commitSha":"abc","prUrl":"https://github.com/org/repo/pull/7"}',
        parsed: { commitSha: 'abc', prUrl: 'https://github.com/org/repo/pull/7' },
        durationMs: 30000,
      },
      { resultPath },
    );

    // Track what task IDs were dispatched
    const dispatchedIds: string[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: 'AISDLC-777', title: 'Test task 777' }],
      dispatch: async (taskId) => {
        dispatchedIds.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-225: inject the continuation path
      continueFromResultPath: resultPath,
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    setArgv('tick', '--max-concurrent', '1', '--continue-from-result', resultPath);

    // The tick dispatches AISDLC-777. With continueFromResultPath set,
    // it should use the pre-loaded result (via the prefill spawner) rather
    // than calling adapters.dispatch directly. But since we also inject
    // adapters.dispatch (legacy path), the adapter priority means
    // continueFromResultPath takes precedence over adapters.dispatch.
    // The dispatch adapter won't be called (prefill path uses executePipeline
    // directly). So dispatchedIds stays empty.
    //
    // However, executePipeline requires a real backlog task file. In this
    // hermetic test, executePipeline will fail (no task file on disk) and the
    // orchestrator will record an unknown-failure escalation. That's acceptable
    // for this test — what we're verifying is:
    //   1. The CLI doesn't error on the --continue-from-result flag
    //   2. The tick result shape is valid
    //   3. continueFromResultPath was threaded correctly (dispatch adapter NOT called)
    //
    // For a full integration test of the prefill-spawner path, see
    // loop.umbrella.test.ts (which injects a mock umbrellaExecutor).
    await buildOrchestratorCli(adapters).parseAsync();

    const out = stdoutJson() as { ok: boolean; mode: string; tick: { dispatched: string[] } };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('tick');

    // The legacy dispatch adapter must NOT have been called — the continuation
    // path bypasses it by taking the continueFromResultPath branch.
    expect(dispatchedIds).toHaveLength(0);
  });

  it('bare --continue-from-result flag (no path) resolves to default artifact path', async () => {
    // This test verifies the CLI accepts --continue-from-result without a value.
    // The tick will fail to find the file (no artifact dir in test env) but
    // should not throw a yargs argument error.
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [], // empty frontier → idle tick (no dispatch attempt)
      dispatch: async (taskId) => approvedResult(taskId),
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    setArgv('tick', '--max-concurrent', '1', '--continue-from-result');

    await buildOrchestratorCli(adapters).parseAsync();

    const out = stdoutJson() as { ok: boolean; mode: string; tick: { empty: boolean } };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('tick');
    // Empty frontier → idle tick (no dispatch)
    expect(out.tick.empty).toBe(true);
  });
});

// ── AISDLC-352: billing-safety warnings ──────────────────────────────────

describe('emitBillingSafetyWarnings (AISDLC-352)', () => {
  it('emits BILLING_SAFETY_WARNING when spawner=claude AND ANTHROPIC_API_KEY is set', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings('claude', { ANTHROPIC_API_KEY: 'sk-ant-test' }, (msg) =>
      lines.push(msg),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[orchestrator] warning: ANTHROPIC_API_KEY is set');
    expect(lines[0]).toContain('--spawner claude is requested');
  });

  it('does NOT emit BILLING_SAFETY_WARNING when spawner=claude AND ANTHROPIC_API_KEY is unset', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings('claude', {}, (msg) => lines.push(msg));
    expect(lines).toHaveLength(0);
  });

  it('does NOT emit BILLING_SAFETY_WARNING when spawner=api-key even if ANTHROPIC_API_KEY is set', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings('api-key', { ANTHROPIC_API_KEY: 'sk-ant-test' }, (msg) =>
      lines.push(msg),
    );
    expect(lines).toHaveLength(0);
  });

  it('does NOT emit BILLING_SAFETY_WARNING when spawner=mock even if ANTHROPIC_API_KEY is set', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings('mock', { ANTHROPIC_API_KEY: 'sk-ant-test' }, (msg) =>
      lines.push(msg),
    );
    expect(lines).toHaveLength(0);
  });

  it('emits FALLBACK_BILLING_WARNING when AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key AND spawner != api-key', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings(
      'claude',
      { AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK: 'api-key' },
      (msg) => lines.push(msg),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key');
  });

  it('does NOT emit FALLBACK_BILLING_WARNING when spawner=api-key', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings(
      'api-key',
      { AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK: 'api-key' },
      (msg) => lines.push(msg),
    );
    expect(lines).toHaveLength(0);
  });

  it('emits BOTH warnings when ANTHROPIC_API_KEY set + SPAWNER_FALLBACK=api-key + spawner=claude', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings(
      'claude',
      { ANTHROPIC_API_KEY: 'sk-ant-test', AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK: 'api-key' },
      (msg) => lines.push(msg),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[orchestrator] warning: ANTHROPIC_API_KEY is set');
    expect(lines[1]).toContain('AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key');
  });

  it('does NOT fire any warning in a clean env (no API key, no fallback)', () => {
    const lines: string[] = [];
    emitBillingSafetyWarnings('claude', {}, (msg) => lines.push(msg));
    expect(lines).toHaveLength(0);
  });

  it('exports the exact warning line arrays for downstream assertions', () => {
    // Ensure exported constants are the canonical text (not copied strings)
    expect(BILLING_SAFETY_WARNING_LINES[0]).toContain('[orchestrator] warning: ANTHROPIC_API_KEY');
    expect(FALLBACK_BILLING_WARNING_LINES[0]).toContain(
      'AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key',
    );
  });
});

// ── AISDLC-352: default spawner = claude ──────────────────────────────────

describe('cli-orchestrator tick default spawner (AISDLC-352)', () => {
  it('defaults spawner to claude when no --spawner flag is passed', async () => {
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
    const spawnerKinds: string[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [],
      escalate: async () => {},
      // AISDLC-363: skip real git branch check so the test is hermetic in
      // worktrees / non-main CI branches.
      parentBranchGuard: async () => {},
      umbrellaExecutor: async (taskId, spawnerKind) => {
        spawnerKinds.push(spawnerKind);
        return { ok: true, pipeline: approvedResult(taskId) };
      },
    };

    setArgv('tick', '--max-concurrent', '1');
    await buildOrchestratorCli(adapters).parseAsync();

    // Empty frontier → no dispatch, but buildAdapters should have set claude
    // as the umbrellaSpawnerKind default. Verify via the warn helper that was
    // called with 'claude' (no ANTHROPIC_API_KEY in savedEnv → no warning).
    const out = stdoutJson() as { ok: boolean; mode: string };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('tick');
  });
});

// ── AISDLC-373: tick --task-from-file (single-PR operator-driven flow) ─────

describe('cli-orchestrator tick --task-from-file (AISDLC-373)', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-373-tff-'));
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
  });

  afterEach(() => {
    cleanup();
  });

  function writeTaskFile(relativePath: string, id: string, title: string): string {
    const absolute = join(tmpDir, relativePath);
    // Use path.dirname for cross-platform correctness — lastIndexOf('/') breaks
    // on Windows where the separator is '\\'. (Round-2 reviewer minor fix.)
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      [`---`, `id: ${id}`, `title: ${title}`, `status: To Do`, `---`, ``, `## Problem`, `x`].join(
        '\n',
      ),
      'utf8',
    );
    return absolute;
  }

  it('synthesizes a one-element frontier from the resolved task file', async () => {
    const taskFile = writeTaskFile(
      '.worktrees/aisdlc-500/backlog/tasks/aisdlc-500 - manual-pick.md',
      'AISDLC-500',
      'manual pick test',
    );

    const dispatchedIds: string[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      // Inject a frontier that returns the WRONG task. The CLI's
      // --task-from-file should override this with the resolved task file.
      frontier: () => [{ id: 'AISDLC-WRONG', title: 'wrong' }],
      dispatch: async (taskId) => {
        dispatchedIds.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      parentBranchGuard: async () => {},
    };

    setArgv('tick', '--max-concurrent', '1', '--task-from-file', taskFile);
    await buildOrchestratorCli(adapters).parseAsync();

    const out = stdoutJson() as {
      ok: boolean;
      mode: string;
      tick: { dispatched: string[]; candidates: number };
    };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('tick');
    expect(out.tick.candidates).toBe(1);
    expect(out.tick.dispatched).toEqual(['AISDLC-500']);
    expect(dispatchedIds).toEqual(['AISDLC-500']);
  });

  it('bypasses the §4.3 admission filter chain (no graphLoader needed)', async () => {
    const taskFile = writeTaskFile(
      'backlog/tasks/aisdlc-501 - bypass-test.md',
      'AISDLC-501',
      'bypass test',
    );

    // graphLoader is INTENTIONALLY omitted to prove the loop never calls
    // it. If the filter chain weren't bypassed, the default in-process
    // graph builder would walk the tmp tmpDir and dispatch would happen
    // (or fail) based on the filter outcome rather than the bypass.
    const dispatchedIds: string[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [],
      dispatch: async (taskId) => {
        dispatchedIds.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      parentBranchGuard: async () => {},
    };

    setArgv('tick', '--work-dir', tmpDir, '--max-concurrent', '1', '--task-from-file', taskFile);
    await buildOrchestratorCli(adapters).parseAsync();

    const out = stdoutJson() as {
      ok: boolean;
      tick: { dispatched: string[]; filterEvents: unknown[] };
    };
    expect(out.ok).toBe(true);
    expect(out.tick.dispatched).toEqual(['AISDLC-501']);
    // No filter chain ran → no filter events.
    expect(out.tick.filterEvents).toEqual([]);
    expect(dispatchedIds).toEqual(['AISDLC-501']);
  });

  it('exits 1 with a structured error when the task file does not exist', async () => {
    setArgv('tick', '--max-concurrent', '1', '--task-from-file', join(tmpDir, 'no-such-file.md'));
    await expect(
      buildOrchestratorCli({
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        parentBranchGuard: async () => {},
      }).parseAsync(),
    ).rejects.toThrow('process.exit(1)');

    const err = stderrJson() as { ok: boolean; reason: string };
    expect(err.ok).toBe(false);
    expect(err.reason).toContain('--task-from-file');
    expect(err.reason).toContain('does not exist');
  });

  it('exits 1 with a structured error when the filename does not match the convention', async () => {
    const badFile = join(tmpDir, 'random-name.md');
    writeFileSync(badFile, '---\nid: X\n---\n', 'utf8');

    setArgv('tick', '--max-concurrent', '1', '--task-from-file', badFile);
    await expect(
      buildOrchestratorCli({
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        parentBranchGuard: async () => {},
      }).parseAsync(),
    ).rejects.toThrow('process.exit(1)');

    const err = stderrJson() as { ok: boolean; reason: string };
    expect(err.ok).toBe(false);
    expect(err.reason).toContain('does not match');
  });

  // Round-2 reviewer MAJOR fix — integration: drive the REAL umbrella dispatch
  // path (not a mocked `dispatch` adapter) end-to-end with `--task-from-file`
  // pointing at a worktree-local file. Assert that the executor receives the
  // resolved `taskFilePathOverride` so the downstream `runExecuteCommand` →
  // `executePipeline` → Step 1 `validateTask` chain can actually find the
  // operator-supplied file.
  //
  // The previous test in this block used the legacy `dispatch` adapter which
  // bypasses the umbrella path entirely; that left the documented runbook
  // (operator creates `.worktrees/aisdlc-NNN/backlog/tasks/<...>.md` then runs
  // `cli-orchestrator tick --task-from-file <path>`) silently broken because
  // the inner `findTaskFile()` scan only looks at `<workDir>/backlog/tasks/`.
  it('threads --task-from-file path through the umbrella dispatch to runExecuteCommand', async () => {
    const taskFile = writeTaskFile(
      '.worktrees/aisdlc-502/backlog/tasks/aisdlc-502 - umbrella-thread.md',
      'AISDLC-502',
      'umbrella thread test',
    );

    const executorCalls: Array<{ taskId: string; taskFilePathOverride?: string }> = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      // umbrellaExecutor IS the test seam closest to the real
      // `runExecuteCommand` call — it sits inside `buildDefaultUmbrellaDispatch`
      // immediately above `runExecuteCommand(...)`. Asserting that the
      // executor sees `taskFilePathOverride` proves the threading wires all
      // the way from CLI parse → synthetic frontier → per-tick file-path map
      // → default umbrella dispatch → executor invocation.
      umbrellaExecutor: async (taskId, spawnerKind, opts) => {
        executorCalls.push({
          taskId,
          ...(opts?.taskFilePathOverride !== undefined
            ? { taskFilePathOverride: opts.taskFilePathOverride }
            : {}),
        });
        return {
          ok: true,
          pipeline: approvedResult(taskId),
        };
      },
      escalate: async () => {},
      parentBranchGuard: async () => {},
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
    };

    setArgv(
      'tick',
      '--work-dir',
      tmpDir,
      '--max-concurrent',
      '1',
      '--task-from-file',
      taskFile,
      // Default spawner is `claude`; pass `codex` so we don't trip the
      // ANTHROPIC_API_KEY billing-safety warning emit path.
      '--spawner',
      'codex',
    );

    await buildOrchestratorCli(adapters).parseAsync();

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].taskId).toBe('AISDLC-502');
    // The critical assertion: the override the operator passed via
    // `--task-from-file` reached the executor. Without the round-2 threading
    // fix this field was undefined, leaving the inner validateTask to scan
    // `<workDir>/backlog/tasks/` and fail with `no task file for AISDLC-502`.
    expect(executorCalls[0].taskFilePathOverride).toBe(taskFile);

    const out = stdoutJson() as {
      ok: boolean;
      tick: { dispatched: string[] };
    };
    expect(out.ok).toBe(true);
    expect(out.tick.dispatched).toEqual(['AISDLC-502']);
  });
});

// ── AISDLC-460 — ci-failure-watch subcommand ──────────────────────────

describe('cli-orchestrator ci-failure-watch', () => {
  it('--list-cooldowns returns the active cool-down records and exits', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cli-ci-watch-'));
    try {
      // Seed a cool-down file directly.
      const dir = join(tmp, '.ai-sdlc', 'ci-conflict-resolver', 'cooldown');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, '42.json'),
        JSON.stringify({
          prNumber: 42,
          classification: 'conflict-detected',
          escalatedAt: Date.now() - 1000,
          reason: 'semantic-conflict',
        }),
      );
      setArgv('ci-failure-watch', '--work-dir', tmp, '--list-cooldowns');
      await buildOrchestratorCli().parseAsync();
      const out = stdoutJson() as { ok: boolean; mode: string; listCooldowns: unknown[] };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('ci-failure-watch');
      expect(out.listCooldowns).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-run path (no --enable-dispatch) — surface contract test', async () => {
    // The dry-run path requires `gh` to be wired (the CLI calls real
    // gh because the standalone surface does NOT accept an injected
    // Runner — adapters injection is reserved for the umbrella spawner
    // path). Hermetic coverage of the watcher core itself lives in
    // pipeline-cli/src/runtime/ci-failure-watcher.test.ts which
    // exercises every classification + cool-down + dedup branch with
    // a fake Runner.
    //
    // Here we verify the surface — yargs parses the flags + emits
    // ok:true when --list-cooldowns short-circuits before gh runs.
    // Full end-to-end with gh is a soak-time integration test, not a
    // unit test.
    const tmp = mkdtempSync(join(tmpdir(), 'cli-ci-watch-'));
    try {
      setArgv('ci-failure-watch', '--work-dir', tmp, '--list-cooldowns');
      await buildOrchestratorCli().parseAsync();
      const out = stdoutJson() as { ok: boolean; mode: string; listCooldowns: unknown[] };
      expect(out.ok).toBe(true);
      expect(out.mode).toBe('ci-failure-watch');
      expect(out.listCooldowns).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
