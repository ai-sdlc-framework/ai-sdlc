/**
 * Hermetic tests for the CI-failure watcher (AISDLC-460).
 *
 * All `gh` calls + agent spawns are stubbed. Covers:
 *   - Every classification shape (BEHIND, FAILURE-on-pr-ready, SUCCESS,
 *     DRAFT, no-checks-yet, IN_PROGRESS pr-ready).
 *   - N=2 concurrent-PR cap.
 *   - 24h cool-down respected.
 *   - Deduplicated PR comments (prefix predicate).
 *   - Loop honors `maxTicks` + sleep injection.
 *   - composeEscalationComment uses dedup prefix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, ExecResult } from './exec.js';
import {
  classifyPrFailureShape,
  composeEscalationComment,
  cooldownFilePath,
  defaultWorktreeResolver,
  isRebaseFixable,
  listActiveCooldowns,
  normalizePrSnapshot,
  PR_COMMENT_PREFIX,
  postDeduplicatedComment,
  readCooldown,
  runWatcherLoop,
  runWatcherTick,
  writeCooldown,
  COOLDOWN_MS,
  MAX_CONCURRENT_AGENTS_PER_TICK,
  type AgentReturn,
  type AgentSpawnerFn,
  type PrSnapshot,
  type WatcherTickResult,
} from './ci-failure-watcher.js';

// ── Test helpers ───────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ci-watcher-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePr(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 1,
    isDraft: false,
    mergeStateStatus: 'BLOCKED',
    headRefName: 'ai-sdlc/aisdlc-460-test',
    headRefOid: 'deadbeef',
    statusCheckRollup: [{ name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' }],
    ...overrides,
  };
}

/**
 * Mock runner — drives `gh pr list` + `gh pr view --json comments` +
 * `gh pr comment` based on a programmable script.
 */
interface RunnerScript {
  prList?: PrSnapshot[];
  /** Per-PR comments list returned by `gh pr view --json comments`. */
  commentsByPr?: Record<number, Array<{ body: string }>>;
  /** Capture of `gh pr comment` calls (prNumber → body). */
  commentsPosted: Array<{ prNumber: number; body: string }>;
  /** Force `gh pr list` to fail. */
  failPrList?: boolean;
  /** Force `gh pr comment` to fail. */
  failComment?: boolean;
}

function makeRunner(script: RunnerScript): Runner {
  return async (command, args): Promise<ExecResult> => {
    if (command !== 'gh') throw new Error(`unexpected command: ${command}`);
    if (args[0] === 'pr' && args[1] === 'list') {
      if (script.failPrList) {
        return { stdout: '', stderr: 'simulated gh failure', code: 1 };
      }
      // Round-trip through normalize so the test reflects the real
      // shape of the gh JSON the production code parses.
      const rawList = (script.prList ?? []).map((pr) => ({
        number: pr.number,
        isDraft: pr.isDraft,
        mergeStateStatus: pr.mergeStateStatus,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        statusCheckRollup: pr.statusCheckRollup,
      }));
      return { stdout: JSON.stringify(rawList), stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
      const prNumber = Number(args[2]);
      const comments = script.commentsByPr?.[prNumber] ?? [];
      return { stdout: JSON.stringify({ comments }), stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      if (script.failComment) {
        return { stdout: '', stderr: 'simulated comment failure', code: 1 };
      }
      const prNumber = Number(args[2]);
      const bodyIdx = args.indexOf('--body');
      const body = bodyIdx >= 0 ? args[bodyIdx + 1] : '';
      script.commentsPosted.push({ prNumber, body });
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };
}

function makeSpawner(perPrResult: Record<number, AgentReturn>): AgentSpawnerFn {
  return async ({ prNumber }) =>
    perPrResult[prNumber] ?? {
      prNumber,
      action: 'rebased',
      commitSha: 'abc1234',
      pushedBranch: 'feature',
    };
}

// ── classifyPrFailureShape ─────────────────────────────────────────────

describe('classifyPrFailureShape', () => {
  it('skips DRAFT PRs', () => {
    expect(classifyPrFailureShape(makePr({ isDraft: true }))).toBe('skip');
  });

  it('skips PRs with no checks yet', () => {
    expect(classifyPrFailureShape(makePr({ statusCheckRollup: [] }))).toBe('skip');
  });

  it('skips PRs where pr-ready is SUCCESS', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        }),
      ),
    ).toBe('skip');
  });

  it('skips PRs where pr-ready is still IN_PROGRESS', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          statusCheckRollup: [{ name: 'ai-sdlc/pr-ready', status: 'IN_PROGRESS', conclusion: '' }],
        }),
      ),
    ).toBe('skip');
  });

  it('classifies BEHIND-without-failure as behind-only', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          ],
        }),
      ),
    ).toBe('skip'); // NEUTRAL counts as success
  });

  it('classifies BEHIND with no pr-ready status as behind-only', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          mergeStateStatus: 'BEHIND',
          // Include some non-pr-ready check so the empty-rollup short-circuit doesn't fire.
          statusCheckRollup: [
            { name: 'codecov/patch', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        }),
      ),
    ).toBe('behind-only');
  });

  it('classifies pr-ready FAILURE as conflict-detected', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        }),
      ),
    ).toBe('conflict-detected');
  });

  it('classifies pr-ready ERROR as conflict-detected', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'ERROR' },
          ],
        }),
      ),
    ).toBe('conflict-detected');
  });

  it('classifies other check failures with no pr-ready info as unclassified', () => {
    expect(
      classifyPrFailureShape(
        makePr({
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'FAILURE' }],
        }),
      ),
    ).toBe('unclassified');
  });
});

