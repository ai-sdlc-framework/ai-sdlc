import { describe, expect, it } from 'vitest';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';
import { listEarlierSubjects } from './verdict-cli.js';

const rec = (head: string, pullRequest: number) =>
  JSON.stringify({
    schema: 'ai-sdlc/review-verdict/v1',
    subject: {
      headSha: head,
      treeSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      repository: 'o/n',
      pullRequest,
    },
    verdict: 'approved',
    reviewers: [
      {
        name: 'correctness-reviewer',
        harness: 'claude',
        model: 'm',
        independenceTier: 'attested',
        verdict: 'approved',
      },
    ],
    coverage: { policy: 'p', required: ['correctness-reviewer'], satisfied: true },
    evidence: { leaves: 'leaves.jsonl', digest: `sha256:${'d'.repeat(64)}` },
    issuedBy: { principal: 'pipeline-step-11', at: '2026-11-03T00:00:00Z' },
    carriedForwardFrom: null,
  });

function runnerWith(records: Record<string, string>) {
  const refs = Object.keys(records).map((h) => `${h}\trefs/ai-sdlc/verdicts/${h}`);
  let last = '';
  const f = new FakeRunner();
  f.on(/ls-remote/, ok(refs.join('\n')));
  f.on(
    (c, a) => a[0] === 'fetch',
    (a) => {
      last = a[a.length - 1]!.split('/').pop()!;
      return ok();
    },
  );
  f.on(/show/, () => ok(records[last]!));
  return f.toRunner();
}

describe('listEarlierSubjects pull-request scoping (AISDLC-1220)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'e'.repeat(40);
  const records = { [A]: rec(A, 7), [B]: rec(B, 0), [C]: rec(C, 9) };

  it('lenient mode keeps same-PR and unscoped (0) records', async () => {
    const r = await listEarlierSubjects(runnerWith(records), '/x', 'f'.repeat(40), 7);
    expect(r.map((x) => x.headSha).sort()).toEqual([A, B].sort());
  });

  it('strict mode keeps only records of the same PR', async () => {
    const r = await listEarlierSubjects(runnerWith(records), '/x', 'f'.repeat(40), 7, {
      strictPullRequest: true,
    });
    expect(r.map((x) => x.headSha)).toEqual([A]);
  });
});
