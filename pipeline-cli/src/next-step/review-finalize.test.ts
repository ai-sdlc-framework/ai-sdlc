import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import { makeHarness, makeState, type Harness } from '../__test-helpers/next-step-fixtures.js';
import {
  aggregateRound,
  approvedWithoutReviewers,
  finalizeReview,
  parseReviewReports,
  resolveAgentIdFromMarkers,
  type ReviewerReport,
} from './review-finalize.js';
import type { NextStepState, ReviewRoundState, SpawnedReviewer } from './types.js';

let h: Harness;
let state: NextStepState;

const spawned = (
  agent: string,
  reviewer: SpawnedReviewer['reviewer'],
  harness: 'codex' | 'claude-code',
) =>
  ({
    agent,
    reviewer,
    harness,
    leafModel: `${agent}-model`,
    promptFile: `/p/${agent}.md`,
  }) satisfies SpawnedReviewer;

function review(over: Partial<ReviewRoundState> = {}): ReviewRoundState {
  return {
    round: 1,
    spawned: [
      spawned('code-reviewer-codex', 'code-reviewer', 'codex'),
      spawned('test-reviewer-codex', 'test-reviewer', 'codex'),
      spawned('security-reviewer', 'security-reviewer', 'claude-code'),
    ],
    autoApproved: [],
    headSha: 'headsha',
    nonce: 'nonce-1',
    harnessNote: '',
    classifier: { reviewers: ['testing', 'critic', 'security'], confidence: 1, fellOpen: false },
    incremental: {
      reason: 'no-marker',
      skip: false,
      deltaOnly: false,
      deltaSize: 0,
      lastReviewedSha: null,
      contentHash: 'h',
    },
    ...over,
  };
}

const approvals = (): ReviewerReport[] =>
  ['code-reviewer-codex', 'test-reviewer-codex', 'security-reviewer'].map((agent, i) => ({
    agent,
    agentId: `agent-${i}`,
    approved: true,
    findings: [],
    summary: 'fine',
  }));

/** Pretend the persist helper wrote transcript + verdict for every reviewer. */
function markPersisted(): void {
  const dir = join(state.worktreePath, '.ai-sdlc');
  for (const a of ['code-reviewer-codex', 'test-reviewer-codex', 'security-reviewer']) {
    h.present.add(join(dir, 'transcripts', 'aisdlc-900', `${a}.jsonl`));
    h.present.add(join(dir, 'verdicts', `${a}-aisdlc-900.json`));
  }
}

beforeEach(() => {
  h = makeHarness();
  state = makeState(h.root, { review: review(), iteration: 2 });
});
afterEach(() => h.cleanup());

describe('parseReviewReports', () => {
  it('accepts {reviewers:[...]}', () => {
    const r = parseReviewReports(
      JSON.stringify({
        reviewers: [
          {
            agent: 'security-reviewer',
            agentId: 'a1',
            approved: false,
            findings: [{ severity: 'major', message: 'm', file: 'f.ts', line: 3 }],
            summary: 's',
          },
        ],
      }),
    );
    expect(r).toEqual([
      {
        agent: 'security-reviewer',
        agentId: 'a1',
        approved: false,
        findings: [{ severity: 'major', message: 'm', file: 'f.ts', line: 3 }],
        summary: 's',
      },
    ]);
  });

  it('accepts a bare array, an object keyed by agent, and a nested verdict', () => {
    expect(parseReviewReports('[{"agent":"a","approved":true}]')).toHaveLength(1);
    const keyed = parseReviewReports(
      JSON.stringify({
        'code-reviewer': { agentId: 'x', verdict: { approved: true, findings: [] } },
      }),
    );
    expect(keyed).toEqual([{ agent: 'code-reviewer', agentId: 'x', approved: true, findings: [] }]);
  });

  it('coerces an unknown severity to suggestion and drops entries with no agent', () => {
    const r = parseReviewReports(
      JSON.stringify([
        { agent: 'a', approved: true, findings: [{ severity: 'weird', message: 'x' }] },
        { approved: true },
      ]),
    );
    expect(r).toHaveLength(1);
    expect(r[0].findings?.[0].severity).toBe('suggestion');
  });

  it('only a literal true approves', () => {
    expect(parseReviewReports('[{"agent":"a","approved":"true"}]')[0].approved).toBe(false);
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseReviewReports('LGTM')).toThrow();
  });
});