describe('isRebaseFixable', () => {
  it.each(['conflict-detected', 'behind-only', 'pnpm-lock-regen', 'prettier-drift'])(
    'returns true for %s',
    (shape) => {
      expect(isRebaseFixable(shape as never)).toBe(true);
    },
  );
  it.each(['skip', 'unclassified', 'CHANGELOG-merge'])('returns false for %s', (shape) => {
    expect(isRebaseFixable(shape as never)).toBe(false);
  });
});

// ── cool-down state ────────────────────────────────────────────────────

describe('cool-down state', () => {
  it('returns null when no file exists', () => {
    expect(readCooldown(tmp, 999)).toBeNull();
  });

  it('round-trips a record', () => {
    writeCooldown(tmp, {
      prNumber: 42,
      classification: 'conflict-detected',
      escalatedAt: 1_000_000,
      reason: 'semantic-conflict',
    });
    const got = readCooldown(tmp, 42, 1_000_001);
    expect(got).not.toBeNull();
    expect(got?.classification).toBe('conflict-detected');
    expect(got?.reason).toBe('semantic-conflict');
  });

  it('expires after 24h', () => {
    const at = 1_000_000;
    writeCooldown(tmp, { prNumber: 7, classification: 'unclassified', escalatedAt: at });
    expect(readCooldown(tmp, 7, at + COOLDOWN_MS - 1)).not.toBeNull();
    expect(readCooldown(tmp, 7, at + COOLDOWN_MS)).toBeNull();
    expect(readCooldown(tmp, 7, at + COOLDOWN_MS + 10_000)).toBeNull();
  });

  it('returns null on malformed file', () => {
    const filePath = cooldownFilePath(tmp, 13);
    mkdirSync(join(tmp, '.ai-sdlc', 'ci-conflict-resolver', 'cooldown'), { recursive: true });
    writeFileSync(filePath, '{ not valid json');
    expect(readCooldown(tmp, 13)).toBeNull();
  });

  it('listActiveCooldowns skips expired + malformed', () => {
    const now = 5_000_000;
    writeCooldown(tmp, { prNumber: 1, classification: 'behind-only', escalatedAt: now - 100 });
    writeCooldown(tmp, {
      prNumber: 2,
      classification: 'conflict-detected',
      escalatedAt: now - COOLDOWN_MS - 1,
    });
    const malformedPath = cooldownFilePath(tmp, 3);
    writeFileSync(malformedPath, 'garbage');
    const active = listActiveCooldowns(tmp, now);
    expect(active.map((r) => r.prNumber).sort()).toEqual([1]);
  });
});

// ── normalizePrSnapshot ─────────────────────────────────────────────

