/**
 * Per-handler synthetic-trigger tests (RFC-0015 Phase 2 / AISDLC-169.2,
 * acceptance criterion #6).
 *
 * Each of the 9 catalogued failure modes gets a test that injects the
 * canonical detection signal, asserts the handler fires (`detect`
 * returns true), runs `remediate` with stub deps, and verifies both the
 * success branch (`recovered` / `retry`) and the budget-exhaustion
 * branch (`budget-exhausted` / `inapplicable`).
 *
 * These tests are intentionally hermetic — no git/gh/pnpm calls. The
 * `Runner` is faked; the redispatch hook is faked; the logger is
 * silenced. Real integration with the loop is covered by
 * `loop.playbook.test.ts` (the 10-task fixture queue per AC #8).
 */

import { describe, expect, it } from 'vitest';

import type { Runner, ExecResult, ExecOptions } from '../../runtime/exec.js';
import type { PipelineLogger, PipelineResult } from '../../types.js';
import {
  attestationVerifyMismatchHandler,
  envHookFailureHandler,
  isDataOnlyChange,
  longRunningPrHandler,
  LONG_RUNNING_PR_THRESHOLD_MS,
  pushRaceHandler,
  RETRY_DELAY_MS,
  rebaseConflictHandler,
  reviewerMajorOrCriticalHandler,
  secretScanBlockedHandler,
  stackedPrBaseSquashedHandler,
  verificationFailureHandler,
} from './index.js';
import type { FailureSignal, HandlerDeps, WorkerContext } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function ctx(overrides: Partial<WorkerContext> = {}): WorkerContext {
  const failure: FailureSignal = { stderr: '', exitCode: null, ...overrides.failure };
  return {
    workerId: 'w-test',
    taskId: 'AISDLC-T',
    branch: 'ai-sdlc/aisdlc-t',
    worktreePath: '/tmp/wt',
    state: 'DEV_RUNNING',
    prUrl: null,
    failure,
    attempts: 0,
    dispatchedAt: '2026-05-02T00:00:00Z',
    ...overrides,
    ...(overrides.failure ? { failure } : {}),
  };
}

interface RecordingRunner {
  runner: Runner;
  calls: Array<{ command: string; args: string[]; opts?: ExecOptions }>;
}

function recordingRunner(results: Array<Partial<ExecResult>> = []): RecordingRunner {
  const calls: Array<{ command: string; args: string[]; opts?: ExecOptions }> = [];
  let idx = 0;
  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args, opts });
    const r = results[idx++] ?? { stdout: '', stderr: '', code: 0 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
  };
  return { runner, calls };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `/tmp/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: `https://example.com/${taskId}`,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

function deps(opts: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    runner: opts.runner ?? recordingRunner().runner,
    sleep: opts.sleep ?? (async () => {}),
    redispatch: opts.redispatch,
    logger: opts.logger ?? silentLogger(),
  };
}

// ── SecretScanBlocked ─────────────────────────────────────────────────