describe('resolveAgentIdFromMarkers', () => {
  const marker = (root: string, id: string, agentType: string): void => {
    const dir = join(root, '.ai-sdlc', 'subagent-sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ agentId: id, agentType }));
  };

  it('returns the single matching id, comparing on the bare role', () => {
    marker(state.worktreePath, 'abc', 'ai-sdlc:security-reviewer');
    marker(state.worktreePath, 'def', 'code-reviewer');
    expect(resolveAgentIdFromMarkers(state.worktreePath, 'security-reviewer')).toBe('abc');
  });

  it('refuses to guess when two runs of the same role exist', () => {
    marker(state.worktreePath, 'abc', 'security-reviewer');
    marker(state.worktreePath, 'def', 'security-reviewer');
    expect(resolveAgentIdFromMarkers(state.worktreePath, 'security-reviewer')).toBeNull();
  });

  it('returns null with no markers', () => {
    expect(resolveAgentIdFromMarkers(state.worktreePath, 'security-reviewer')).toBeNull();
  });
});

describe('finalizeReview', () => {
  it('persists, emits one leaf per reviewer and approves', async () => {
    markPersisted();
    const res = await finalizeReview(h.ctx, state, approvals());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.decision).toBe('APPROVED');
    expect(res.verdict.verdicts.map((v) => v.agentId)).toEqual([
      'code-reviewer-codex',
      'test-reviewer-codex',
      'security-reviewer',
    ]);

    const persist = h.runner.calls.filter((c) =>
      c.args[0]?.endsWith('persist-reviewer-artifacts.sh'),
    );
    expect(persist).toHaveLength(3);
    expect(persist[0].args).toEqual(
      expect.arrayContaining([
        '--worktree',
        state.worktreePath,
        '--task-id',
        'AISDLC-900',
        '--reviewer',
        'code-reviewer-codex',
        '--agent-id',
        'agent-0',
      ]),
    );

    const leaves = h.runner.calls.filter((c) => c.args.includes('emit-leaf'));
    expect(leaves).toHaveLength(3);
    const codeLeaf = leaves[0].args;
    const val = (flag: string): string => codeLeaf[codeLeaf.indexOf(flag) + 1];
    expect(val('--harness')).toBe('codex');
    expect(val('--model')).toBe('code-reviewer-codex-model');
    expect(val('--nonce')).toBe('nonce-1');
    expect(val('--iteration')).toBe('2');
    expect(val('--head-sha')).toBe('headsha');
    expect(val('--task-id')).toBe('AISDLC-900');
    expect(val('--transcript-path')).toBe(
      join(
        state.worktreePath,
        '.ai-sdlc',
        'transcripts',
        'aisdlc-900',
        'code-reviewer-codex.jsonl',
      ),
    );
  });

  it('requests changes when a reviewer reports a critical finding', async () => {
    markPersisted();
    const reports = approvals();
    reports[2] = {
      ...reports[2],
      approved: false,
      findings: [{ severity: 'critical', message: 'sqli' }],
    };
    const res = await finalizeReview(h.ctx, state, reports);
    expect(res.ok && res.verdict.decision).toBe('CHANGES_REQUESTED');
    if (res.ok) expect(res.verdict.counts.critical).toBe(1);
  });

  it('fails the gate for a reviewer that never reported', async () => {
    markPersisted();
    const res = await finalizeReview(h.ctx, state, approvals().slice(0, 2));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.decision).toBe('CHANGES_REQUESTED');
    const missing = res.verdict.verdicts.find((v) => v.agentId === 'security-reviewer')!;
    expect(missing.approved).toBe(false);
    expect(missing.findings[0].message).toMatch(/returned no verdict/);
  });

  it('matches a report by role name as well as agent name', async () => {
    markPersisted();
    const reports = approvals().map((r) => ({ ...r, agent: r.agent.replace('-codex', '') }));
    const res = await finalizeReview(h.ctx, state, reports);
    expect(res.ok && res.verdict.decision).toBe('APPROVED');
  });

  it('refuses without a harness agent id, recoverably and before persisting anything', async () => {
    const reports = approvals().map(({ agentId: _id, ...rest }) => rest);
    const res = await finalizeReview(h.ctx, state, reports);
    expect(res).toEqual({
      ok: false,
      recoverable: true,
      reason: expect.stringContaining('no harness agent id'),
    });
    // Nothing was persisted or emitted, so a corrected report can simply be re-sent.
    expect(h.runner.calls).toHaveLength(0);
  });

  it('checks every reviewer id up front: one missing id persists nothing for the others', async () => {
    const reports = approvals();
    delete reports[2].agentId;
    const res = await finalizeReview(h.ctx, state, reports);
    expect(res.ok).toBe(false);
    expect(h.runner.calls).toHaveLength(0);
  });

  it('recovers a missing agent id from the SubagentStart marker', async () => {
    markPersisted();
    const dir = join(state.worktreePath, '.ai-sdlc', 'subagent-sessions');
    mkdirSync(dir, { recursive: true });
    for (const a of ['code-reviewer-codex', 'test-reviewer-codex', 'security-reviewer']) {
      writeFileSync(
        join(dir, `id-${a}.json`),
        JSON.stringify({ agentId: `id-${a}`, agentType: a }),
      );
    }
    const reports = approvals().map(({ agentId: _id, ...rest }) => rest);
    const res = await finalizeReview(h.ctx, state, reports);
    expect(res.ok).toBe(true);
    const persist = h.runner.calls.find((c) =>
      c.args[0]?.endsWith('persist-reviewer-artifacts.sh'),
    )!;
    expect(persist.args).toContain('id-code-reviewer-codex');
  });

  it('aborts when persistence fails (a real failure, not a skip)', async () => {
    h.runner.on(/persist-reviewer-artifacts\.sh/, fail('no transcript for agent', 1));
    const res = await finalizeReview(h.ctx, state, approvals());
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining('persist-reviewer-artifacts failed'),
    });
  });

  it('warns (and skips the leaf) when emit-leaf fails or files are missing', async () => {
    markPersisted();
    h.runner.on(/emit-leaf/, fail('boom', 1));
    const res = await finalizeReview(h.ctx, state, approvals());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings.filter((w) => w.includes('emit-leaf'))).toHaveLength(3);

    const h2 = makeHarness();
    const s2 = makeState(h2.root, { review: review() });
    const res2 = await finalizeReview(h2.ctx, s2, approvals());
    expect(res2.ok).toBe(true);
    if (res2.ok)
      expect(res2.warnings.filter((w) => w.includes('transcript or verdict missing'))).toHaveLength(
        3,
      );
    expect(h2.runner.calls.some((c) => c.args.includes('emit-leaf'))).toBe(false);
    h2.cleanup();
  });

  it('errors without a review round in state', async () => {
    const res = await finalizeReview(h.ctx, { ...state, review: null }, []);
    expect(res.ok).toBe(false);
  });

  it('writes a scratch verdict file the persist helper can read', async () => {
    markPersisted();
    h.runner.on(/persist-reviewer-artifacts\.sh/, ok(''));
    await finalizeReview(h.ctx, state, approvals());
    const persist = h.runner.calls.find((c) =>
      c.args[0]?.endsWith('persist-reviewer-artifacts.sh'),
    )!;
    expect(persist.args[persist.args.indexOf('--verdict-file') + 1]).toContain(h.ctx.filesDir);
  });
});

describe('aggregateRound', () => {
  it('approves an empty selection with zero findings instead of rejecting it', async () => {
    const v = await aggregateRound([], 'note');
    expect(v).toEqual(approvedWithoutReviewers('note'));
    expect(v.decision).toBe('APPROVED');
    expect(v.counts).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 });
  });

  it('delegates to the aggregator otherwise', async () => {
    const v = await aggregateRound(
      [{ agentId: 'a', harness: 'claude-code', approved: true, findings: [] }],
      '',
    );
    expect(v.decision).toBe('APPROVED');
  });
});