describe('normalizePrSnapshot', () => {
  it('flattens gh CheckRun + StatusContext shapes', () => {
    const raw = {
      number: 99,
      isDraft: false,
      mergeStateStatus: 'BEHIND',
      headRefName: 'ai-sdlc/aisdlc-460-test',
      headRefOid: 'cafebabe',
      statusCheckRollup: [
        { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
        { context: 'codecov/patch', state: 'SUCCESS' }, // StatusContext shape
      ],
    };
    const got = normalizePrSnapshot(raw);
    expect(got.number).toBe(99);
    expect(got.statusCheckRollup).toHaveLength(2);
    expect(got.statusCheckRollup[0]).toEqual({
      name: 'ai-sdlc/pr-ready',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
    });
    expect(got.statusCheckRollup[1]).toEqual({
      name: 'codecov/patch',
      status: '',
      conclusion: 'SUCCESS',
    });
  });

  it('coerces missing fields to safe defaults', () => {
    const got = normalizePrSnapshot({});
    expect(got.number).toBe(0);
    expect(got.isDraft).toBe(false);
    expect(got.mergeStateStatus).toBe('');
    expect(got.statusCheckRollup).toEqual([]);
  });
});

// ── defaultWorktreeResolver ──────────────────────────────────────────

describe('defaultWorktreeResolver', () => {
  it('derives the .worktrees path from ai-sdlc/<task-id>-<slug>', () => {
    const resolver = defaultWorktreeResolver('/repo');
    expect(resolver(makePr({ headRefName: 'ai-sdlc/aisdlc-460-foo' }))).toBe(
      '/repo/.worktrees/aisdlc-460',
    );
  });

  it('handles hierarchical sub-IDs', () => {
    const resolver = defaultWorktreeResolver('/repo');
    expect(resolver(makePr({ headRefName: 'ai-sdlc/aisdlc-100.5-bar' }))).toBe(
      '/repo/.worktrees/aisdlc-100.5',
    );
  });

  it('falls back to a slash-substituted slug for non-canonical branches', () => {
    const resolver = defaultWorktreeResolver('/repo');
    expect(resolver(makePr({ headRefName: 'feat/random-branch' }))).toBe(
      '/repo/.worktrees/feat-random-branch',
    );
  });
});

// ── runWatcherTick ───────────────────────────────────────────────────

describe('runWatcherTick', () => {
  it('skips when no PRs are open', async () => {
    const script: RunnerScript = { prList: [], commentsPosted: [] };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: makeSpawner({}),
    });
    expect(result.scannedPrs).toBe(0);
    expect(result.dispatchedPrs).toEqual([]);
  });

  it('dispatches the agent for a behind-only PR', async () => {
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 100,
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'SUCCESS' }],
        }),
      ],
      commentsPosted: [],
    };
    const spawned: number[] = [];
    const spawner: AgentSpawnerFn = async ({ prNumber }) => {
      spawned.push(prNumber);
      return { prNumber, action: 'rebased', commitSha: 'sha', pushedBranch: 'b' };
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner,
    });
    expect(spawned).toEqual([100]);
    expect(result.dispatchedPrs).toEqual([100]);
    expect(result.rebased).toEqual([100]);
    expect(result.escalated).toEqual([]);
  });

  it('skips PRs with an active cool-down', async () => {
    const now = 1_000_000;
    writeCooldown(tmp, {
      prNumber: 200,
      classification: 'conflict-detected',
      escalatedAt: now - 1000,
    });
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 200,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        }),
      ],
      commentsPosted: [],
    };
    const spawned: number[] = [];
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => {
        spawned.push(prNumber);
        return { prNumber, action: 'rebased' };
      },
      now,
    });
    expect(spawned).toEqual([]);
    expect(result.skippedByCooldown).toEqual([200]);
    expect(result.dispatchedPrs).toEqual([]);
  });

  it('enforces N=2 concurrency cap', async () => {
    const prs = [301, 302, 303, 304].map((n) =>
      makePr({
        number: n,
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'SUCCESS' }],
      }),
    );
    const script: RunnerScript = { prList: prs, commentsPosted: [] };
    const spawned: number[] = [];
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => {
        spawned.push(prNumber);
        return { prNumber, action: 'rebased' };
      },
    });
    expect(MAX_CONCURRENT_AGENTS_PER_TICK).toBe(2);
    expect(result.candidatePrs).toHaveLength(4);
    expect(result.dispatchedPrs).toHaveLength(2);
    expect(spawned).toEqual([301, 302]);
  });

  it('respects maxConcurrentAgents override', async () => {
    const prs = [400, 401, 402].map((n) =>
      makePr({
        number: n,
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'SUCCESS' }],
      }),
    );
    const script: RunnerScript = { prList: prs, commentsPosted: [] };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => ({ prNumber, action: 'rebased' }),
      maxConcurrentAgents: 1,
    });
    expect(result.dispatchedPrs).toEqual([400]);
  });

  it('writes a cool-down record on escalation', async () => {
    const now = 5_000_000;
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 500,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        }),
      ],
      commentsPosted: [],
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => ({
        prNumber,
        action: 'escalated',
        escalationReason: 'semantic-conflict src/foo.ts',
        reclassifiedShape: 'semantic-conflict',
      }),
      now,
    });
    expect(result.escalated).toEqual([500]);
    expect(result.commentedPrs).toEqual([500]);
    const cd = readCooldown(tmp, 500, now + 1);
    expect(cd).not.toBeNull();
    expect(cd?.classification).toBe('semantic-conflict');
    expect(cd?.escalatedAt).toBe(now);
    expect(script.commentsPosted).toHaveLength(1);
    expect(script.commentsPosted[0].body.startsWith(PR_COMMENT_PREFIX)).toBe(true);
  });

  it('suppresses duplicate comment when last comment already matches prefix', async () => {
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 600,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        }),
      ],
      commentsByPr: {
        600: [
          { body: 'some earlier user comment' },
          {
            body: `${PR_COMMENT_PREFIX} failure shape 'conflict-detected' not auto-resolvable, operator review required (...)`,
          },
        ],
      },
      commentsPosted: [],
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => ({
        prNumber,
        action: 'escalated',
        escalationReason: 'iteration-cap-exceeded',
      }),
    });
    expect(result.commentedPrs).toEqual([]);
    expect(result.commentSuppressed).toEqual([600]);
    expect(script.commentsPosted).toHaveLength(0);
  });

  it('treats spawner throw as failed + writes cool-down', async () => {
    const now = 7_000_000;
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 700,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [
            { name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        }),
      ],
      commentsPosted: [],
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async () => {
        throw new Error('boom');
      },
      now,
    });
    expect(result.escalated).toEqual([700]);
    const cd = readCooldown(tmp, 700, now + 1);
    expect(cd).not.toBeNull();
    expect(cd?.reason?.startsWith('spawn-error')).toBe(true);
  });

  it('dry-run path (no spawner) records candidates but skips dispatch', async () => {
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 800,
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'SUCCESS' }],
        }),
      ],
      commentsPosted: [],
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
    });
    expect(result.candidatePrs).toEqual([800]);
    expect(result.dispatchedPrs).toEqual([]);
  });

  it('noop-already-up-to-date counts as rebased + no cool-down', async () => {
    const now = 8_000_000;
    const script: RunnerScript = {
      prList: [
        makePr({
          number: 900,
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [{ name: 'codecov/patch', conclusion: 'SUCCESS' }],
        }),
      ],
      commentsPosted: [],
    };
    const result = await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => ({ prNumber, action: 'noop-already-up-to-date' }),
      now,
    });
    expect(result.rebased).toEqual([900]);
    expect(readCooldown(tmp, 900, now + 1)).toBeNull();
  });
});

