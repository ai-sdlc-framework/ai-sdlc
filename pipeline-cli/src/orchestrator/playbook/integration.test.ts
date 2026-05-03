/**
 * Phase 2 acceptance fixture (RFC-0015 §11 Phase 2 + AISDLC-169.2 AC #8).
 *
 * Runs a 10-task fixture queue through `runPlaybook` directly: 8 tasks
 * inject one of the catalogued failure modes (each handler gets the
 * canonical signal that should let it recover) + 2 normal tasks. The
 * acceptance bar is "≥9 of 10 complete autonomously (90% recovery rate)"
 * per the RFC's §11 Phase 2 promise.
 *
 * The integration runs the playbook ONLY — not the full orchestrator
 * loop — so the test stays hermetic (no git/gh/pnpm). The full loop
 * integration is covered by `loop.playbook.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { PipelineLogger, PipelineResult } from '../../types.js';
import {
  DEFAULT_CATALOGUE,
  WorkerStateTracker,
  runPlaybook,
  LONG_RUNNING_PR_THRESHOLD_MS,
} from './index.js';
import type { FailureSignal, HandlerDeps, WorkerContext } from './types.js';

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `/tmp/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: `https://example.com/pr/${taskId}`,
    siblingPrUrls: [],
    iterations: 2,
    finalVerdict: null,
  };
}

interface FixtureCase {
  taskId: string;
  failure: FailureSignal;
  prUrl: string | null;
  /** Expected outcome — `recovered` for the 8 mode-handlers + the 2 normal tasks. */
  expected: 'recovered' | 'escalated' | 'unknown';
}

const FIXTURE: FixtureCase[] = [
  // The 9 catalogued modes — each gets a synthetic trigger that lets the
  // handler recover (the all-success scenario the AC measures).
  {
    taskId: 'AISDLC-SECRET',
    failure: {
      stderr: 'push declined due to repository rule violations\nSecret Scanning detected',
      exitCode: 1,
    },
    prUrl: null,
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-PUSHRACE',
    failure: {
      stderr: 'protected branch hook declined\nGH006: queued for merging',
      exitCode: 1,
    },
    prUrl: 'https://example.com/pr/PUSHRACE',
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-STACKED',
    failure: {
      stderr: '',
      exitCode: null,
      mergeStateStatus: 'DIRTY',
      basePrMergedAt: '2026-05-02T01:00:00Z',
    },
    prUrl: 'https://example.com/pr/STACKED',
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-REBASE',
    failure: {
      stderr: 'CONFLICT (content): Merge conflict in src/foo.ts\ncould not apply abc123',
      exitCode: 1,
    },
    prUrl: null,
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-VERIFY',
    failure: { stderr: 'pnpm test failed at exit 1', exitCode: 1 },
    prUrl: null,
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-REVIEW',
    failure: {
      stderr: '',
      exitCode: null,
      reviewerFindings: { critical: 0, major: 1, minor: 0, suggestion: 0 },
    },
    prUrl: null,
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-ENVHOOK',
    failure: {
      stderr: 'tsc: not found\nhusky pre-commit failed',
      exitCode: 127,
      changedPaths: ['backlog/tasks/foo.md', 'docs/x.md'],
    },
    prUrl: null,
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-ATTEST',
    failure: { stderr: 'attestation verify failed: contentHashV3 mismatch', exitCode: 1 },
    prUrl: 'https://example.com/pr/ATTEST',
    expected: 'recovered',
  },
  {
    taskId: 'AISDLC-LONGPR',
    failure: {
      stderr: '',
      exitCode: null,
      prAgeMs: LONG_RUNNING_PR_THRESHOLD_MS + 60_000,
    },
    prUrl: 'https://example.com/pr/LONGPR',
    expected: 'recovered',
  },
  // 1 task that intentionally escapes the catalogue → unknown fall-through
  // (counts as the "remaining 10% escalates cleanly" half of the AC).
  {
    taskId: 'AISDLC-UNKNOWN',
    failure: { stderr: 'sandbox spectre v999: completely novel failure shape', exitCode: 99 },
    prUrl: null,
    expected: 'unknown',
  },
];

describe('Playbook acceptance fixture (10 tasks, AC #8)', () => {
  it('recovers ≥9 of 10 autonomously; remaining cases escalate cleanly', async () => {
    const deps: HandlerDeps = {
      runner: async (cmd, args) => {
        // All git/bash invocations succeed in the fixture so each
        // handler's mechanical retry returns code 0.
        if (cmd === 'git' || cmd === 'bash' || cmd === 'gh') {
          return { stdout: '', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: `unmocked: ${cmd} ${args.join(' ')}`, code: 1 };
      },
      sleep: async () => {},
      logger: silentLogger(),
      // Redispatch hook always returns approved — simulates the dev fixing
      // the issue on the second try.
      redispatch: async (id) => approvedResult(id),
    };

    const results = [];
    for (const c of FIXTURE) {
      const ctx: WorkerContext = {
        workerId: `w-${c.taskId.toLowerCase()}`,
        taskId: c.taskId,
        branch: `ai-sdlc/${c.taskId.toLowerCase()}`,
        worktreePath: '/tmp',
        state: 'DEV_RUNNING',
        prUrl: c.prUrl,
        failure: c.failure,
        attempts: 0,
        dispatchedAt: '2026-05-02T00:00:00Z',
      };
      const state = new WorkerStateTracker({
        workerId: ctx.workerId,
        taskId: ctx.taskId,
        branch: ctx.branch,
        worktreePath: ctx.worktreePath,
        inMemoryOnly: true,
      });
      const r = await runPlaybook(ctx, {
        catalogue: DEFAULT_CATALOGUE,
        deps,
        state,
        escalate: async () => {},
      });
      results.push({
        taskId: c.taskId,
        expected: c.expected,
        actual: r.outcome,
        mode: r.matchedMode,
      });
    }

    // The AC bar: ≥90% recovered. With 10 tasks that's ≥9 recovered.
    const recovered = results.filter((r) => r.actual === 'recovered');
    const recoveredPct = (recovered.length / results.length) * 100;
    expect(recoveredPct).toBeGreaterThanOrEqual(90);

    // Every result must match its expectation (no silent miscategorisation).
    for (const r of results) {
      expect(r.actual, `task=${r.taskId} mode=${r.mode ?? 'none'}`).toBe(r.expected);
    }

    // The 1 unknown case MUST surface as outcome=unknown (the runner did
    // NOT mistakenly route it to a catalogued handler — that's the §13
    // Q8 invariant the AC #5 wiring relies on).
    const unknown = results.find((r) => r.taskId === 'AISDLC-UNKNOWN');
    expect(unknown?.actual).toBe('unknown');
  });
});
