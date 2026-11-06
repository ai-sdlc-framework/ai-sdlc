import { describe, expect, it } from 'vitest';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { checkVerdict } from './verdict-check.js';
import { runVerdictCheck } from './verdict-cli.js';
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

describe('runVerdictCheck', () => {
  const run = async (runner: Runner, over: Partial<Parameters<typeof runVerdictCheck>[0]> = {}) =>
    runVerdictCheck({
      runner,
      cwd: '.',
      repository: 'o/r',
      headSha: HEAD,
      baseSha: 'c'.repeat(40),
      postStatus: true,
      ...over,
    });

  it('posts success on ai-sdlc/attestation for a valid record and writes the summary', async () => {
    const b = build({});
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'diff') return bad;
      return runnerFor(JSON.stringify(b.record), b.leaves)(cmd, args);
    };
    let summary = '';
    const res = await run(runner, { writeSummary: (m) => (summary = m) });
    expect(res.code).toBe('ok');
    expect(summary).toContain('ai-sdlc/attestation');
    const post = calls.find((c) => c.includes('POST'))!;
    expect(post).toContain('state=success');
    expect(post).toContain('context=ai-sdlc/attestation');
  });

  it('AC-1: posts failure with the reason code for every non-ok reason', async () => {
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
        if (cmd === 'git' && args[0] === 'ls-remote') return bad;
        if (cmd === 'gh') return bad;
        return sc.runner(cmd, args);
      };
      const res = await run(runner, {
        headSha: sc.code === 'subject-mismatch' ? 'd'.repeat(40) : HEAD,
        requiredTier: sc.requiredTier,
      });
      expect(res.code).toBe(sc.code);
      expect(res.ok).toBe(false);
      const post = calls.find((c) => c.includes('POST'))!;
      expect(post).toContain('state=failure');
      expect(post.some((a) => a.startsWith(`description=${sc.code}`))).toBe(true);
    }
  });

  it('AC-1: passes a carried-forward record (clean replay of an earlier approved head)', async () => {
    const earlier = build({});
    const earlierHead = 'e'.repeat(40);
    const rec = {
      ...earlier.record,
      subject: { ...earlier.record.subject, headSha: earlierHead },
    };
    const refLine = `${'1'.repeat(40)}\trefs/ai-sdlc/verdicts/${earlierHead}\n`;
    const runner: Runner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'diff') return bad;
      if (cmd === 'git' && args[0] === 'ls-remote') return ok(refLine);
      if (cmd === 'git' && args[0] === 'fetch') return args[3]?.endsWith(HEAD) ? bad : ok();
      if (cmd === 'git' && args[0] === 'show') return ok(JSON.stringify(rec));
      if (cmd === 'git' && args[0] === '--version') return ok('git version 2.43.0');
      if (cmd === 'git' && args[0] === 'rev-parse') return ok('T1\n');
      return ok();
    };
    const res = await run(runner, { pullRequest: 1 });
    expect(res.code).toBe(`ok-carried:${earlierHead}`);
    expect(res.ok).toBe(true);
  });

  it('declines to carry from unusable earlier records (other PR, unapproved, malformed, git too old)', async () => {
    const b = build({});
    const other = {
      ...b.record,
      subject: { ...b.record.subject, headSha: 'f'.repeat(40), pullRequest: 9 },
    };
    const unapproved = {
      ...b.record,
      subject: { ...b.record.subject, headSha: '9'.repeat(40) },
      verdict: 'changes_requested',
    };
    const refs = ['f', '9', '8', '7']
      .map((c) => `${'1'.repeat(40)}\trefs/ai-sdlc/verdicts/${c.repeat(40)}\n`)
      .join('');
    const bodies = [
      JSON.stringify(other),
      JSON.stringify(unapproved),
      '{bad',
      JSON.stringify({ ...b.record, subject: { ...b.record.subject, headSha: '7'.repeat(40) } }),
    ];
    let shown = 0;
    const runner: Runner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'diff') return bad;
      if (cmd === 'git' && args[0] === 'ls-remote') return ok(refs);
      if (cmd === 'git' && args[0] === 'fetch') return args[3]?.endsWith(HEAD) ? bad : ok();
      if (cmd === 'git' && args[0] === 'show') return ok(bodies[shown++] ?? '{}');
      if (cmd === 'git' && args[0] === '--version') return ok('git version 2.30.0');
      return ok();
    };
    const res = await run(runner, { pullRequest: 1, postStatus: false });
    expect(res.code).toBe('no-record');
  });

  it('fails closed on an unreadable diff and skips posting', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return bad;
    };
    const res = await run(runner, { postStatus: false });
    expect(res.code).toBe('no-record');
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });
});