// ── postDeduplicatedComment ──────────────────────────────────────────

describe('postDeduplicatedComment', () => {
  it('posts when comment list is empty', async () => {
    const script: RunnerScript = {
      prList: [],
      commentsByPr: { 1: [] },
      commentsPosted: [],
    };
    const ok = await postDeduplicatedComment(
      makeRunner(script),
      undefined,
      1,
      'ai-sdlc/ci-conflict-resolver: x',
    );
    expect(ok).toBe(true);
    expect(script.commentsPosted).toHaveLength(1);
  });

  it('suppresses when last comment matches prefix', async () => {
    const script: RunnerScript = {
      prList: [],
      commentsByPr: { 1: [{ body: `${PR_COMMENT_PREFIX} prior` }] },
      commentsPosted: [],
    };
    const ok = await postDeduplicatedComment(
      makeRunner(script),
      undefined,
      1,
      'ai-sdlc/ci-conflict-resolver: new',
    );
    expect(ok).toBe(false);
    expect(script.commentsPosted).toHaveLength(0);
  });

  it('posts when intermediate comment is not the last', async () => {
    const script: RunnerScript = {
      prList: [],
      commentsByPr: {
        1: [{ body: `${PR_COMMENT_PREFIX} prior` }, { body: 'human reply' }],
      },
      commentsPosted: [],
    };
    const ok = await postDeduplicatedComment(
      makeRunner(script),
      undefined,
      1,
      `${PR_COMMENT_PREFIX} retry`,
    );
    expect(ok).toBe(true);
    expect(script.commentsPosted).toHaveLength(1);
  });

  it('returns false when gh pr comment exits non-zero', async () => {
    const script: RunnerScript = {
      prList: [],
      commentsByPr: { 1: [] },
      commentsPosted: [],
      failComment: true,
    };
    const ok = await postDeduplicatedComment(
      makeRunner(script),
      undefined,
      1,
      'ai-sdlc/ci-conflict-resolver: x',
    );
    expect(ok).toBe(false);
  });
});

