/**
 * cli-orchestrator router tests — drive the yargs program in-process and
 * assert on stdout/stderr/exit. Mirrors the pattern used by cli/deps.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrchestratorCli } from './orchestrator.js';
import { ORCHESTRATOR_FLAG, type OrchestratorAdapters } from '../orchestrator/index.js';
import type { PipelineResult, PipelineLogger } from '../types.js';

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
  };
}

describe('cli-orchestrator router', () => {
  describe('start', () => {
    it('refuses to start when AI_SDLC_AUTONOMOUS_ORCHESTRATOR is unset (exit 2)', async () => {
      delete process.env[ORCHESTRATOR_FLAG];
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
    });
  });

  describe('tick', () => {
    it('refuses to run when the flag is unset', async () => {
      delete process.env[ORCHESTRATOR_FLAG];
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
      // status is read-only — it should work whether or not the flag is set.
      delete process.env[ORCHESTRATOR_FLAG];
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
