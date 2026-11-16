import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, makeTask, type Harness } from '../__test-helpers/next-step-fixtures.js';
import type { PipelineResult } from '../types.js';
import { runGhIssue, type GhIssueDeps } from './gh-issue.js';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
  h.present.add(join(h.root, 'dogfood', 'dist', 'dispatch-from-issue.js'));
});
afterEach(() => h.cleanup());

const result = (over: Partial<PipelineResult> = {}): PipelineResult => ({
  taskId: 'gh-issue-612',
  branch: 'ai-sdlc/gh-issue-612-x',
  worktreePath: '/wt',
  outcome: 'approved',
  prUrl: 'https://github.com/o/r/pull/9',
  siblingPrUrls: ['https://github.com/o/s/pull/1'],
  iterations: 2,
  finalVerdict: null,
  ...over,
});

const deps = (over: Partial<GhIssueDeps> = {}): GhIssueDeps => ({
  claudeOnPath: async () => true,
  fetchSpec: async () => ({
    spec: makeTask({ id: 'gh-issue-612' }),
    issueNumber: 612,
    authorAssociation: 'OWNER',
    labels: [],
  }),
  execute: async () => result(),
  ...over,
});

describe('runGhIssue (AISDLC-393)', () => {
  it('runs the composite with the inline spec, gh-issue source kind and the issue number', async () => {
    let seen: Parameters<GhIssueDeps['execute']>[0] | undefined;
    const out = await runGhIssue(
      h.ctx,
      612,
      deps({
        execute: async (o) => {
          seen = o;
          return result();
        },
      }),
    );
    expect(seen).toMatchObject({
      taskId: 'gh-issue-612',
      workDir: h.root,
      sourceKind: 'gh-issue',
      issueNumber: 612,
    });
    expect(seen?.taskSpec?.id).toBe('gh-issue-612');
    expect(out).toMatchObject({
      action: 'done',
      outcome: 'approved',
      prUrl: 'https://github.com/o/r/pull/9',
      siblingPrUrls: ['https://github.com/o/s/pull/1'],
      iterations: 2,
    });
  });

  it('refuses to fall back to API-key billing when claude is not on PATH', async () => {
    const out = await runGhIssue(h.ctx, 612, deps({ claudeOnPath: async () => false }));
    expect(out).toMatchObject({ action: 'stop', outcome: 'aborted', prUrl: null });
    expect(out.action === 'stop' && out.reason).toMatch(
      /`claude` CLI on PATH[\s\S]*ANTHROPIC_API_KEY[\s\S]*dogfood watch --issue 612/,
    );
  });

  it('tells the operator to build dogfood when its dist is missing', async () => {
    h.present.clear();
    const strict = makeHarness({ exists: () => false });
    const out = await runGhIssue(strict.ctx, 612, deps());
    expect(out.action === 'stop' && out.reason).toContain('pnpm --filter @ai-sdlc/dogfood build');
    strict.cleanup();
  });

  it('reports a failed issue fetch (closed issue, malformed payload)', async () => {
    const out = await runGhIssue(
      h.ctx,
      612,
      deps({
        fetchSpec: async () => {
          throw new Error('issue #612 is CLOSED');
        },
      }),
    );
    expect(out.action === 'stop' && out.reason).toContain('issue #612 is CLOSED');
  });

  it('passes through needs-human-attention as a (non-failing) done', async () => {
    const out = await runGhIssue(
      h.ctx,
      612,
      deps({ execute: async () => result({ outcome: 'needs-human-attention' }) }),
    );
    expect(out).toMatchObject({ action: 'done', outcome: 'needs-human-attention' });
  });

  it.each([
    'developer-failed',
    'developer-json-contract-violated',
    'aborted',
    'rebase-conflict',
  ] as const)('maps a %s pipeline outcome to a stop', async (outcome) => {
    const out = await runGhIssue(
      h.ctx,
      612,
      deps({ execute: async () => result({ outcome, prUrl: null, notes: 'why' }) }),
    );
    expect(out).toMatchObject({ action: 'stop', prUrl: null, reason: 'why' });
    expect(out.action === 'stop' && out.outcome).toBe(
      outcome === 'rebase-conflict' ? 'aborted' : outcome,
    );
  });

  it('turns a thrown composite error into a stop', async () => {
    const out = await runGhIssue(
      h.ctx,
      612,
      deps({
        execute: async () => {
          throw new Error('No Claude Code runtime available');
        },
      }),
    );
    expect(out.action === 'stop' && out.reason).toContain('No Claude Code runtime available');
  });
});

describe('runGhIssue trust gate (AISDLC-1269)', () => {
  const withIssue = (extra: Record<string, unknown>, spec = {}) =>
    deps({
      fetchSpec: async () => ({
        spec: makeTask({ id: 'gh-issue-612', ...spec }),
        issueNumber: 612,
        ...extra,
      }),
      execute: async () => {
        throw new Error('must not execute');
      },
    });
  const okDeps = (extra: Record<string, unknown>) =>
    deps({
      fetchSpec: async () => ({
        spec: makeTask({ id: 'gh-issue-612' }),
        issueNumber: 612,
        ...extra,
      }),
    });

  it('refuses an outside author without the label, naming association and label', async () => {
    const out = await runGhIssue(h.ctx, 612, withIssue({ authorAssociation: 'NONE', labels: [] }));
    expect(out).toMatchObject({ action: 'stop', prUrl: null });
    expect(out.action === 'stop' && out.reason).toMatch(/NONE[\s\S]*execute-approved/);
  });
  it('starts an outside author with the approval label', async () => {
    const out = await runGhIssue(
      h.ctx,
      612,
      okDeps({ authorAssociation: 'CONTRIBUTOR', labels: ['execute-approved'] }),
    );
    expect(out.action).toBe('done');
  });
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('starts %s without the label', async (a) => {
    const out = await runGhIssue(h.ctx, 612, okDeps({ authorAssociation: a, labels: [] }));
    expect(out.action).toBe('done');
  });
  it('refuses when the association cannot be read', async () => {
    const out = await runGhIssue(h.ctx, 612, withIssue({ labels: [] }));
    expect(out.action === 'stop' && out.reason).toMatch(/unknown/);
  });
  it('refuses an oversize title or description with size and cap', async () => {
    const t = await runGhIssue(
      h.ctx,
      612,
      withIssue({ authorAssociation: 'OWNER' }, { title: 'x'.repeat(501) }),
    );
    expect(t.action === 'stop' && t.reason).toMatch(/501 bytes[\s\S]*500-byte cap/);
    const d = await runGhIssue(
      h.ctx,
      612,
      withIssue({ authorAssociation: 'OWNER' }, { description: 'x'.repeat(20001) }),
    );
    expect(d.action === 'stop' && d.reason).toMatch(/20001 bytes[\s\S]*20000-byte cap/);
  });
});
