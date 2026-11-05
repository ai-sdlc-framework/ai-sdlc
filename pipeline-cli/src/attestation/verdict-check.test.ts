import { describe, expect, it } from 'vitest';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { compareShadow, checkVerdict } from './verdict-check.js';
import {
  collectHistory,
  compileCatches,
  formatCatches,
  reasonCode,
  type HeadHistory,
} from './verdict-catches.js';
import { runCatches, runVerdictCheck } from './verdict-cli.js';
import { finalizeVerdictRecord, type VerdictRecord } from './verdict-record.js';

const HEAD = 'a'.repeat(40);
const SUBJECT = {
  headSha: HEAD,
  treeSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  repository: 'o/r',
  pullRequest: 1,
};

function build(over: {
  reviewers?: string[];
  tier?: 'none' | 'attested' | 'isolated';
  verdict?: 'approved' | 'changes_requested';
  satisfied?: boolean;
  required?: string[];
}): { record: VerdictRecord; leaves: string } {
  const names = over.reviewers ?? ['code-reviewer', 'test-reviewer', 'security-reviewer'];
  const { record, leavesJsonl } = finalizeVerdictRecord(
    {
      verdict: over.verdict ?? 'approved',
      reviewers: names.map((name) => ({
        name,
        harness: 'h',
        model: 'm',
        independenceTier: over.tier ?? 'attested',
        verdict: 'approved' as const,
      })),
      coverage: {
        policy: 'review-policy@builtin',
        required: over.required ?? ['code-reviewer', 'test-reviewer', 'security-reviewer'],
        satisfied: over.satisfied ?? true,
      },
      leaves: [{ reviewer: 'code-reviewer' }],
    },
    { subject: SUBJECT },
  );
  return { record, leaves: leavesJsonl };
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });
const bad: ExecResult = { stdout: '', stderr: 'nope', code: 1 };

function runnerFor(rec: string | null, leaves: string | null, fetchOk = true): Runner {
  return async (_c, args) => {
    if (args[0] === 'fetch') return fetchOk ? ok() : bad;
    if (args[0] === 'show') {
      const v = args[1]!.endsWith('record.json') ? rec : leaves;
      return v === null ? bad : ok(v);
    }
    return ok();
  };
}

async function check(
  rec: ReturnType<typeof build> | null,
  extra: { tier?: 'none' | 'attested' | 'isolated'; mutate?: (r: VerdictRecord) => void } = {},
  head = HEAD,
  carry?: () => Promise<{ from: string } | null>,
) {
  if (rec && extra.mutate) extra.mutate(rec.record);
  return checkVerdict({
    runner: runnerFor(rec ? JSON.stringify(rec.record) : null, rec?.leaves ?? null, rec !== null),
    cwd: '.',
    headSha: head,
    changedPaths: null,
    requiredTier: extra.tier,
    carryForward: carry,
  });
}

describe('checkVerdict', () => {
  it('passes a valid record', async () => {
    const r = await check(build({}));
    expect(r.code).toBe('ok');
    expect(r.ok).toBe(true);
  });
  it('no-record when the ref is absent', async () => {
    expect((await check(null)).code).toBe('no-record');
  });
  it('no-record when the ref lacks files or is invalid', async () => {
    const r1 = await checkVerdict({
      runner: runnerFor(null, null),
      cwd: '.',
      headSha: HEAD,
      changedPaths: null,
    });
    expect(r1.code).toBe('no-record');
    const r2 = await checkVerdict({
      runner: runnerFor('{"x":1}', ''),
      cwd: '.',
      headSha: HEAD,
      changedPaths: null,
    });
    expect(r2.code).toBe('no-record');
  });
  it('ok-carried when carry-forward accepts', async () => {
    const r = await check(null, {}, HEAD, async () => ({ from: 'abc' }));
    expect(r.code).toBe('ok-carried:abc');
    expect(r.ok).toBe(true);
  });
  it('no-record when carry-forward declines', async () => {
    expect((await check(null, {}, HEAD, async () => null)).code).toBe('no-record');
  });
  it('subject-mismatch', async () => {
    expect((await check(build({}), {}, 'd'.repeat(40))).code).toBe('subject-mismatch');
  });
  it('replay-dirty', async () => {
    const b = build({});
    const r = await checkVerdict({
      runner: runnerFor(JSON.stringify(b.record), b.leaves + 'tampered\n'),
      cwd: '.',
      headSha: HEAD,
      changedPaths: null,
    });
    expect(r.code).toBe('replay-dirty');
  });
  it('coverage-short: missing reviewer', async () => {
    const r = await check(build({ reviewers: ['code-reviewer'] }));
    expect(r.code).toBe('coverage-short');
  });
  it('coverage-short: record required set smaller than the rule', async () => {
    const r = await check(build({ required: ['code-reviewer'] }));
    expect(r.code).toBe('coverage-short');
  });
  it('coverage-short: not satisfied or not approved', async () => {
    expect((await check(build({ satisfied: false }))).code).toBe('coverage-short');
    const r = await check(build({ verdict: 'changes_requested' }));
    expect(r.code).toBe('coverage-short');
    expect(r.detail).toContain('not approved');
  });
  it('tier-short reads the field', async () => {
    expect((await check(build({ tier: 'attested' }), { tier: 'isolated' })).code).toBe(
      'tier-short',
    );
    expect((await check(build({ tier: 'isolated' }), { tier: 'isolated' })).code).toBe('ok');
  });
});

