/**
 * Tests for the post-AISDLC-100.5 watch entry point. The pre-migration tests
 * mocked `@ai-sdlc/orchestrator`'s `startWatch` + reconciler loop. The new
 * driver runs each `--issue` directly through `executePipeline()` from
 * `@ai-sdlc/pipeline-cli`, so these tests:
 *
 *   1. Cover the CLI surface (`parseArgs` validation via the `process.argv` /
 *      `process.exit` path) by importing the module and asserting on the
 *      argv-parser side effects.
 *   2. Cover the migration call site by hand (without spawning a real
 *      pipeline) — verifying that `runOneIssue` invokes
 *      `executePipeline({ taskId, spawner, ... })` with the right shape and
 *      surfaces every documented outcome (`approved`,
 *      `needs-human-attention`, `developer-failed`, `aborted`).
 *   3. Cover the spawner factory (`resolveSpawner('mock')` → `MockSpawner`,
 *      others delegate to `defaultSpawner` from pipeline-cli).
 *
 * Pipeline-cli's `executePipeline` is mocked at the module boundary so each
 * test can script the result without touching git/gh/the LLM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PipelineResult } from '@ai-sdlc/pipeline-cli';

const executePipelineMock = vi.fn();

vi.mock('@ai-sdlc/pipeline-cli', async () => {
  // Pull in the real MockSpawner so resolveSpawner('mock') still returns a
  // working instance — only `executePipeline` and `defaultSpawner` are stubbed.
  const actual =
    await vi.importActual<typeof import('@ai-sdlc/pipeline-cli')>('@ai-sdlc/pipeline-cli');
  return {
    ...actual,
    executePipeline: (...args: unknown[]) => executePipelineMock(...args),
    defaultSpawner: vi.fn(async () => ({
      spawn: vi.fn(),
      spawnParallel: vi.fn(),
    })),
  };
});

describe('cli-watch.ts (RFC-0012 Phase 5)', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error -- mock process.exit for test
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    executePipelineMock.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('argv parsing', () => {
    it('exits with error when no --issue is provided', async () => {
      process.argv = ['node', 'cli-watch.ts'];
      await import('./cli-watch.js');
      // Allow main() microtasks to flush.
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: watch'));
    });

    it('exits with error when --issue value is empty after trim', async () => {
      process.argv = ['node', 'cli-watch.ts', '--issue', '  '];
      await import('./cli-watch.js');
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid issue ID'));
    });

    it('exits with error when --spawner value is unknown', async () => {
      process.argv = ['node', 'cli-watch.ts', '--issue', 'AISDLC-1', '--spawner', 'gibberish'];
      await import('./cli-watch.js');
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --spawner'));
    });
  });

  describe('runOneIssue (executePipeline call site)', () => {
    function approvedResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
      return {
        taskId: 'AISDLC-100.5',
        branch: 'ai-sdlc/aisdlc-100.5-mock',
        worktreePath: '/tmp/wt',
        outcome: 'approved',
        prUrl: 'https://github.com/owner/repo/pull/42',
        siblingPrUrls: [],
        iterations: 1,
        finalVerdict: null,
        ...overrides,
      };
    }

    it('invokes executePipeline with taskId + spawner + workDir + runner', async () => {
      executePipelineMock.mockResolvedValueOnce(approvedResult());
      const { runOneIssue, resolveSpawner } = await import('./cli-watch.js');
      const spawner = await resolveSpawner('mock');
      const result = await runOneIssue('AISDLC-100.5', spawner, '/tmp/repo');
      expect(executePipelineMock).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'AISDLC-100.5',
          workDir: '/tmp/repo',
          spawner,
          runner: expect.any(Function),
        }),
      );
      expect(result.outcome).toBe('approved');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('approved → https://github.com/owner/repo/pull/42'),
      );
    });

    it('warns + reports needs-human-attention outcome', async () => {
      executePipelineMock.mockResolvedValueOnce(
        approvedResult({ outcome: 'needs-human-attention', iterations: 2 }),
      );
      const { runOneIssue, resolveSpawner } = await import('./cli-watch.js');
      const spawner = await resolveSpawner('mock');
      await runOneIssue('AISDLC-100.5', spawner, '/tmp/repo');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('needs human attention'));
    });

    it('errors + reports developer-failed outcome', async () => {
      executePipelineMock.mockResolvedValueOnce(
        approvedResult({
          outcome: 'developer-failed',
          prUrl: null,
          notes: 'developer subagent crashed',
        }),
      );
      const { runOneIssue, resolveSpawner } = await import('./cli-watch.js');
      const spawner = await resolveSpawner('mock');
      await runOneIssue('AISDLC-100.5', spawner, '/tmp/repo');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('developer failed — developer subagent crashed'),
      );
    });

    it('errors + reports aborted outcome', async () => {
      executePipelineMock.mockResolvedValueOnce(
        approvedResult({
          outcome: 'aborted',
          prUrl: null,
          notes: 'task validation failed',
        }),
      );
      const { runOneIssue, resolveSpawner } = await import('./cli-watch.js');
      const spawner = await resolveSpawner('mock');
      await runOneIssue('AISDLC-100.5', spawner, '/tmp/repo');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('aborted — task validation failed'),
      );
    });
  });

  describe('resolveSpawner', () => {
    it('mock kind returns a usable MockSpawner with auto-approving fixtures', async () => {
      const { resolveSpawner } = await import('./cli-watch.js');
      const spawner = await resolveSpawner('mock');
      const result = await spawner.spawn({
        type: 'developer',
        prompt: 'test',
        cwd: '/tmp',
      });
      expect(result.status).toBe('success');
      expect(result.parsed).toMatchObject({ summary: expect.stringContaining('[mock]') });

      const reviewResult = await spawner.spawn({
        type: 'code-reviewer',
        prompt: 'test',
        cwd: '/tmp',
      });
      expect(reviewResult.parsed).toMatchObject({ approved: true });
    });

    it('shell kind delegates to defaultSpawner with env override', async () => {
      const { resolveSpawner } = await import('./cli-watch.js');
      const { defaultSpawner } = await import('@ai-sdlc/pipeline-cli');
      await resolveSpawner('shell');
      expect(defaultSpawner).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.any(Function) }),
      );
    });

    it('sdk kind delegates to defaultSpawner with which override', async () => {
      const { resolveSpawner } = await import('./cli-watch.js');
      const { defaultSpawner } = await import('@ai-sdlc/pipeline-cli');
      await resolveSpawner('sdk');
      expect(defaultSpawner).toHaveBeenCalledWith(
        expect.objectContaining({ which: expect.any(Function) }),
      );
    });
  });
});