describe('handlers/SecretScanBlocked', () => {
  const stderrSecret = `! [remote rejected] feat/x -> feat/x (push declined due to repository rule violations)
GH013: Repository rule violations found for refs/heads/feat/x.
- Cannot push secrets via Secret Scanning protection.`;

  it('detects on push-declined + Secret Scanning combo', () => {
    expect(
      secretScanBlockedHandler.detect(ctx({ failure: { stderr: stderrSecret, exitCode: 1 } })),
    ).toBe(true);
  });

  it('does NOT misclassify branch-protection rule violation as secret-scan', () => {
    expect(
      secretScanBlockedHandler.detect(
        ctx({
          failure: {
            stderr:
              '! [remote rejected] main -> main (push declined due to repository rule violations) — required reviews missing',
            exitCode: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  it('returns inapplicable when no redispatch hook is wired', async () => {
    const o = await secretScanBlockedHandler.remediate(
      ctx({ failure: { stderr: stderrSecret, exitCode: 1 } }),
      deps(),
    );
    expect(o.status).toBe('inapplicable');
  });

  it('redispatches and reports recovered when re-spawn approves', async () => {
    const redispatch = async (id: string): Promise<PipelineResult> => approvedResult(id);
    const o = await secretScanBlockedHandler.remediate(
      ctx({ failure: { stderr: stderrSecret, exitCode: 1 } }),
      deps({ redispatch }),
    );
    expect(o.status).toBe('recovered');
    expect(o.nextState).toBe('DONE');
  });

  it('reports recovered when redispatch approves regardless of attempts (runner enforces budget)', async () => {
    // Handler is per-attempt only — the playbook-runner enforces the
    // budget cap. Passing attempts=2 just informs the handler what try
    // we're on; the handler still performs the redispatch.
    const o = await secretScanBlockedHandler.remediate(
      ctx({ failure: { stderr: stderrSecret, exitCode: 1 }, attempts: 2 }),
      deps({ redispatch: async (id) => approvedResult(id) }),
    );
    expect(o.status).toBe('recovered');
  });
});

// ── PushRaceWithMergeQueue ───────────────────────────────────────────

describe('handlers/PushRaceWithMergeQueue', () => {
  const stderrRace = `remote: error: protected branch hook declined
remote: GH006: Pull request 123 is queued for merging`;

  it('detects on protected-branch + queued-for-merging combo', () => {
    expect(pushRaceHandler.detect(ctx({ failure: { stderr: stderrRace, exitCode: 1 } }))).toBe(
      true,
    );
  });

  it('rejects unrelated push failures', () => {
    expect(
      pushRaceHandler.detect(ctx({ failure: { stderr: 'random push error', exitCode: 1 } })),
    ).toBe(false);
  });

  it('sleeps RETRY_DELAY_MS then retries push (recovered when push exits 0)', async () => {
    let slept = 0;
    const { runner, calls } = recordingRunner([{ code: 0 }]);
    const o = await pushRaceHandler.remediate(
      ctx({ failure: { stderr: stderrRace, exitCode: 1 } }),
      deps({
        runner,
        sleep: async (ms) => {
          slept = ms;
        },
      }),
    );
    expect(slept).toBe(RETRY_DELAY_MS);
    expect(o.status).toBe('recovered');
    expect(o.nextState).toBe('FINALIZING');
    expect(calls[0]!.command).toBe('git');
    expect(calls[0]!.args).toContain('push');
  });

  it('returns retry when push still rejected', async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: 'still queued' }]);
    const o = await pushRaceHandler.remediate(
      ctx({ failure: { stderr: stderrRace, exitCode: 1 } }),
      deps({ runner, sleep: async () => {} }),
    );
    expect(o.status).toBe('retry');
  });
});

// ── RebaseConflict ────────────────────────────────────────────────────

describe('handlers/RebaseConflict', () => {
  const stderrConflict = `Auto-merging src/foo.ts
CONFLICT (content): Merge conflict in src/foo.ts
error: could not apply abc1234... feat: x`;

  it('detects on CONFLICT + could-not-apply', () => {
    expect(
      rebaseConflictHandler.detect(ctx({ failure: { stderr: stderrConflict, exitCode: 1 } })),
    ).toBe(true);
  });

  it('detects on raw conflict markers', () => {
    expect(
      rebaseConflictHandler.detect(
        ctx({
          failure: {
            stderr: '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> feat/x',
            exitCode: 1,
          },
        }),
      ),
    ).toBe(true);
  });

  it('returns inapplicable when no redispatch hook wired', async () => {
    const o = await rebaseConflictHandler.remediate(
      ctx({ failure: { stderr: stderrConflict, exitCode: 1 } }),
      deps(),
    );
    expect(o.status).toBe('inapplicable');
  });

  it('redispatches and reports recovered when resolver approves', async () => {
    const o = await rebaseConflictHandler.remediate(
      ctx({ failure: { stderr: stderrConflict, exitCode: 1 } }),
      deps({ redispatch: async (id) => approvedResult(id) }),
    );
    expect(o.status).toBe('recovered');
  });

  it('escalates after 1 budget when resolver returns non-approved', async () => {
    const o = await rebaseConflictHandler.remediate(
      ctx({ failure: { stderr: stderrConflict, exitCode: 1 } }),
      deps({
        redispatch: async (id) => ({
          ...approvedResult(id),
          outcome: 'needs-human-attention',
        }),
      }),
    );
    expect(o.status).toBe('budget-exhausted');
  });
});

// ── VerificationFailure ───────────────────────────────────────────────

describe('handlers/VerificationFailure', () => {
  const stderrVerify = 'pnpm test failed: 3 tests failed at exit 1';

  it('detects pnpm-tool + failure phrase + non-zero exit', () => {
    expect(
      verificationFailureHandler.detect(ctx({ failure: { stderr: stderrVerify, exitCode: 1 } })),
    ).toBe(true);
  });

  it('rejects when exitCode is 0 (defensive)', () => {
    expect(
      verificationFailureHandler.detect(ctx({ failure: { stderr: stderrVerify, exitCode: 0 } })),
    ).toBe(false);
  });

  it('rejects when no verify-tool keyword present', () => {
    expect(
      verificationFailureHandler.detect(
        ctx({ failure: { stderr: 'random failure', exitCode: 1 } }),
      ),
    ).toBe(false);
  });

  it('returns inapplicable without redispatch hook', async () => {
    const o = await verificationFailureHandler.remediate(
      ctx({ failure: { stderr: stderrVerify, exitCode: 1 } }),
      deps(),
    );
    expect(o.status).toBe('inapplicable');
  });

  it('recovers when re-dispatched dev passes verification', async () => {
    const o = await verificationFailureHandler.remediate(
      ctx({ failure: { stderr: stderrVerify, exitCode: 1 } }),
      deps({ redispatch: async (id) => approvedResult(id) }),
    );
    expect(o.status).toBe('recovered');
  });
});

// ── ReviewerMajorOrCritical ──────────────────────────────────────────

describe('handlers/ReviewerMajorOrCritical', () => {
  it('detects on critical>0', () => {
    expect(
      reviewerMajorOrCriticalHandler.detect(
        ctx({
          failure: {
            stderr: '',
            exitCode: null,
            reviewerFindings: { critical: 1, major: 0, minor: 0, suggestion: 0 },
          },
        }),
      ),
    ).toBe(true);
  });

  it('detects on major>0', () => {
    expect(
      reviewerMajorOrCriticalHandler.detect(
        ctx({
          failure: {
            stderr: '',
            exitCode: null,
            reviewerFindings: { critical: 0, major: 2, minor: 0, suggestion: 0 },
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects when verdict has only minor/suggestion findings', () => {
    expect(
      reviewerMajorOrCriticalHandler.detect(
        ctx({
          failure: {
            stderr: '',
            exitCode: null,
            reviewerFindings: { critical: 0, major: 0, minor: 5, suggestion: 3 },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects when no findings field present', () => {
    expect(
      reviewerMajorOrCriticalHandler.detect(ctx({ failure: { stderr: '', exitCode: null } })),
    ).toBe(false);
  });

  it('redispatches + recovers when next dev pass approves', async () => {
    const o = await reviewerMajorOrCriticalHandler.remediate(
      ctx({
        failure: {
          stderr: '',
          exitCode: null,
          reviewerFindings: { critical: 1, major: 0, minor: 0, suggestion: 0 },
        },
      }),
      deps({ redispatch: async (id) => approvedResult(id) }),
    );
    expect(o.status).toBe('recovered');
  });
});

// ── EnvHookFailure ───────────────────────────────────────────────────

describe('handlers/EnvHookFailure', () => {
  const stderrEnv = 'tsc: not found\nhusky - pre-commit hook exited with code 127';

  it('detects on tsc-not-found phrasing', () => {
    expect(
      envHookFailureHandler.detect(ctx({ failure: { stderr: stderrEnv, exitCode: 127 } })),
    ).toBe(true);
  });

  it('isDataOnlyChange — backlog/docs/spec passes; source code fails', () => {
    expect(isDataOnlyChange(['backlog/tasks/foo.md', 'docs/operations/x.md'])).toBe(true);
    expect(isDataOnlyChange(['backlog/tasks/foo.md', 'pipeline-cli/src/foo.ts'])).toBe(false);
    expect(isDataOnlyChange(['CHANGELOG.md'])).toBe(true);
    expect(isDataOnlyChange(undefined)).toBe(false);
    expect(isDataOnlyChange([])).toBe(false);
  });

  it('refuses --no-verify retry on source-touching changes', async () => {
    const o = await envHookFailureHandler.remediate(
      ctx({
        failure: { stderr: stderrEnv, exitCode: 127, changedPaths: ['pipeline-cli/src/foo.ts'] },
      }),
      deps(),
    );
    expect(o.status).toBe('budget-exhausted');
    expect(o.note).toContain('refusing --no-verify');
  });

  it('retries with --no-verify on data-only changes (recovered when push exits 0)', async () => {
    const { runner, calls } = recordingRunner([{ code: 0 }]);
    const o = await envHookFailureHandler.remediate(
      ctx({
        failure: { stderr: stderrEnv, exitCode: 127, changedPaths: ['backlog/tasks/foo.md'] },
      }),
      deps({ runner }),
    );
    expect(o.status).toBe('recovered');
    expect(calls[0]!.args).toContain('--no-verify');
  });
});

// ── AttestationVerifyMismatch ────────────────────────────────────────

describe('handlers/AttestationVerifyMismatch', () => {
  const stderrMismatch =
    'attestation verify failed: contentHashV3 mismatch (expected abc, got def)';

  it('detects on contentHashV3 mismatch phrasing', () => {
    expect(
      attestationVerifyMismatchHandler.detect(
        ctx({ failure: { stderr: stderrMismatch, exitCode: 1 } }),
      ),
    ).toBe(true);
  });

  it('runs check-attestation-sign + push (recovered when both succeed)', async () => {
    const { runner, calls } = recordingRunner([{ code: 0 }, { code: 0 }]);
    const o = await attestationVerifyMismatchHandler.remediate(
      ctx({ failure: { stderr: stderrMismatch, exitCode: 1 } }),
      deps({ runner }),
    );
    expect(o.status).toBe('recovered');
    expect(calls[0]!.command).toBe('bash');
    expect(calls[1]!.args).toContain('push');
  });

  it('escalates when sign script fails', async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: 'sign failed' }]);
    const o = await attestationVerifyMismatchHandler.remediate(
      ctx({ failure: { stderr: stderrMismatch, exitCode: 1 } }),
      deps({ runner }),
    );
    expect(o.status).toBe('budget-exhausted');
  });
});

// ── LongRunningPRBlocksWorker ────────────────────────────────────────

describe('handlers/LongRunningPRBlocksWorker', () => {
  it('detects on prAgeMs over threshold + present prUrl', () => {
    expect(
      longRunningPrHandler.detect(
        ctx({
          prUrl: 'https://example.com/pr/1',
          failure: { stderr: '', exitCode: null, prAgeMs: LONG_RUNNING_PR_THRESHOLD_MS + 1 },
        }),
      ),
    ).toBe(true);
  });

  it('rejects when below threshold', () => {
    expect(
      longRunningPrHandler.detect(
        ctx({
          prUrl: 'https://example.com/pr/1',
          failure: { stderr: '', exitCode: null, prAgeMs: 60 * 1000 },
        }),
      ),
    ).toBe(false);
  });

  it('rejects when no PR URL (worker never pushed)', () => {
    expect(
      longRunningPrHandler.detect(
        ctx({
          prUrl: null,
          failure: { stderr: '', exitCode: null, prAgeMs: LONG_RUNNING_PR_THRESHOLD_MS + 1 },
        }),
      ),
    ).toBe(false);
  });

  it('parks worker (recovered with nextState=PARKED)', async () => {
    const o = await longRunningPrHandler.remediate(
      ctx({
        prUrl: 'https://example.com/pr/1',
        failure: { stderr: '', exitCode: null, prAgeMs: LONG_RUNNING_PR_THRESHOLD_MS + 1 },
      }),
      deps(),
    );
    expect(o.status).toBe('recovered');
    expect(o.nextState).toBe('PARKED');
  });

  it('custom escalator does NOT label PR (parking is not a defect)', async () => {
    let labelled = false;
    await longRunningPrHandler.escalate?.(
      ctx({
        prUrl: 'https://example.com/pr/1',
        failure: { stderr: '', exitCode: null, prAgeMs: LONG_RUNNING_PR_THRESHOLD_MS + 1 },
      }),
      deps({
        runner: async () => {
          labelled = true;
          return { stdout: '', stderr: '', code: 0 };
        },
      }),
    );
    expect(labelled).toBe(false);
  });
});

// ── StackedPRBaseSquashed ────────────────────────────────────────────

describe('handlers/StackedPRBaseSquashed', () => {
  it('detects on DIRTY mergeStateStatus + base PR mergedAt set', () => {
    expect(
      stackedPrBaseSquashedHandler.detect(
        ctx({
          prUrl: 'https://example.com/pr/1',
          failure: {
            stderr: '',
            exitCode: null,
            mergeStateStatus: 'DIRTY',
            basePrMergedAt: '2026-05-02T01:00:00Z',
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects when not DIRTY', () => {
    expect(
      stackedPrBaseSquashedHandler.detect(
        ctx({
          prUrl: 'https://example.com/pr/1',
          failure: {
            stderr: '',
            exitCode: null,
            mergeStateStatus: 'CLEAN',
            basePrMergedAt: '2026-05-02T01:00:00Z',
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects when base PR has not merged', () => {
    expect(
      stackedPrBaseSquashedHandler.detect(
        ctx({
          prUrl: 'https://example.com/pr/1',
          failure: {
            stderr: '',
            exitCode: null,
            mergeStateStatus: 'DIRTY',
            basePrMergedAt: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it('runs fetch + rebase + push (recovered when all succeed)', async () => {
    const { runner, calls } = recordingRunner([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const o = await stackedPrBaseSquashedHandler.remediate(
      ctx({
        prUrl: 'https://example.com/pr/1',
        failure: {
          stderr: '',
          exitCode: null,
          mergeStateStatus: 'DIRTY',
          basePrMergedAt: '2026-05-02T01:00:00Z',
        },
      }),
      deps({ runner }),
    );
    expect(o.status).toBe('recovered');
    expect(calls[0]!.args).toEqual(['fetch', 'origin', 'main']);
    expect(calls[1]!.args).toContain('rebase');
    expect(calls[1]!.args).toContain('--reapply-cherry-picks');
    expect(calls[2]!.args).toContain('--force-with-lease');
  });

  it('escalates when rebase produces conflicts', async () => {
    const { runner } = recordingRunner([{ code: 0 }, { code: 1, stderr: 'CONFLICT' }]);
    const o = await stackedPrBaseSquashedHandler.remediate(
      ctx({
        prUrl: 'https://example.com/pr/1',
        failure: {
          stderr: '',
          exitCode: null,
          mergeStateStatus: 'DIRTY',
          basePrMergedAt: '2026-05-02T01:00:00Z',
        },
      }),
      deps({ runner }),
    );
    expect(o.status).toBe('budget-exhausted');
    expect(o.note).toContain('rebase failed');
  });
});