describe('compareShadow', () => {
  it('agrees, disagrees, or is unavailable', () => {
    expect(compareShadow(true, 'success').agreed).toBe(true);
    expect(compareShadow(false, 'failure').agreed).toBe(true);
    const d = compareShadow(true, 'failure');
    expect(d.agreed).toBe(false);
    expect(d.line).toContain('DISAGREE');
    expect(compareShadow(true, null).agreed).toBeNull();
    expect(compareShadow(true, 'pending').agreed).toBeNull();
  });
});

describe('runVerdictCheck', () => {
  it('posts the status and writes the summary', async () => {
    const b = build({});
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'diff') return bad;
      if (cmd === 'gh' && args[1]?.includes('/commits/')) return ok('success\n');
      return runnerFor(JSON.stringify(b.record), b.leaves)(cmd, args);
    };
    let summary = '';
    const res = await runVerdictCheck({
      runner,
      cwd: '.',
      repository: 'o/r',
      headSha: HEAD,
      baseSha: 'c'.repeat(40),
      postStatus: true,
      writeSummary: (m) => (summary = m),
    });
    expect(res.code).toBe('ok');
    expect(summary).toContain('AGREE');
    const post = calls.find((c) => c.includes('POST'));
    expect(post).toContain('state=success');
  });
  it('posts success with the reason code for every non-ok reason (AISDLC-1192)', async () => {
    const b = build({});
    const scenarios: Array<{ code: string; runner: Runner; requiredTier?: 'isolated' }> = [
      { code: 'no-record', runner: runnerFor(null, null, false) },
      { code: 'subject-mismatch', runner: runnerFor(JSON.stringify(b.record), b.leaves) },
      {
        code: 'replay-dirty',
        runner: runnerFor(JSON.stringify(b.record), b.leaves + 'tampered\n'),
      },
      {
        code: 'coverage-short',
        runner: runnerFor(JSON.stringify(build({ satisfied: false }).record), b.leaves),
      },
      {
        code: 'tier-short',
        runner: runnerFor(JSON.stringify(b.record), b.leaves),
        requiredTier: 'isolated',
      },
    ];
    for (const sc of scenarios) {
      const calls: string[][] = [];
      const runner: Runner = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'git' && args[0] === 'diff') return bad;
        if (cmd === 'gh') return bad;
        return sc.runner(cmd, args);
      };
      const res = await runVerdictCheck({
        runner,
        cwd: '.',
        repository: 'o/r',
        headSha: sc.code === 'subject-mismatch' ? 'd'.repeat(40) : HEAD,
        baseSha: 'c'.repeat(40),
        requiredTier: sc.requiredTier,
        postStatus: true,
      });
      expect(res.code).toBe(sc.code);
      const post = calls.find((c) => c.includes('POST'))!;
      expect(post).toContain('state=success');
      expect(post.some((a) => a.startsWith(`description=${sc.code}`))).toBe(true);
      expect(post.some((a) => /state=(failure|error)/.test(a))).toBe(false);
    }
  });
  it('fails closed on an unreadable diff and skips posting', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return bad;
    };
    const res = await runVerdictCheck({
      runner,
      cwd: '.',
      repository: 'o/r',
      headSha: HEAD,
      baseSha: 'c'.repeat(40),
      postStatus: false,
    });
    expect(res.code).toBe('no-record');
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });
});

