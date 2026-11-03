/** RFC-0061 Phase 1: AC-1 schema, AC-2 shared coverage rule, AC-3/AC-4 atomic push and tree, AC-6 prune. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunner } from '../runtime/exec.js';
import { buildVerdictRecordDraft } from '../steps/08-aggregate-verdicts.js';
import { buildVerdictRefspec } from '../next-step/verdict-ref-push.js';
import { computeRequiredReviewers, evaluateCoverage } from './review-coverage.js';
import { pruneVerdictRefs, type PrState } from './verdict-prune.js';
import {
  finalizeVerdictRecord,
  leavesDigest,
  recordMatchesLeaves,
  VerdictRecordSchema,
} from './verdict-record.js';
import type { AggregatedVerdict } from '../types.js';

const H = 'a'.repeat(40);
const sketch = () => ({
  schema: 'ai-sdlc/review-verdict/v1',
  subject: {
    headSha: H,
    treeSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
    repository: 'o/n',
    pullRequest: 0,
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
  coverage: { policy: 'review-policy@x', required: ['correctness-reviewer'], satisfied: true },
  evidence: { leaves: 'leaves.jsonl', digest: `sha256:${'d'.repeat(64)}` },
  issuedBy: { principal: 'pipeline-step-11', at: '2026-11-03T00:00:00Z' },
  carriedForwardFrom: null,
});

const aggregated = (names: string[]): AggregatedVerdict => ({
  approved: true,
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  decision: 'APPROVED',
  verdicts: names.map((n) => ({
    agentId: n,
    harness: 'claude-code',
    approved: true,
    findings: [],
  })),
  harnessNote: '',
  summary: '',
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'verdict-'));
  dirs.push(base);
  const bare = join(base, 'origin.git');
  const wt = join(base, 'wt');
  mkdirSync(wt);
  git(base, 'init', '-q', '--bare', bare);
  git(wt, 'init', '-q', '-b', 'main');
  git(wt, 'config', 'user.email', 't@e.invalid');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'remote', 'add', 'origin', bare);
  writeFileSync(join(wt, 'a.txt'), '1');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'init');
  git(wt, 'push', '-q', 'origin', 'main');
  git(wt, 'checkout', '-qb', 'feat/x');
  writeFileSync(join(wt, 'b.txt'), '2');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  return { base, bare, wt };
}

describe('verdict record schema (AC-1)', () => {
  it('validates the RFC sketch with every shipped tier and rejects others', () => {
    expect(VerdictRecordSchema.safeParse(sketch()).success).toBe(true);
    for (const tier of ['none', 'attested', 'isolated']) {
      const r = sketch();
      r.reviewers[0]!.independenceTier = tier;
      expect(VerdictRecordSchema.safeParse(r).success).toBe(true);
    }
    const bad = sketch();
    bad.reviewers[0]!.independenceTier = 'self-authored';
    expect(VerdictRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe('shared coverage rule (AC-2)', () => {
  it('step 8 copies the shared rule result into the record', () => {
    const paths = ['docs/readme.md'];
    const draft = buildVerdictRecordDraft(
      aggregated(['correctness-reviewer', 'security-reviewer']),
      {
        changedPaths: paths,
        tiers: { 'correctness-reviewer': 'attested' },
      },
    )!;
    const expected = evaluateCoverage(computeRequiredReviewers({ changedPaths: paths }), [
      'correctness-reviewer',
      'security-reviewer',
    ]);
    expect(draft.coverage).toEqual(expected);
    expect(draft.coverage.satisfied).toBe(true);
    expect(draft.reviewers.map((r) => r.independenceTier)).toEqual(['attested', 'none']);
  });

  it('is unsatisfied when a required reviewer is missing, and null unless approved', () => {
    const d = buildVerdictRecordDraft(aggregated(['correctness-reviewer']), { changedPaths: [] })!;
    expect(d.coverage.satisfied).toBe(false);
    expect(
      buildVerdictRecordDraft({ ...aggregated(['x']), approved: false }, { changedPaths: [] }),
    ).toBeNull();
  });

  it('writer imports the same module the checker will import', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const writer = readFileSync(join(here, '..', 'steps', '08-aggregate-verdicts.ts'), 'utf-8');
    expect(writer).toMatch(/from '\.\.\/attestation\/review-coverage\.js'/);
    expect(writer).toMatch(/computeRequiredReviewers/);
  });
});

describe('atomic verdict ref push (AC-3, AC-4)', () => {
  it('pushes branch and verdict ref together; tree holds exactly the two files', async () => {
    const { bare, wt } = fixture();
    git(wt, 'remote', 'set-url', 'origin', bare);
    const draft = buildVerdictRecordDraft(aggregated(['correctness-reviewer']), {
      changedPaths: ['x.md'],
    })!;
    // repositoryFromRemoteUrl needs a github url: use a pushurl-free trick via insteadOf.
    git(wt, 'config', `url.${bare}.insteadOf`, 'https://github.com/o/n.git');
    git(wt, 'remote', 'set-url', 'origin', 'https://github.com/o/n.git');
    const spec = await buildVerdictRefspec(defaultRunner, wt, draft, 'origin/main');
    expect(spec.note ?? '').toBe('');
    expect(spec.refspec).toMatch(/^[0-9a-f]{40}:refs\/ai-sdlc\/verdicts\/[0-9a-f]{40}$/);
    const [commit, ref] = spec.refspec!.split(':') as [string, string];
    git(wt, 'push', '--atomic', 'origin', 'feat/x', spec.refspec!);
    const head = git(wt, 'rev-parse', 'HEAD');
    expect(git(bare, 'rev-parse', 'refs/heads/feat/x')).toBe(head);
    expect(git(bare, 'rev-parse', ref)).toBe(commit);
    expect(git(bare, 'ls-tree', '--name-only', ref).split('\n').sort()).toEqual([
      'leaves.jsonl',
      'record.json',
    ]);
    const record = VerdictRecordSchema.parse(JSON.parse(git(bare, 'show', `${ref}:record.json`)));
    const leaves = execFileSync('git', ['show', `${ref}:leaves.jsonl`], {
      cwd: bare,
      encoding: 'utf-8',
    });
    expect(record.subject.headSha).toBe(head);
    expect(record.evidence.digest).toBe(leavesDigest(leaves));
    expect(recordMatchesLeaves(record, leaves)).toBe(true);
    // A second attempt for the same head does not re-issue.
    expect((await buildVerdictRefspec(defaultRunner, wt, draft, 'origin/main')).refspec).toBeNull();
  });

  it('if one ref is rejected, neither updates', () => {
    const { bare, wt } = fixture();
    const head = git(wt, 'rev-parse', 'HEAD');
    // Pre-receive hook refusing the verdict namespace.
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read o n r; do case "$r" in refs/ai-sdlc/*) exit 1;; esac; done\n',
      { mode: 0o755 },
    );
    expect(() =>
      git(wt, 'push', '--atomic', 'origin', 'feat/x', `HEAD:refs/ai-sdlc/verdicts/${head}`),
    ).toThrow();
    expect(() => git(bare, 'rev-parse', '--verify', 'refs/heads/feat/x')).toThrow();
    expect(() => git(bare, 'rev-parse', '--verify', `refs/ai-sdlc/verdicts/${head}`)).toThrow();
  });

  it('finalize + digest round trip', () => {
    const draft = buildVerdictRecordDraft(aggregated(['correctness-reviewer']), {
      changedPaths: [],
    })!;
    const { record, leavesJsonl } = finalizeVerdictRecord(draft, {
      subject: sketch().subject,
      now: new Date('2026-11-03T00:00:00.000Z'),
    });
    expect(record.issuedBy.at).toBe('2026-11-03T00:00:00Z');
    expect(recordMatchesLeaves(record, leavesJsonl + 'x')).toBe(false);
  });
});

describe('verdict-prune (AC-6)', () => {
  it('deletes only refs of closed or merged PRs past the age', async () => {
    const { bare, wt } = fixture();
    const sha = git(wt, 'rev-parse', 'HEAD');
    const old = '2020-01-01T00:00:00Z';
    const names = { merged: '1', closed: '2', open: '3', none: '4', young: '5' } as const;
    const ref = (k: keyof typeof names) => `refs/ai-sdlc/verdicts/${names[k].repeat(40)}`;
    for (const k of Object.keys(names) as Array<keyof typeof names>) {
      const env = {
        ...process.env,
        GIT_COMMITTER_DATE: k === 'young' ? new Date().toISOString() : old,
        GIT_AUTHOR_DATE: old,
      };
      const c = execFileSync('git', ['commit-tree', `${sha}^{tree}`, '-m', k], {
        cwd: wt,
        encoding: 'utf-8',
        env,
      }).trim();
      git(wt, 'push', '-q', 'origin', `${c}:${ref(k)}`);
    }
    const states: Record<string, PrState> = {
      [names.merged.repeat(40)]: 'merged',
      [names.closed.repeat(40)]: 'closed',
      [names.open.repeat(40)]: 'open',
      [names.none.repeat(40)]: 'none',
      [names.young.repeat(40)]: 'merged',
    };
    const out = await pruneVerdictRefs({
      runner: defaultRunner,
      cwd: wt,
      prStateFor: async (h) => states[h]!,
    });
    expect(out.deleted.sort()).toEqual([ref('merged'), ref('closed')].sort());
    const left = git(bare, 'for-each-ref', '--format=%(refname)', 'refs/ai-sdlc/verdicts/')
      .split('\n')
      .sort();
    expect(left).toEqual([ref('open'), ref('none'), ref('young')].sort());
  });
});
