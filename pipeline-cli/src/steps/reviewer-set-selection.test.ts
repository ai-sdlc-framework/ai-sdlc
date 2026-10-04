/**
 * selectReviewerSet / routeReviewers: every floor and condition has its own test.
 * Hermetic: fake provider, no network, no git.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  REVIEWER_SET_SIGNAL_IDS,
  createJudgmentLogSink,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
  type JudgmentSink,
} from '@ai-sdlc/reference';
import {
  CODE_TEST_MERGED_REVIEWER_SET,
  THREE_REVIEWER_SET,
  applyReviewerSetFloors,
  explicitReviewerSetMode,
  resolveReviewerSetMode,
  selectReviewerSet,
  type SelectReviewerSetOpts,
} from './reviewer-set.js';
import { pathClassifierReviewers, routeReviewers } from './review-routing.js';
import { reviewPaths } from './review-judgment-support.js';

const KEY = 'fake@fake-1';
const SET_ID = 'review.reviewer-set';
const THRESHOLDS = Object.fromEntries(REVIEWER_SET_SIGNAL_IDS.map((id) => [id, 0.3]));
const PROMO = { path: 'corpus', n: 50, actBandPrecision: 0.95 };

function ctxFor(opts: {
  probability?: number | Record<string, number>;
  mode?: 'shadow' | 'enforce' | 'off';
  promotion?: Record<string, unknown> | null;
  provider?: boolean;
  sinks?: JudgmentSink[];
  routing?: Record<string, number>;
  routingMode?: 'shadow' | 'enforce';
}): { ctx: EvaluateJudgmentContext; fake: FakeJudgmentProvider } {
  const fake = new FakeJudgmentProvider();
  const p = opts.probability ?? 0.01;
  for (const id of REVIEWER_SET_SIGNAL_IDS) {
    fake.script(id, { type: 'noul', probability: typeof p === 'number' ? p : (p[id] ?? 0.01) });
  }
  for (const id of ['auth-session-secrets', 'input-handling', 'dependencies-ci']) {
    fake.script(id, { type: 'noul', probability: 0 });
  }
  for (const [id, v] of Object.entries(opts.routing ?? {})) {
    fake.script(id, { type: 'noul', probability: v });
  }
  const config = resolveJudgmentConfig({
    spec: {
      ...(opts.provider === false ? {} : { provider: 'fake', model: 'fake-1' }),
      egress: { allow: ['code-diff'] },
      judgments: {
        [SET_ID]: {
          mode: opts.mode ?? 'enforce',
          thresholds: { [KEY]: THRESHOLDS },
          promotion: opts.promotion === null ? {} : { [KEY]: opts.promotion ?? PROMO },
        },
        'review.routing': {
          mode: opts.routingMode ?? 'enforce',
          thresholds: { [KEY]: { 'input-handling': 0.5 } },
          promotion: { [KEY]: { path: 'override', evidence: 'reviewed the corpus' } },
        },
      },
    },
  });
  return {
    fake,
    ctx: { config, getProvider: () => fake, ...(opts.sinks ? { sinks: opts.sinks } : {}) },
  };
}

const SAFE_FILES = ['pipeline-cli/src/foo.ts'];
const DIFF = 'diff --git a/pipeline-cli/src/foo.ts b/pipeline-cli/src/foo.ts\n+const x = 1;\n';

function base(over: Partial<SelectReviewerSetOpts> = {}): SelectReviewerSetOpts {
  return {
    env: {},
    readBaseConfig: () => null,
    sourceKind: 'backlog',
    changedFiles: SAFE_FILES,
    diff: DIFF,
    ...over,
  };
}

const THREE = [...THREE_REVIEWER_SET];
const MERGED = [...CODE_TEST_MERGED_REVIEWER_SET];

function assertFloors(reviewers: string[]): void {
  expect(reviewers).toContain('security-reviewer');
  expect(reviewers.length).toBeGreaterThanOrEqual(2);
}

describe('selectReviewerSet: the merged set requires every condition', () => {
  it('returns the merged set when all conditions hold', async () => {
    const { ctx } = ctxFor({});
    const sel = await selectReviewerSet(base({ judgment: ctx }));
    expect(sel).toMatchObject({
      reviewers: MERGED,
      mode: 'code-test-merged',
      source: 'judgment',
    });
    assertFloors(sel.reviewers);
  });

  it('shadow mode alone returns the default result', async () => {
    const { ctx } = ctxFor({ mode: 'shadow' });
    const sel = await selectReviewerSet(base({ judgment: ctx }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.source).toBe('config');
    expect(sel.decidedBy).toContain('not-enforced');
    assertFloors(sel.reviewers);
  });

  it('enforce without a promotion record alone returns the default result', async () => {
    const { ctx } = ctxFor({ promotion: null });
    const sel = await selectReviewerSet(base({ judgment: ctx }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('judgment:not-enforced:no-promotion');
  });

  it('a path: override promotion alone returns the default result', async () => {
    const { ctx } = ctxFor({ promotion: { path: 'override', evidence: 'trust me' } });
    const sel = await selectReviewerSet(base({ judgment: ctx }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('judgment:not-enforced:no-promotion');
  });

  it('a weak corpus promotion alone returns the default result', async () => {
    const { ctx } = ctxFor({ promotion: { path: 'corpus', n: 50, actBandPrecision: 0.94 } });
    expect((await selectReviewerSet(base({ judgment: ctx }))).reviewers).toEqual(THREE);
  });

  it('a gh-issue source never selects the merged set, whatever the answers', async () => {
    const { ctx, fake } = ctxFor({ probability: 0 });
    for (const sourceKind of ['gh-issue', undefined, 'other']) {
      const sel = await selectReviewerSet(
        base({ judgment: ctx, ...(sourceKind ? { sourceKind } : { sourceKind: undefined }) }),
      );
      expect(sel.reviewers).toEqual(THREE);
      expect(sel.decidedBy).toBe('veto:source-kind');
      assertFloors(sel.reviewers);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['auth path', ['src/auth/login.ts'], 'veto:path-auth'],
    ['secret file', ['config/.env.production'], 'veto:path-auth'],
    ['lockfile', ['pnpm-lock.yaml'], 'veto:path-lockfile'],
    ['package manifest', ['package.json'], 'veto:path-lockfile'],
    ['CI workflow', ['.github/workflows/ci.yml'], 'veto:path-ci'],
  ])('an %s match vetoes even with near-zero risk Nouls', async (_n, files, decidedBy) => {
    const { ctx, fake } = ctxFor({ probability: 0 });
    const sel = await selectReviewerSet(base({ judgment: ctx, changedFiles: files }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe(decidedBy);
    expect(fake.requests).toHaveLength(0);
  });

  it('a veto found only on the pre-image side of a rename still applies', async () => {
    const { ctx } = ctxFor({ probability: 0 });
    const diff = 'diff --git a/.github/workflows/ci.yml b/docs/old-ci.md\nsimilarity index 90%\n';
    const sel = await selectReviewerSet(
      base({ judgment: ctx, changedFiles: ['docs/old-ci.md'], diff }),
    );
    expect(sel.decidedBy).toBe('veto:path-ci');
    expect(sel.reviewers).toEqual(THREE);
  });

  it('an empty file list cannot be checked and so never relaxes', async () => {
    const { ctx } = ctxFor({ probability: 0 });
    const sel = await selectReviewerSet(base({ judgment: ctx, changedFiles: [], diff: '' }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('veto:no-changed-files');
  });

  it('a raised risk signal alone returns the default result', async () => {
    for (const id of REVIEWER_SET_SIGNAL_IDS) {
      const { ctx } = ctxFor({ probability: { [id]: 0.9 } });
      const sel = await selectReviewerSet(base({ judgment: ctx }));
      expect(sel.reviewers).toEqual(THREE);
      expect(sel.source).toBe('config');
      expect(sel.decidedBy).toBe(`judgment:signal-raised:${id}`);
    }
  });

  it('a provider failure alone returns the default result', async () => {
    const { ctx, fake } = ctxFor({});
    fake.failWith('timeout');
    const sel = await selectReviewerSet(base({ judgment: ctx }));
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('judgment:provider-error');
  });

  it('the layer disabled returns the default result without any call', async () => {
    const { ctx, fake } = ctxFor({ provider: false });
    expect((await selectReviewerSet(base({ judgment: ctx }))).reviewers).toEqual(THREE);
    expect((await selectReviewerSet(base())).decidedBy).toBe('config:layer-disabled');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('selectReviewerSet: path quoting, missing diff and governance vetoes', () => {
  const run = async (over: Partial<SelectReviewerSetOpts>) => {
    const { ctx, fake } = ctxFor({ probability: 0 });
    const sel = await selectReviewerSet(base({ judgment: ctx, ...over }));
    return { sel, fake };
  };

  it.each([
    ['non-ASCII workflow', ['.github/workflows/déploy.yml'], 'veto:path-ci'],
    ['non-ASCII auth dir', ['src/auth/été.ts'], 'veto:path-auth'],
    ['non-ASCII lockfile dir', ['paquet/pnpm-lock.yaml'], 'veto:path-lockfile'],
    ['workflow with a literal quote', ['.github/workflows/a"b.yml'], 'veto:path-ci'],
    ['workflow with a backslash', ['.github/workflows/a\\b.yml'], 'veto:path-ci'],
    ['workflow with a newline', ['.github/workflows/a\nb.yml'], 'veto:path-ci'],
  ])('plain %s paths still veto', async (_n, files, decidedBy) => {
    const { sel, fake } = await run({ changedFiles: files });
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe(decidedBy);
    expect(fake.requests).toHaveLength(0);
  });

  it('a quoted path in the file list fails closed', async () => {
    const { sel, fake } = await run({
      changedFiles: ['".github/workflows/d\\303\\251ploy.yml"'],
    });
    expect(sel.decidedBy).toBe('veto:unparseable-path');
    expect(sel.reviewers).toEqual(THREE);
    expect(fake.requests).toHaveLength(0);
  });

  it('a quoted diff header fails closed even when the file list is plain', async () => {
    const diff =
      'diff --git ".github/workflows/d\\303\\251ploy.yml" "docs/d\\303\\251ploy.md"\nrename from x\n';
    const { sel } = await run({ changedFiles: ['docs/deploy.md'], diff });
    expect(sel.decidedBy).toBe('veto:unparseable-path');
  });

  it('a workflow renamed to a quoted destination is vetoed', async () => {
    const diff = [
      'diff --git a/.github/workflows/ci.yml "b/docs/caf\\303\\251.md"',
      'similarity index 90%',
      'rename from .github/workflows/ci.yml',
      'rename to "docs/caf\\303\\251.md"',
    ].join('\n');
    const { sel } = await run({ changedFiles: ['docs/readme.md'], diff });
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('veto:unparseable-path');
  });

  it('a plain rename out of a workflow is vetoed by the rename lines', async () => {
    const diff = [
      'diff --git a/.github/workflows/ci.yml b/docs/ci.md',
      'rename from .github/workflows/ci.yml',
      'rename to docs/ci.md',
    ].join('\n');
    const { sel } = await run({ changedFiles: ['docs/ci.md'], diff });
    expect(sel.decidedBy).toBe('veto:path-ci');
  });

  it('an ambiguous header (several " b/", differing sides) is vetoed, not guessed', async () => {
    const diff = 'diff --git a/.github/workflows/x b/y.ts b/docs/z.md\n';
    const { sel } = await run({ changedFiles: ['docs/z.md'], diff });
    expect(sel.decidedBy).toBe('veto:unparseable-path');
    expect(sel.reviewers).toEqual(THREE);
  });

  it('a CRLF diff header cannot hide a rename into a sensitive path', async () => {
    const diff =
      'diff --git a/docs/x.md b/.github/dependabot.yml\r\nrename to .github/dependabot.yml\r\n';
    const { sel } = await run({ changedFiles: ['docs/x.md'], diff });
    expect(sel.decidedBy).toBe('veto:unparseable-path');
  });

  it('a failed or truncated diff read vetoes', async () => {
    expect((await run({ diffUnavailable: true })).sel.decidedBy).toBe('veto:diff-unavailable');
  });

  it('a NUL byte or replacement character in the diff vetoes as a binary diff', async () => {
    for (const diff of ['diff --git a/x b/x\n+a\u0000b\n', 'diff --git a/x b/x\n+a\uFFFDb\n']) {
      expect((await run({ diff })).sel.decidedBy).toBe('veto:binary-diff');
    }
  });

  it('a binaryDiff flag from numstat vetoes', async () => {
    expect((await run({ binaryDiff: true })).sel.decidedBy).toBe('veto:binary-diff');
  });

  it('an empty diff with changed files vetoes', async () => {
    const { sel, fake } = await run({ diff: '  \n' });
    expect(sel.decidedBy).toBe('veto:diff-unavailable');
    expect(sel.reviewers).toEqual(THREE);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    '.github/actions/setup/action.yml',
    '.github/dependabot.yml',
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
    '.husky/pre-push',
    'scripts/deploy.sh',
    'scripts/check-coverage.mjs',
    'scripts/verify-attestation.mjs',
    'pipeline-cli/src/attestation/patch-id.ts',
    'ai-sdlc-plugin/hooks/enforce.js',
    '.ai-sdlc/judgment-config.yaml',
    '.ai-sdlc/review-config.yaml',
    'pipeline-cli/attestation-core/merkle.ts',
    '.gitattributes',
    'packages/web/.gitattributes',
    '.npmrc',
    'sub/.npmrc',
    'pipeline-cli/src/steps/reviewer-set.ts',
    'pipeline-cli/src/steps/reviewer-set-selection.test.ts',
    'pipeline-cli/src/steps/review-routing.ts',
    'pipeline-cli/src/steps/review-judgment-support.ts',
    'pipeline-cli/src/steps/07-build-review-prompts.ts',
    'reference/src/judgment/evaluate.ts',
    'reference/src/judgment/catalog/review-routing.ts',
    'ai-sdlc-plugin/agents/security-reviewer.md',
    'ai-sdlc-plugin/commands/review-pr.md',
    'ai-sdlc-plugin/scripts/sign-attestation.mjs',
    'ai-sdlc-plugin/scripts/sign-other.mjs',
    'scripts/is-docs-only-changeset.mjs',
    'pipeline-cli/src/classifier/classifier.ts',
    'pipeline-cli/src/judgment/context.ts',
    'pipeline-cli/src/routing/resolve-model.ts',
    'pipeline-cli/src/execute-pipeline.ts',
    'pipeline-cli/src/steps/08-aggregate-verdicts.ts',
    'pipeline-cli/src/steps/09-iterate.ts',
    '.claude/settings.json',
    '.mcp.json',
    '.pnpmfile.cjs',
    'pnpm-workspace.yaml',
    '.yarnrc.yml',
    'pipeline-cli/src/steps/sub/review-x.ts',
    'ai-sdlc-plugin/scripts/lib/sign-x.mjs',
  ])('governance path %s vetoes the merged set', async (path) => {
    const { sel, fake } = await run({ changedFiles: [path] });
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('veto:path-governance');
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    'pipeline-cli/src/steps/reviewer-settings.ts',
    'pipeline-cli/src/steps/preview-build.ts',
    'pipeline-cli/src/steps/reviews.ts',
    'pipeline-cli/src/other/review-routing.ts',
    'reference/src/judgments/x.ts',
    'reference/src/judgment-x.ts',
    'ai-sdlc-plugin/agent/x.md',
    'ai-sdlc-plugin/scripts/other.mjs',
    'ai-sdlc-plugin/scripts/design-x.mjs',
    'scripts/is-docs-only-changeset.test.mjs',
    'docs/gitattributes.md',
    'docs/npmrc.md',
    'pipeline-cli/attestation-corex/a.ts',
    'pipeline-cli/src/classifiers/a.ts',
    'pipeline-cli/src/routings/a.ts',
    'pipeline-cli/src/execute-pipelinex/a.ts',
    'docs/pnpm-workspace.md',
    'src/not-scripts/run.sh.txt',
  ])('lookalike path %s does not veto', async (path) => {
    const { sel } = await run({ changedFiles: [path] });
    expect(sel.reviewers).toEqual(MERGED);
    expect(sel.decidedBy).toBe('judgment:all-signals-below-threshold');
  });

  it.each([
    ['iteration 2', 2],
    ['iteration 3', 3],
    ['a NaN iteration', Number.NaN],
  ])('%s never relaxes review', async (_n, iteration) => {
    const { sel, fake } = await run({ iteration });
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('veto:iteration');
    expect(fake.requests).toHaveLength(0);
  });

  it('iteration 1 (or none) is allowed', async () => {
    expect((await run({ iteration: 1 })).sel.reviewers).toEqual(MERGED);
    expect((await run({})).sel.reviewers).toEqual(MERGED);
  });

  it.each([
    'diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n',
    'diff --git a/x.bin b/x.bin\nGIT binary patch\nliteral 3\n',
  ])('a binary hunk vetoes: %#', async (diff) => {
    const { sel, fake } = await run({ diff: diff.replace(/\\n/g, '\n') });
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('veto:binary-diff');
    expect(fake.requests).toHaveLength(0);
  });

  it('text that merely mentions binary files in a hunk does not veto', async () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+// Binary files differ here\n';
    expect((await run({ diff: diff.replace(/\\n/g, '\n') })).sel.reviewers).toEqual(MERGED);
  });

  it('ordinary source and scripts data files do not veto', async () => {
    const { sel } = await run({ changedFiles: ['scripts/data.json', 'pipeline-cli/src/a.ts'] });
    expect(sel.reviewers).toEqual(MERGED);
  });
});

describe('selectReviewerSet: explicit configuration', () => {
  it('an explicit code-test-merged from env still applies, judgment or not', async () => {
    const env = { AI_SDLC_REVIEWER_SET: 'code-test-merged' };
    const off = await selectReviewerSet(base({ env }));
    expect(off).toMatchObject({ reviewers: MERGED, source: 'config' });
    const { ctx, fake } = ctxFor({ probability: 1 });
    const on = await selectReviewerSet(base({ env, judgment: ctx, sourceKind: 'gh-issue' }));
    expect(on).toMatchObject({ reviewers: MERGED, source: 'config' });
    expect(on.decidedBy).toBe('config:explicit-code-test-merged');
    expect(fake.requests).toHaveLength(0);
  });

  it('an explicit code-test-merged from base-branch config still applies', async () => {
    const sel = await selectReviewerSet(
      base({ readBaseConfig: () => 'reviewerSet: code-test-merged\n' }),
    );
    expect(sel).toMatchObject({ reviewers: MERGED, source: 'config' });
  });

  it('an explicit three pin is never overridden by the judgment', async () => {
    const { ctx, fake } = ctxFor({ probability: 0 });
    const sel = await selectReviewerSet(
      base({ env: { AI_SDLC_REVIEWER_SET: 'three' }, judgment: ctx }),
    );
    expect(sel.reviewers).toEqual(THREE);
    expect(sel.decidedBy).toBe('config:explicit-three');
    expect(fake.requests).toHaveLength(0);
  });

  it('explicitReviewerSetMode reads env first, then base config, else null', () => {
    expect(explicitReviewerSetMode({ env: { AI_SDLC_REVIEWER_SET: 'three' } })).toBe('three');
    expect(explicitReviewerSetMode({ env: {}, readBaseConfig: () => 'reviewerSet: three' })).toBe(
      'three',
    );
    expect(explicitReviewerSetMode({ env: {}, readBaseConfig: () => null })).toBeNull();
    expect(explicitReviewerSetMode({ env: {}, readBaseConfig: () => 'other: 1' })).toBeNull();
    expect(resolveReviewerSetMode({ env: {}, readBaseConfig: () => null })).toBe('three');
  });
});

describe('floors', () => {
  it('applyReviewerSetFloors adds security and never returns fewer than two', () => {
    expect(applyReviewerSetFloors(['code-reviewer', 'test-reviewer'])).toEqual([
      'code-reviewer',
      'test-reviewer',
      'security-reviewer',
    ]);
    expect(applyReviewerSetFloors(['security-reviewer'])).toEqual(THREE);
    expect(applyReviewerSetFloors([])).toEqual(THREE);
    expect(applyReviewerSetFloors(['security-reviewer', 'security-reviewer'])).toEqual(THREE);
    expect(applyReviewerSetFloors(['code-reviewer', 'code-reviewer'])).toEqual([
      'code-reviewer',
      'security-reviewer',
    ]);
    expect(applyReviewerSetFloors(['correctness-reviewer'])).toEqual([
      'correctness-reviewer',
      'security-reviewer',
    ]);
    expect(applyReviewerSetFloors(MERGED)).toEqual(MERGED);
  });
});

describe('judgment log record', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewer-set-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (): Record<string, unknown>[] => {
    const d = join(dir, '_judgment');
    return readdirSync(d)
      .flatMap((f) => readFileSync(join(d, f), 'utf8').split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const selection = () => lines().find((l) => l.judgmentId === 'review.reviewer-set.selection');

  it('names the set, the source and the deciding signal for a judgment selection', async () => {
    const { ctx } = ctxFor({ sinks: [createJudgmentLogSink({ artifactsDir: dir })] });
    await selectReviewerSet(base({ judgment: ctx, taskId: 'T-1' }));
    const rec = selection() as { outcome: { decision: Record<string, unknown> }; taskId: string };
    expect(rec.taskId).toBe('T-1');
    expect(rec.outcome.decision).toMatchObject({
      set: 'code-test-merged',
      source: 'judgment',
      decidedBy: 'judgment:all-signals-below-threshold',
      reviewers: MERGED,
    });
    expect(lines().some((l) => l.judgmentId === SET_ID)).toBe(true);
  });

  it('names the veto for a config result', async () => {
    const { ctx } = ctxFor({ sinks: [createJudgmentLogSink({ artifactsDir: dir })] });
    await selectReviewerSet(base({ judgment: ctx, changedFiles: ['yarn.lock'] }));
    const rec = selection() as { outcome: { decision: Record<string, unknown> } };
    expect(rec.outcome.decision).toMatchObject({
      set: 'three',
      source: 'config',
      decidedBy: 'veto:path-lockfile',
    });
  });

  it('a failing sink never changes the result', async () => {
    const bad: JudgmentSink = {
      record() {
        throw new Error('disk full');
      },
    };
    const { ctx } = ctxFor({ sinks: [bad] });
    expect((await selectReviewerSet(base({ judgment: ctx }))).reviewers).toEqual(MERGED);
  });
});

describe('routeReviewers', () => {
  const ROUTE = {
    changedFiles: ['pipeline-cli/src/parse.ts'],
    diff: 'diff --git a/pipeline-cli/src/parse.ts b/pipeline-cli/src/parse.ts\n+JSON.parse(x)\n',
  };

  it('without a judgment layer returns the input set unchanged', async () => {
    const out = await routeReviewers({ reviewers: MERGED, ...ROUTE });
    expect(out).toEqual({ reviewers: MERGED, added: [], signals: [] });
  });

  it('adds the security reviewer when a Noul clears its threshold on an unflagged diff', async () => {
    const { ctx } = ctxFor({ routing: { 'input-handling': 0.9, 'auth-session-secrets': 0 } });
    const out = await routeReviewers({
      reviewers: ['code-reviewer'],
      ...ROUTE,
      judgment: ctx,
      sourceKind: 'backlog',
    });
    expect(out.reviewers).toEqual(['code-reviewer', 'test-reviewer', 'security-reviewer']);
    expect(out.signals).toEqual(['input-handling']);
    expect(out.reviewers).toContain('security-reviewer');
  });

  it('can add back to the merged set and never returns fewer than it received', async () => {
    const { ctx } = ctxFor({
      routing: { 'auth-session-secrets': 0.9, 'input-handling': 0, 'dependencies-ci': 0 },
    });
    const out = await routeReviewers({ reviewers: MERGED, ...ROUTE, judgment: ctx });
    expect(out.reviewers).toEqual([...MERGED, 'test-reviewer', 'code-reviewer']);
    expect(out.reviewers.length).toBeGreaterThanOrEqual(MERGED.length);
    for (const r of MERGED) expect(out.reviewers).toContain(r);
  });

  it('fires at exactly the threshold and not just below it', async () => {
    const at = ctxFor({ routing: { 'input-handling': 0.5 } });
    expect(
      (await routeReviewers({ reviewers: ['code-reviewer'], ...ROUTE, judgment: at.ctx })).added,
    ).toEqual(['test-reviewer', 'security-reviewer']);
    const below = ctxFor({ routing: { 'input-handling': 0.4999 } });
    expect(
      (await routeReviewers({ reviewers: ['code-reviewer'], ...ROUTE, judgment: below.ctx })).added,
    ).toEqual([]);
  });

  it('logs the path-classifier incumbent and the signals that decided', async () => {
    const records: { judgmentId: string; incumbent?: unknown; outcome: unknown }[] = [];
    const { ctx } = ctxFor({ routing: { 'input-handling': 0.9 } });
    await routeReviewers({
      reviewers: ['code-reviewer'],
      ...ROUTE,
      judgment: { ...ctx, sinks: [{ record: (r) => void records.push(r) }] },
    });
    const rec = records.find((r) => r.judgmentId === 'review.routing');
    expect(rec?.incumbent).toEqual({ reviewers: ['testing', 'critic', 'security'] });
    expect(rec?.outcome).toMatchObject({
      kind: 'act',
      decision: { signals: ['input-handling'], called: ['testing', 'security'] },
    });
  });

  it('shadow mode and abstains leave the set unchanged', async () => {
    const shadow = ctxFor({ routing: { 'input-handling': 0.9 }, routingMode: 'shadow' });
    expect(
      (await routeReviewers({ reviewers: MERGED, ...ROUTE, judgment: shadow.ctx })).reviewers,
    ).toEqual(MERGED);
    const quiet = ctxFor({
      routing: { 'input-handling': 0.1, 'auth-session-secrets': 0.1, 'dependencies-ci': 0.1 },
    });
    expect(
      (await routeReviewers({ reviewers: THREE, ...ROUTE, judgment: quiet.ctx })).added,
    ).toEqual([]);
  });

  it('pathClassifierReviewers mirrors the ruleset', () => {
    expect(pathClassifierReviewers(['README.md'])).toEqual(['critic']);
    expect(pathClassifierReviewers(['src/a.ts'])).toEqual(['testing', 'critic', 'security']);
  });

  it('reviewPaths includes both sides of renames', () => {
    expect(reviewPaths(['b.ts'], 'diff --git a/a.ts b/b.ts\n').sort()).toEqual(['a.ts', 'b.ts']);
  });
});