const hist = (over: Partial<HeadHistory>): HeadHistory => ({
  headSha: 'h1',
  pullRequest: 5,
  statuses: [],
  ...over,
});

describe('catches', () => {
  it('counts disagreements from the always-success post shape (AISDLC-1192)', () => {
    const rows = compileCatches([
      hist({
        headSha: 'n1',
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'success', description: 'no-record x' },
          { context: 'ai-sdlc/attestation', state: 'success' },
          { context: 'ai-sdlc/pr-ready', state: 'success' },
        ],
      }),
      hist({
        headSha: 'n2',
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'success', description: 'ok-carried:abc y' },
          { context: 'ai-sdlc/attestation', state: 'success' },
        ],
      }),
    ]);
    expect(rows.map((r) => [r.kind, r.headSha])).toEqual([
      ['catch', 'n1'],
      ['disagreement', 'n1'],
    ]);
    expect(rows[1]!.reason).toContain('verdict fail (no-record)');
  });
  it('lists catches and disagreements', () => {
    const rows = compileCatches([
      hist({
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'failure', description: 'coverage-short x' },
          { context: 'ai-sdlc/attestation', state: 'success' },
        ],
        prReadyCheckConclusion: 'success',
      }),
      hist({
        headSha: 'h2',
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'failure', description: 'no-record' },
          { context: 'ai-sdlc/pr-ready', state: 'failure' },
        ],
      }),
      hist({
        headSha: 'h3',
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'success', description: 'ok' },
          { context: 'ai-sdlc/attestation', state: 'failure' },
        ],
      }),
      hist({ headSha: 'h4', statuses: [{ context: 'ai-sdlc/attestation', state: 'success' }] }),
      hist({
        headSha: 'h5',
        statuses: [
          { context: 'ai-sdlc/review-verdict', state: 'success', description: 'ok' },
          { context: 'ai-sdlc/attestation', state: 'success' },
        ],
      }),
    ]);
    expect(rows.map((r) => `${r.kind}:${r.headSha}`)).toEqual([
      'catch:h1',
      'disagreement:h1',
      'disagreement:h3',
    ]);
    expect(rows[0]!.reason).toBe('coverage-short');
    expect(formatCatches(rows)).toContain('catch\tPR #5\th1\tcoverage-short');
    expect(formatCatches([])).toContain('no catches');
    expect(reasonCode(null)).toBe('unknown');
    expect(reasonCode('ok-carried:abc x')).toBe('ok-carried:abc');
  });

  it('collects history from mocked GitHub and writes no file', async () => {
    const seen: string[] = [];
    const ghJson = async (path: string) => {
      seen.push(path);
      if (path.includes('/pulls')) {
        return [
          { number: 1, updated_at: '2026-11-02T00:00:00Z', head: { sha: 'h1' } },
          { number: 2, updated_at: '2026-01-01T00:00:00Z', head: { sha: 'h2' } },
        ];
      }
      if (path.includes('check-runs')) return { check_runs: [{ conclusion: 'success' }] };
      return [{ context: 'ai-sdlc/review-verdict', state: 'failure', description: 'tier-short' }];
    };
    const out = await runCatches('o/r', '2026-10-01', ghJson);
    expect(out).toContain('catch\tPR #1\th1\ttier-short');
    expect(seen.some((p) => p.includes('h2'))).toBe(false);
    const all = await collectHistory('o/r', undefined, async (p) =>
      p.includes('/pulls')
        ? [{ number: 3, updated_at: '2020-01-01T00:00:00Z', head: { sha: 'h3' } }]
        : p.includes('check-runs')
          ? {}
          : [],
    );
    expect(all[0]!.prReadyCheckConclusion).toBeNull();
  });
});