// ── composeEscalationComment ─────────────────────────────────────────

describe('composeEscalationComment', () => {
  it('uses reclassified shape when present', () => {
    const out = composeEscalationComment(
      {
        prNumber: 1,
        action: 'escalated',
        escalationReason: 'foo',
        reclassifiedShape: 'modify-vs-delete',
      },
      'conflict-detected',
    );
    expect(out.startsWith(PR_COMMENT_PREFIX)).toBe(true);
    expect(out).toContain('modify-vs-delete');
    expect(out).toContain('foo');
  });

  it('falls back to watcher shape when reclassified is absent', () => {
    const out = composeEscalationComment(
      { prNumber: 1, action: 'failed', escalationReason: 'push-rejected' },
      'behind-only',
    );
    expect(out).toContain('behind-only');
    expect(out).toContain('push-rejected');
  });
});

// ── runWatcherLoop ───────────────────────────────────────────────────

describe('runWatcherLoop', () => {
  it('honors maxTicks and sleep injection', async () => {
    const script: RunnerScript = { prList: [], commentsPosted: [] };
    const sleeps: number[] = [];
    const tickResults: WatcherTickResult[] = [];
    const results = await runWatcherLoop({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: makeSpawner({}),
      maxTicks: 3,
      pollIntervalSec: 60,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      onTick: (r) => tickResults.push(r),
    });
    expect(results).toHaveLength(3);
    // sleep fires N-1 times — exits immediately after final tick.
    expect(sleeps).toEqual([60_000, 60_000]);
    expect(tickResults).toHaveLength(3);
  });

  it('survives a gh pr list failure on one tick when wrapped in try/catch by caller', async () => {
    // The loop does NOT swallow tick failures — caller decides. Verify
    // the throw propagates so daemon supervisors can restart.
    const script: RunnerScript = { prList: [], commentsPosted: [], failPrList: true };
    await expect(
      runWatcherLoop({
        workDir: tmp,
        runner: makeRunner(script),
        spawner: makeSpawner({}),
        maxTicks: 1,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow(/gh pr list failed/);
  });
});

// ── End-to-end integration: cool-down survives across ticks ─────────

describe('end-to-end cool-down behavior', () => {
  it('escalated tick → next tick skips, then 24h later re-attempts', async () => {
    const T0 = 10_000_000;
    const baselinePr = makePr({
      number: 1000,
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'ai-sdlc/pr-ready', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    const script: RunnerScript = { prList: [baselinePr], commentsPosted: [] };

    // Tick 1 — agent escalates
    let agentCalls = 0;
    await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => {
        agentCalls++;
        return { prNumber, action: 'escalated', escalationReason: 'modify-vs-delete' };
      },
      now: T0,
    });
    expect(agentCalls).toBe(1);
    expect(existsSync(cooldownFilePath(tmp, 1000))).toBe(true);

    // Tick 2 (1h later) — cool-down active, agent not invoked
    await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => {
        agentCalls++;
        return { prNumber, action: 'rebased' };
      },
      now: T0 + 60 * 60 * 1000,
    });
    expect(agentCalls).toBe(1);

    // Tick 3 (25h later) — cool-down expired, agent re-attempts
    await runWatcherTick({
      workDir: tmp,
      runner: makeRunner(script),
      spawner: async ({ prNumber }) => {
        agentCalls++;
        return { prNumber, action: 'rebased' };
      },
      now: T0 + 25 * 60 * 60 * 1000,
    });
    expect(agentCalls).toBe(2);
  });
});

// ── cool-down record JSON shape ─────────────────────────────────────

describe('cool-down JSON shape', () => {
  it('record on disk contains prNumber, classification, escalatedAt', () => {
    writeCooldown(tmp, {
      prNumber: 11,
      classification: 'conflict-detected',
      escalatedAt: 1_234_567,
      reason: 'semantic-conflict src/x.ts',
    });
    const filePath = cooldownFilePath(tmp, 11);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.prNumber).toBe(11);
    expect(parsed.classification).toBe('conflict-detected');
    expect(parsed.escalatedAt).toBe(1_234_567);
    expect(parsed.reason).toBe('semantic-conflict src/x.ts');
  });
});
