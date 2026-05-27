/**
 * Tests for the AISDLC-182 umbrella `execute` subcommand.
 *
 * Coverage:
 *   1. Spawner resolution — `mock` succeeds, `api-key` errors when
 *      ANTHROPIC_API_KEY is unset, `claude` returns ShellClaudePSpawner,
 *      `codex` requires CODEX_SPAWN_AGENT_BIN. The removed `claude-cli`
 *      kind (RFC-0041 Phase 3.3 / AISDLC-377.6) is rejected with a
 *      pointed migration error.
 *   2. Verdict-file write — `writeVerdictFile()` lands the JSON at
 *      `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` and the payload
 *      shape matches what `scripts/check-attestation-sign.sh` expects.
 *   3. `runExecuteCommand` safe default / dry-run mode — emits a plan
 *      WITHOUT resolving spawners or calling executePipeline, useful for
 *      plumbing checks.
 *   4. `runExecuteCommand` real-run mode — invokes the injected executor
 *      and writes the verdict file via `onProgress` per iteration (AC #6 +
 *      AC #7).
 *   5. CLI router integration — `ai-sdlc-pipeline execute` is wired and
 *      surfaces the same JSON shape via the yargs router.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE,
  buildApprovingMockSpawner,
  resolveSpawner,
  runExecuteCommand,
  writeVerdictFile,
} from './execute.js';
import type { SpawnerKind } from './execute.js';
import { buildCli } from './index.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import type { RollbackResult } from '../orchestrator/rollback.js';
import type {
  AggregatedVerdict,
  PipelineLogger,
  PipelineResult,
  ReviewerVerdict,
  SubagentSpawner,
} from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

function silentLogger(): PipelineLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    progress: () => {},
  };
}

function approvedVerdict(): AggregatedVerdict {
  const verdicts: ReviewerVerdict[] = [
    {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
    {
      agentId: 'test-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
    {
      agentId: 'security-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
  ];
  return {
    approved: true,
    counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    decision: 'APPROVED',
    verdicts,
    harnessNote: 'mock',
    summary: '3 reviewers approved',
  };
}

const stubSpawner: SubagentSpawner = {
  async spawn() {
    return { type: 'developer', output: '', status: 'success', durationMs: 0 };
  },
  async spawnParallel() {
    return [];
  },
};

async function stubSpawnerFactory(): Promise<SubagentSpawner> {
  return stubSpawner;
}

describe('resolveSpawner', () => {
  it('returns a MockSpawner when kind=mock', async () => {
    const spawner = await resolveSpawner('mock');
    expect(spawner).toBeInstanceOf(MockSpawner);
  });

  it('throws CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE when kind=claude-cli (RFC-0041 Phase 3.3 / AISDLC-377.6)', async () => {
    // The legacy `--spawner claude-cli` (inline-manifest, AISDLC-198) was
    // removed in RFC-0041 Phase 3.3 — the yargs `choices: SPAWNER_KINDS`
    // constraint already rejects it at parse time, and this test exercises
    // the programmatic-caller defense-in-depth path that still receives the
    // string literal. The thrown message points the operator at the
    // migration breadcrumb.
    await expect(resolveSpawner('claude-cli' as unknown as SpawnerKind)).rejects.toThrow(
      /removed in RFC-0041 Phase 3\.3 \(AISDLC-377\.6\)/,
    );
    expect(CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE).toContain('AISDLC-377.6');
    expect(CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE).toContain(
      'docs/operations/claude-cli-spawner-removed.md',
    );
  });

  it('errors when kind=api-key and ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(resolveSpawner('api-key')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('errors with a clear configuration message when kind=codex and CODEX_SPAWN_AGENT_BIN is unset (AISDLC-202.2)', async () => {
    const saved = process.env.CODEX_SPAWN_AGENT_BIN;
    delete process.env.CODEX_SPAWN_AGENT_BIN;
    try {
      await expect(resolveSpawner('codex')).rejects.toThrow(/CODEX_SPAWN_AGENT_BIN/);
    } finally {
      if (saved !== undefined) process.env.CODEX_SPAWN_AGENT_BIN = saved;
    }
  });

  it('returns a ShellClaudePSpawner when kind=claude (AISDLC-349)', async () => {
    // AISDLC-349: the `claude` spawner actually shells out to `claude -p`,
    // unlike `claude-cli` which only emits a dispatch manifest. Use this
    // from a shell-driven `cli-orchestrator tick` (cron/daemon/sidecar)
    // where no slash command body is around to read the manifest.
    const spawner = await resolveSpawner('claude');
    expect(typeof spawner.spawn).toBe('function');
    expect(typeof spawner.spawnParallel).toBe('function');
    // Public-API check: buildArgv() returns the actual `claude -p` argv +
    // resolves the per-role model. security-reviewer must pin to opus.
    const argv = (
      spawner as unknown as {
        buildArgv: (opts: { type: string; prompt: string; cwd: string }) => string[];
      }
    ).buildArgv({ type: 'security-reviewer', prompt: 'noop', cwd: '/tmp' });
    expect(argv).toContain('--print');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('--agent');
    expect(argv).toContain('security-reviewer');
    // AISDLC-349 inline code-review MAJOR fix: per-role model split enforced
    // at the spawner level via --model flag (agent files have model:inherit,
    // so without --model the role would inherit session default).
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-opus-4-6');
  });

  it('per-role model split: developer uses sonnet via --spawner claude (AISDLC-349)', async () => {
    const spawner = await resolveSpawner('claude');
    const argv = (
      spawner as unknown as {
        buildArgv: (opts: { type: string; prompt: string; cwd: string }) => string[];
      }
    ).buildArgv({ type: 'developer', prompt: 'noop', cwd: '/tmp' });
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-4-6');
  });

  it('returns a CodexHarnessAdapter when kind=codex and CODEX_SPAWN_AGENT_BIN is set (AISDLC-202.2)', async () => {
    const saved = process.env.CODEX_SPAWN_AGENT_BIN;
    process.env.CODEX_SPAWN_AGENT_BIN = '/tmp/fake-codex-bridge';
    try {
      const spawner = await resolveSpawner('codex');
      expect(typeof spawner.spawn).toBe('function');
      expect(typeof spawner.spawnParallel).toBe('function');
    } finally {
      if (saved === undefined) {
        delete process.env.CODEX_SPAWN_AGENT_BIN;
      } else {
        process.env.CODEX_SPAWN_AGENT_BIN = saved;
      }
    }
  });

  it('errors with a clear configuration message when kind=copilot and COPILOT_SPAWN_AGENT_BIN is unset (AISDLC-429.2)', async () => {
    const saved = process.env.COPILOT_SPAWN_AGENT_BIN;
    delete process.env.COPILOT_SPAWN_AGENT_BIN;
    try {
      await expect(resolveSpawner('copilot')).rejects.toThrow(/COPILOT_SPAWN_AGENT_BIN/);
    } finally {
      if (saved !== undefined) process.env.COPILOT_SPAWN_AGENT_BIN = saved;
    }
  });

  it('error message for copilot also includes an install hint (AISDLC-429.2 AC #4)', async () => {
    const saved = process.env.COPILOT_SPAWN_AGENT_BIN;
    delete process.env.COPILOT_SPAWN_AGENT_BIN;
    try {
      await expect(resolveSpawner('copilot')).rejects.toThrow(/[Ii]nstall/);
    } finally {
      if (saved !== undefined) process.env.COPILOT_SPAWN_AGENT_BIN = saved;
    }
  });

  it('returns a CopilotHarnessAdapter when kind=copilot and COPILOT_SPAWN_AGENT_BIN is set (AISDLC-429.2)', async () => {
    const saved = process.env.COPILOT_SPAWN_AGENT_BIN;
    process.env.COPILOT_SPAWN_AGENT_BIN = '/tmp/fake-copilot-bridge';
    try {
      const spawner = await resolveSpawner('copilot');
      expect(typeof spawner.spawn).toBe('function');
      expect(typeof spawner.spawnParallel).toBe('function');
    } finally {
      if (saved === undefined) {
        delete process.env.COPILOT_SPAWN_AGENT_BIN;
      } else {
        process.env.COPILOT_SPAWN_AGENT_BIN = saved;
      }
    }
  });
});

describe('buildApprovingMockSpawner', () => {
  it('returns success+approved fixtures for all 3 reviewer types', async () => {
    const spawner = buildApprovingMockSpawner();
    const dev = await spawner.spawn({ type: 'developer', prompt: 'p', cwd: tmp });
    expect(dev.status).toBe('success');
    const code = await spawner.spawn({ type: 'code-reviewer', prompt: 'p', cwd: tmp });
    const test = await spawner.spawn({ type: 'test-reviewer', prompt: 'p', cwd: tmp });
    const sec = await spawner.spawn({ type: 'security-reviewer', prompt: 'p', cwd: tmp });
    for (const r of [code, test, sec]) {
      expect(r.status).toBe('success');
      expect((r.parsed as { approved: boolean }).approved).toBe(true);
    }
  });
});

describe('writeVerdictFile', () => {
  it('writes JSON to <worktree>/.ai-sdlc/verdicts/<task-id-lower>.json', () => {
    const verdict = approvedVerdict();
    const filePath = writeVerdictFile({
      taskId: 'AISDLC-182',
      worktreePath: tmp,
      iteration: 1,
      verdict,
    });
    expect(filePath).toBe(join(tmp, '.ai-sdlc', 'verdicts', 'aisdlc-182.json'));
    expect(existsSync(filePath)).toBe(true);
    const payload = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(payload.taskId).toBe('AISDLC-182');
    expect(payload.decision).toBe('APPROVED');
    expect(payload.approved).toBe(true);
    expect(payload.iteration).toBe(1);
    expect(payload.verdicts).toHaveLength(3);
    // The pre-push hook reads `verdicts[].agentId` (well, the legacy shape
    // it parses); ensure we kept all three reviewer ids.
    const ids = payload.verdicts.map((v: ReviewerVerdict) => v.agentId).sort();
    expect(ids).toEqual(['code-reviewer', 'security-reviewer', 'test-reviewer']);
  });

  it('overwrites the file when called twice (idempotent across iterations)', () => {
    const v1 = approvedVerdict();
    writeVerdictFile({ taskId: 'AISDLC-99', worktreePath: tmp, iteration: 1, verdict: v1 });
    const v2 = { ...approvedVerdict(), summary: 'second iteration' };
    const filePath = writeVerdictFile({
      taskId: 'AISDLC-99',
      worktreePath: tmp,
      iteration: 2,
      verdict: v2,
    });
    const payload = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(payload.iteration).toBe(2);
    expect(payload.summary).toBe('second iteration');
  });
});

describe('runExecuteCommand — dry-run mode', () => {
  it('defaults to a safe plan WITHOUT resolving a spawner or calling the executor', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-201', title: 'safe default', status: 'To Do' });
    const taskPath = join(tmp, 'backlog', 'tasks', 'aisdlc-201 - safe-default.md');
    const before = readFileSync(taskPath, 'utf8');
    let spawnerFactoryCalled = false;
    let executorCalled = false;

    const result = await runExecuteCommand({
      taskId: 'AISDLC-201',
      workDir: tmp,
      spawnerKind: 'mock',
      maxIterations: 2,
      dryRun: false,
      run: false,
      spawnerFactory: async () => {
        spawnerFactoryCalled = true;
        return stubSpawner;
      },
      executor: async () => {
        executorCalled = true;
        throw new Error('executor should not be called by default');
      },
      logger: silentLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.planned?.taskId).toBe('AISDLC-201');
    expect(spawnerFactoryCalled).toBe(false);
    expect(executorCalled).toBe(false);
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-201'))).toBe(false);
    expect(readFileSync(taskPath, 'utf8')).toBe(before);
  });

  it('explicit real spawner without --run still plans without resolving or executing', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-211', title: 'api key plan', status: 'To Do' });
    const taskPath = join(tmp, 'backlog', 'tasks', 'aisdlc-211 - api-key-plan.md');
    const before = readFileSync(taskPath, 'utf8');
    let spawnerFactoryCalled = false;
    let executorCalled = false;

    const result = await runExecuteCommand({
      taskId: 'AISDLC-211',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: false,
      spawnerFactory: async () => {
        spawnerFactoryCalled = true;
        throw new Error('spawner should not resolve without --run');
      },
      executor: async () => {
        executorCalled = true;
        throw new Error('executor should not be called without --run');
      },
      logger: silentLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.planned?.taskId).toBe('AISDLC-211');
    expect(result.planned?.spawnerKind).toBe('api-key');
    expect(spawnerFactoryCalled).toBe(false);
    expect(executorCalled).toBe(false);
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-211'))).toBe(false);
    expect(readFileSync(taskPath, 'utf8')).toBe(before);
  });

  it('emits a plan WITHOUT calling the executor', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-182', title: 'plumbing check', status: 'To Do' });
    let executorCalled = false;
    const result = await runExecuteCommand({
      taskId: 'AISDLC-182',
      workDir: tmp,
      spawnerKind: 'mock',
      maxIterations: 2,
      dryRun: true,
      executor: async () => {
        executorCalled = true;
        throw new Error('executor should not be called in dry-run');
      },
      logger: silentLogger(),
    });
    expect(executorCalled).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.planned).toBeDefined();
    expect(result.planned?.taskId).toBe('AISDLC-182');
    expect(result.planned?.spawnerKind).toBe('mock');
    expect(result.planned?.branch).toMatch(/^ai-sdlc\/aisdlc-182-/);
    expect(result.planned?.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-182'));
  });

  it('returns ok=false when the task does not exist (dry-run validation)', async () => {
    const result = await runExecuteCommand({
      taskId: 'AISDLC-DOES-NOT-EXIST',
      workDir: tmp,
      spawnerKind: 'mock',
      maxIterations: 2,
      dryRun: true,
      logger: silentLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

describe('runExecuteCommand — real-run mode', () => {
  it('refuses --run with --spawner mock before validation, spawner resolution, or execution', async () => {
    let spawnerFactoryCalled = false;
    let executorCalled = false;
    const result = await runExecuteCommand({
      taskId: 'AISDLC-DOES-NOT-EXIST',
      workDir: tmp,
      spawnerKind: 'mock',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: async () => {
        spawnerFactoryCalled = true;
        return stubSpawner;
      },
      executor: async () => {
        executorCalled = true;
        throw new Error('executor should not be called for mock --run');
      },
      logger: silentLogger(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mock.*dry-run\/plumbing only/i);
    expect(spawnerFactoryCalled).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it('invokes executor and writes the verdict file via onProgress', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-200', title: 'real run', status: 'To Do' });

    const captured: { onProgressCalls: number; verdictFileExists: boolean | null } = {
      onProgressCalls: 0,
      verdictFileExists: null,
    };

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      // Simulate iterateReviewLoop firing onProgress on iteration 1 with an
      // APPROVED verdict.
      if (pipelineOpts.onProgress) {
        await pipelineOpts.onProgress(1, approvedVerdict());
      }
      captured.onProgressCalls += 1;
      // Check the verdict file landed BEFORE we return — the pre-push hook
      // reads it at push time, which is later in the real flow but the
      // wrapper guarantees write-by-end-of-executor.
      captured.verdictFileExists = existsSync(
        join(tmp, '.worktrees', 'aisdlc-200', '.ai-sdlc', 'verdicts', 'aisdlc-200.json'),
      );
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-200-x',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-200'),
        outcome: 'approved',
        prUrl: 'https://github.com/owner/repo/pull/1',
        siblingPrUrls: [],
        iterations: 1,
        finalVerdict: approvedVerdict(),
      };
    };

    const result = await runExecuteCommand({
      taskId: 'AISDLC-200',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      logger: silentLogger(),
    });
    expect(result.ok).toBe(true);
    expect(captured.onProgressCalls).toBe(1);
    expect(captured.verdictFileExists).toBe(true);
    expect(result.pipeline?.outcome).toBe('approved');
    expect(result.verdictFilePath).toMatch(/aisdlc-200\.json$/);
  });

  it('falls back to writing the FINAL verdict when onProgress was never invoked', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-201', title: 'no-loop variant', status: 'To Do' });

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async () => {
      // Never invoke onProgress — exercise the post-run fallback writer.
      return {
        taskId: 'AISDLC-201',
        branch: 'ai-sdlc/aisdlc-201-x',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-201'),
        outcome: 'approved',
        prUrl: 'https://github.com/owner/repo/pull/2',
        siblingPrUrls: [],
        iterations: 1,
        finalVerdict: approvedVerdict(),
      } satisfies PipelineResult;
    };

    const result = await runExecuteCommand({
      taskId: 'AISDLC-201',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      logger: silentLogger(),
    });
    expect(result.ok).toBe(true);
    expect(result.verdictFilePath).toMatch(/aisdlc-201\.json$/);
    expect(existsSync(result.verdictFilePath as string)).toBe(true);
  });

  it('returns ok=false when the spawner factory throws (api-key missing ANTHROPIC_API_KEY)', async () => {
    // Use api-key without ANTHROPIC_API_KEY set to exercise the "spawner throws" path.
    // (Pre-AISDLC-377.6 this used to assert against the claude-cli throw path.)
    writeTaskFile(tmp, { id: 'AISDLC-202', title: 'spawner gate', status: 'To Do' });
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runExecuteCommand({
        taskId: 'AISDLC-202',
        workDir: tmp,
        spawnerKind: 'api-key', // fails when ANTHROPIC_API_KEY is unset
        maxIterations: 2,
        dryRun: false,
        run: true,
        logger: silentLogger(),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('returns ok=false when the executor throws (does not crash)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-203', title: 'executor blew up', status: 'To Do' });
    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async () => {
      throw new Error('boom');
    };
    const result = await runExecuteCommand({
      taskId: 'AISDLC-203',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      logger: silentLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('boom');
  });

  it('threads injected spawnerFactory through (no real spawner constructed)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-204', title: 'inject spawner', status: 'To Do' });
    let spawnerKindSeen: string | undefined;
    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-204-x',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-204'),
        outcome: 'developer-failed',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
      } satisfies PipelineResult;
    };
    const result = await runExecuteCommand({
      taskId: 'AISDLC-204',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      logger: silentLogger(),
      spawnerFactory: async (k) => {
        spawnerKindSeen = k;
        return stubSpawner;
      },
      executor: fakeExec,
      rollback: async (args) => ({
        taskId: args.taskId,
        fromStatus: args.fromStatus,
        statusReverted: true,
        worktreeRemoved: true,
        branchQuarantined: false,
        warnings: [],
      }),
    });
    expect(result.ok).toBe(true);
    expect(spawnerKindSeen).toBe('api-key');
  });

  it('invokes AISDLC-177 rollback on developer-failed outcome and surfaces the result', async () => {
    // Iteration-2 fix: the wrapper used to silently propagate
    // `developer-failed` outcomes without reversing the Step 3 (worktree) +
    // Step 4 (status flip + sentinel) side-effects. The orchestrator's
    // loop.ts already wires `rollbackDispatch` for the autonomous path; the
    // umbrella subcommand now wires it for the manual path so the operator
    // (or a re-dispatch) finds a clean slate after a dev failure.
    writeTaskFile(tmp, { id: 'AISDLC-205', title: 'dev failed', status: 'To Do' });

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-205-dev-failed',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-205'),
        outcome: 'developer-failed',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
      } satisfies PipelineResult;
    };

    type RollbackArgs = Parameters<
      typeof import('../orchestrator/rollback.js').rollbackDispatch
    >[0];
    const rollbackCalls: RollbackArgs[] = [];
    const fakeRollback = async (args: RollbackArgs): Promise<RollbackResult> => {
      rollbackCalls.push(args);
      return {
        taskId: args.taskId,
        fromStatus: args.fromStatus,
        statusReverted: true,
        worktreeRemoved: true,
        branchQuarantined: false,
        warnings: [],
      };
    };

    const result = await runExecuteCommand({
      taskId: 'AISDLC-205',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: fakeRollback,
      logger: silentLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.pipeline?.outcome).toBe('developer-failed');

    // Rollback was invoked exactly once with the captured pre-dispatch
    // status (`To Do`), the dispatcher's branch+worktree, and the operator's
    // workDir.
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]?.taskId).toBe('AISDLC-205');
    expect(rollbackCalls[0]?.fromStatus).toBe('To Do');
    expect(rollbackCalls[0]?.branch).toBe('ai-sdlc/aisdlc-205-dev-failed');
    expect(rollbackCalls[0]?.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-205'));
    expect(rollbackCalls[0]?.workDir).toBe(tmp);

    // Result envelope surfaces the rollback outcome so operators can see
    // whether status was reverted, worktree removed, etc.
    expect(result.rollback).toBeDefined();
    expect(result.rollback?.statusReverted).toBe(true);
    expect(result.rollback?.worktreeRemoved).toBe(true);
    expect(result.rollback?.branchQuarantined).toBe(false);
  });

  it('invokes AISDLC-177 rollback on developer-json-contract-violated outcome', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-206',
      title: 'contract violated',
      status: 'To Do',
    });

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-206-prose-twice',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-206'),
        outcome: 'developer-json-contract-violated',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
      } satisfies PipelineResult;
    };

    let rollbackInvoked = false;
    const result = await runExecuteCommand({
      taskId: 'AISDLC-206',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: async (args) => {
        rollbackInvoked = true;
        return {
          taskId: args.taskId,
          fromStatus: args.fromStatus,
          statusReverted: true,
          worktreeRemoved: true,
          branchQuarantined: true,
          quarantineRef: 'quarantine/aisdlc-206-2026-05-04T12-00-00',
          quarantineSha: 'deadbeef',
          quarantineCommitCount: 2,
          warnings: [],
        };
      },
      logger: silentLogger(),
    });

    expect(rollbackInvoked).toBe(true);
    expect(result.rollback?.branchQuarantined).toBe(true);
    expect(result.rollback?.quarantineRef).toBe('quarantine/aisdlc-206-2026-05-04T12-00-00');
    expect(result.rollback?.quarantineCommitCount).toBe(2);
  });

  it('invokes AISDLC-177 rollback on aborted outcome (Step 11 push/PR-create failed)', async () => {
    // AISDLC-191: The aborted outcome originates from `execute-pipeline.ts`
    // around line 229-233 — Step 11 (`pushAndPr`) failed because the push
    // was rejected (non-fast-forward) or `gh pr create` returned a
    // transient network error. Either way, Steps 3-4 already created the
    // worktree + flipped the task status to "In Progress"; without
    // rollback the task is stuck and the operator has to hand-clean.
    // This test guards the parity with the orchestrator's `ROLLBACK_OUTCOMES`
    // (AISDLC-191 AC #1).
    writeTaskFile(tmp, { id: 'AISDLC-209', title: 'push aborted', status: 'To Do' });

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-209-aborted',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-209'),
        outcome: 'aborted',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 1,
        finalVerdict: approvedVerdict(),
        notes: 'gh pr create failed: transient network error',
      } satisfies PipelineResult;
    };

    type RollbackArgs = Parameters<
      typeof import('../orchestrator/rollback.js').rollbackDispatch
    >[0];
    const rollbackCalls: RollbackArgs[] = [];
    const fakeRollback = async (args: RollbackArgs): Promise<RollbackResult> => {
      rollbackCalls.push(args);
      return {
        taskId: args.taskId,
        fromStatus: args.fromStatus,
        statusReverted: true,
        worktreeRemoved: true,
        branchQuarantined: false,
        warnings: [],
      };
    };

    const result = await runExecuteCommand({
      taskId: 'AISDLC-209',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: fakeRollback,
      logger: silentLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.pipeline?.outcome).toBe('aborted');
    // Rollback was invoked exactly once with the aborted dispatcher's
    // branch + worktree + the captured pre-dispatch status.
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]?.taskId).toBe('AISDLC-209');
    expect(rollbackCalls[0]?.fromStatus).toBe('To Do');
    expect(rollbackCalls[0]?.branch).toBe('ai-sdlc/aisdlc-209-aborted');
    expect(rollbackCalls[0]?.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-209'));
    expect(result.rollback?.statusReverted).toBe(true);
    expect(result.rollback?.worktreeRemoved).toBe(true);
  });

  it('invokes AISDLC-177 rollback on unknown-failure outcome (orchestrator-synthetic; lockstep guard)', async () => {
    // AISDLC-191: The `unknown-failure` outcome is synthetic — the umbrella's
    // `executePipeline()` never returns it directly (only the orchestrator's
    // catch-all branches in loop.ts manufacture it). But the umbrella's
    // membership check against `ROLLBACK_OUTCOMES` MUST still cover it so
    // the two surfaces stay in lockstep: a future refactor that wires
    // `executePipeline()` to surface `unknown-failure` for a brand-new
    // failure mode shouldn't silently regress the umbrella's rollback
    // coverage. The test injects an executor that returns the synthetic
    // outcome (cast through unknown to bypass `PipelineOutcome`'s narrower
    // union) to assert membership wins.
    writeTaskFile(tmp, { id: 'AISDLC-210', title: 'unknown failure', status: 'To Do' });

    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-210-unknown',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-210'),
        // Synthetic outcome — see test docblock.
        outcome: 'unknown-failure' as PipelineResult['outcome'],
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
      } as PipelineResult;
    };

    let rollbackInvoked = false;
    let rollbackArgs:
      | Parameters<typeof import('../orchestrator/rollback.js').rollbackDispatch>[0]
      | null = null;
    const result = await runExecuteCommand({
      taskId: 'AISDLC-210',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: async (args) => {
        rollbackInvoked = true;
        rollbackArgs = args;
        return {
          taskId: args.taskId,
          fromStatus: args.fromStatus,
          statusReverted: true,
          worktreeRemoved: true,
          branchQuarantined: false,
          warnings: [],
        };
      },
      logger: silentLogger(),
    });

    expect(rollbackInvoked).toBe(true);
    expect(rollbackArgs).not.toBeNull();
    expect(rollbackArgs!.taskId).toBe('AISDLC-210');
    expect(rollbackArgs!.fromStatus).toBe('To Do');
    expect(rollbackArgs!.branch).toBe('ai-sdlc/aisdlc-210-unknown');
    expect(result.ok).toBe(true);
    expect(result.rollback?.statusReverted).toBe(true);
  });

  it('does NOT invoke rollback on approved outcome', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-207', title: 'happy path', status: 'To Do' });
    let rollbackInvoked = false;
    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      if (pipelineOpts.onProgress) {
        await pipelineOpts.onProgress(1, approvedVerdict());
      }
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-207-x',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-207'),
        outcome: 'approved',
        prUrl: 'https://github.com/owner/repo/pull/3',
        siblingPrUrls: [],
        iterations: 1,
        finalVerdict: approvedVerdict(),
      };
    };
    const result = await runExecuteCommand({
      taskId: 'AISDLC-207',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: async () => {
        rollbackInvoked = true;
        throw new Error('rollback should not run on approved outcome');
      },
      logger: silentLogger(),
    });
    expect(rollbackInvoked).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.rollback).toBeUndefined();
  });

  it('survives a thrown rollback (non-fatal: dev-failed outcome still surfaces)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-208', title: 'rollback throws', status: 'To Do' });
    const fakeExec: typeof import('../execute-pipeline.js').executePipeline = async (
      pipelineOpts,
    ) => {
      return {
        taskId: pipelineOpts.taskId,
        branch: 'ai-sdlc/aisdlc-208-x',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-208'),
        outcome: 'developer-failed',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
      };
    };
    const result = await runExecuteCommand({
      taskId: 'AISDLC-208',
      workDir: tmp,
      spawnerKind: 'api-key',
      maxIterations: 2,
      dryRun: false,
      run: true,
      spawnerFactory: stubSpawnerFactory,
      executor: fakeExec,
      rollback: async () => {
        throw new Error('rollback boom');
      },
      logger: silentLogger(),
    });
    // Wrapper still returns ok=true with the dev-failed pipeline outcome —
    // rollback failure must not poison the envelope (operator's primary
    // signal is the developer-failed outcome itself).
    expect(result.ok).toBe(true);
    expect(result.pipeline?.outcome).toBe('developer-failed');
    expect(result.rollback).toBeUndefined();
  });
});

describe('CLI router integration — `execute` subcommand', () => {
  let savedArgv: string[];
  let savedExit: typeof process.exit;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let savedWrite: typeof process.stdout.write;
  let savedErrWrite: typeof process.stderr.write;
  let savedConsoleLog: typeof console.log;
  let savedConsoleError: typeof console.error;

  beforeEach(() => {
    savedArgv = process.argv;
    savedExit = process.exit;
    stdoutChunks = [];
    stderrChunks = [];
    savedWrite = process.stdout.write.bind(process.stdout);
    savedErrWrite = process.stderr.write.bind(process.stderr);
    savedConsoleLog = console.log;
    savedConsoleError = console.error;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    // yargs renders --help via console.log internally, which doesn't go
    // through process.stdout.write — wire it through too.
    console.log = (...args: unknown[]): void => {
      stdoutChunks.push(args.map(String).join(' ') + '\n');
    };
    console.error = (...args: unknown[]): void => {
      stderrChunks.push(args.map(String).join(' ') + '\n');
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
    process.stdout.write = savedWrite;
    process.stderr.write = savedErrWrite;
    console.log = savedConsoleLog;
    console.error = savedConsoleError;
  });

  it('is registered: `--help` lists the execute subcommand', async () => {
    process.argv = ['node', 'ai-sdlc-pipeline', '--help'];
    try {
      await buildCli().parseAsync();
    } catch (err) {
      expect((err as Error).message).toMatch(/process\.exit/);
    }
    // yargs --help text may go to stdout OR stderr depending on config —
    // the assertion is content, not channel.
    const all = stdoutChunks.join('') + stderrChunks.join('');
    expect(all).toMatch(/execute <task-id>/);
  });

  it('execute --help no longer advertises the dropped --skip-sweep flag', async () => {
    // Iteration-2 fix: `--skip-sweep` was inert (never threaded into
    // executePipeline) and violated the project's no-premature-abstraction
    // rule. Regression guard so a future re-introduction trips loudly.
    process.argv = ['node', 'ai-sdlc-pipeline', 'execute', '--help'];
    try {
      await buildCli().parseAsync();
    } catch (err) {
      expect((err as Error).message).toMatch(/process\.exit/);
    }
    const all = stdoutChunks.join('') + stderrChunks.join('');
    expect(all).not.toMatch(/--skip-sweep/);
    expect(all).not.toMatch(/skip[- ]sweep/i);
    expect(all).toMatch(/--run/);
    expect(all).toMatch(/d\s*efault when --run is omitted/);
  });

  it('default invocation emits a plan and leaves task/worktree state untouched', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-301', title: 'cli safe default', status: 'To Do' });
    const taskPath = join(tmp, 'backlog', 'tasks', 'aisdlc-301 - cli-safe-default.md');
    const before = readFileSync(taskPath, 'utf8');
    process.argv = ['node', 'ai-sdlc-pipeline', 'execute', 'AISDLC-301', '--work-dir', tmp];

    await buildCli().parseAsync();

    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    expect(parsed.ok).toBe(true);
    expect(parsed.planned?.taskId).toBe('AISDLC-301');
    expect(parsed.planned?.spawnerKind).toBe('mock');
    expect(parsed.pipeline).toBeUndefined();
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-301'))).toBe(false);
    expect(readFileSync(taskPath, 'utf8')).toBe(before);
  });

  it('dry-run path emits a plan envelope', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-300', title: 'cli dry run', status: 'To Do' });
    process.argv = [
      'node',
      'ai-sdlc-pipeline',
      'execute',
      'AISDLC-300',
      '--work-dir',
      tmp,
      '--spawner',
      'mock',
      '--dry-run',
    ];
    await buildCli().parseAsync();
    // Find the JSON envelope on stdout
    const out = stdoutChunks.join('');
    const json = out
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    expect(json).toBeTruthy();
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    expect(parsed.ok).toBe(true);
    expect(parsed.planned?.taskId).toBe('AISDLC-300');
    expect(parsed.planned?.spawnerKind).toBe('mock');
  });
});
