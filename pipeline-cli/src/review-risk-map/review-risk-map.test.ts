import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disabledJudgmentConfig,
  FakeJudgmentProvider,
  validateReviewRiskMap,
  type EvaluateJudgmentContext,
  type JudgmentAnswer,
  type JudgmentSink,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBaselineProbes, type RiskMapInput } from '../review-plan/index.js';
import {
  buildRiskMap,
  classifyFile,
  collectStructural,
  HUNK_RISK_ID,
  INJECTION_SCREEN_ID,
  matchChangedTests,
  normalizeFacts,
  parseDiff,
  runSplitting,
  runStage0,
  unavailableStructuralProvider,
  type HunkStructuralFacts,
  type StructuralProvider,
} from './index.js';

const SECRET = `sk-ant-api03-${'A'.repeat(30)}`;

const DIFF = [
  'diff --git a/src/auth/login.ts b/src/auth/login.ts',
  'index 111..222 100644',
  '--- a/src/auth/login.ts',
  '+++ b/src/auth/login.ts',
  '@@ -1,3 +1,4 @@ export function login()',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a;',
  'diff --git a/src/util.ts b/src/util.ts',
  'index 333..444 100644',
  '--- a/src/util.ts',
  '+++ b/src/util.ts',
  '@@ -10,2 +10,2 @@ export function util()',
  ' keep',
  '-old',
  '+new',
  'diff --git a/src/util.test.ts b/src/util.test.ts',
  'index 555..666 100644',
  '--- a/src/util.test.ts',
  '+++ b/src/util.test.ts',
  '@@ -1,1 +1,2 @@',
  ' x',
  '+y',
  '',
].join('\n');

const KEY = 'fake@fake-1';

function enforceConfig(mode: 'enforce' | 'shadow' = 'enforce'): ResolvedJudgmentConfig {
  const thresholds: Record<string, Record<string, number>> = {
    [HUNK_RISK_ID]: { unused: 1 },
    [INJECTION_SCREEN_ID]: { flag: 0.5 },
    'dev.ac-coverage': { covered: 0.5 },
    'review.routing': {
      'auth-session-secrets': 0.5,
      'input-handling': 0.5,
      'dependencies-ci': 0.5,
    },
  };
  const judgments: ResolvedJudgmentConfig['judgments'] = {};
  for (const [id, th] of Object.entries(thresholds)) {
    judgments[id] = {
      mode,
      thresholds: { [KEY]: th },
      promotion: { [KEY]: { path: 'override', evidence: 'test fixture' } },
    };
  }
  return {
    provider: 'fake',
    model: 'fake-1',
    providerOptions: {},
    egressAllow: ['code-diff'],
    defaults: { mode, timeoutMs: 2000, cache: false },
    judgments,
  };
}

const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const score = (level: number): JudgmentAnswer => ({
  type: 'score',
  score: level,
  probabilities: [0, 0, 0, 0, 0].map((_, i) => (i === level ? 1 : 0)),
  confidence: 0.9,
});

const NOUL_SUFFIXES = ['auth', 'state', 'concurrency', 'input', 'errors', 'untested'];

function scriptHunk(
  fake: FakeJudgmentProvider,
  id: string,
  level: number,
  p: { auth?: number; other?: number } = {},
): void {
  for (const s of NOUL_SUFFIXES) {
    fake.script(`${id}.${s}`, noul(s === 'auth' ? (p.auth ?? 0.1) : (p.other ?? 0.1)));
  }
  fake.script(`${id}.risk`, score(level));
}

function scriptDiffLevel(fake: FakeJudgmentProvider, coverage = 0.9): void {
  fake.script('addressesModel', noul(0.05));
  fake.script('requestsSecrets', noul(0.05));
  fake.script('requestsDisable', noul(0.05));
  fake.script('ac-0', noul(coverage));
  fake.script('ac-1', noul(coverage));
  fake.script('auth-session-secrets', noul(0));
  fake.script('input-handling', noul(0.9));
  fake.script('dependencies-ci', noul(0));
}

function ctxFor(
  fake: FakeJudgmentProvider,
  config: ResolvedJudgmentConfig = enforceConfig(),
  sinks: JudgmentSink[] = [],
): EvaluateJudgmentContext {
  return { config, getProvider: () => fake, sinks };
}

const FACTS: HunkStructuralFacts = {
  symbols: ['login'],
  callers: ['app.ts#main'],
  callees: ['hash'],
  referencingTests: [],
  coverageLines: [2, 3],
  schemaConsumers: [],
};

const factsProvider: StructuralProvider = {
  factsFor: (h) =>
    h.file === 'src/auth/login.ts'
      ? { ...FACTS, referencingTests: ['src/util.test.ts'] }
      : { ...FACTS, symbols: [h.id], coverageLines: [h.startLine] },
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'risk-map-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stage 0', () => {
  it('classifies files by path', () => {
    expect(classifyFile('.github/workflows/ci.yml')).toBe('workflow');
    expect(classifyFile('package.json')).toBe('manifest');
    expect(classifyFile('pnpm-lock.yaml')).toBe('lockfile');
    expect(classifyFile('db/migrations/001.sql')).toBe('migration');
    expect(classifyFile('docs/guide.md')).toBe('docs');
    expect(classifyFile('src/a.test.ts')).toBe('test');
    expect(classifyFile('pkg/__tests__/a.ts')).toBe('test');
    expect(classifyFile('tsconfig.json')).toBe('config');
    expect(classifyFile('.eslintrc.cjs')).toBe('config');
    expect(classifyFile('src/a.ts')).toBe('source');
  });

  it('matches changed tests to a source file by name', () => {
    expect(matchChangedTests('src/util.ts', ['src/util.test.ts', 'src/other.test.ts'])).toEqual([
      'src/util.test.ts',
    ]);
    expect(matchChangedTests('app/foo.py', ['tests/test_foo.py'])).toEqual(['tests/test_foo.py']);
  });

  it('computes statistics, classes and per-file changed tests', () => {
    const s0 = runStage0(DIFF);
    expect(s0.stats).toEqual({
      filesChanged: 3,
      linesAdded: 4,
      linesRemoved: 2,
      hunks: 3,
      unparseableHeaders: 0,
    });
    expect(s0.changedTestFiles).toEqual(['src/util.test.ts']);
    expect(s0.files.find((f) => f.path === 'src/util.ts')?.nameMatchedTests).toEqual([
      'src/util.test.ts',
    ]);
    expect(s0.files.find((f) => f.path === 'src/auth/login.ts')?.nameMatchedTests).toEqual([]);
    expect(s0.flags).toEqual({
      dependencyManifestChanged: false,
      workflowChanged: false,
      secretsFound: false,
    });
  });

  it('flags manifest and workflow changes', () => {
    const d = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');
    const s0 = runStage0(d);
    expect(s0.flags.dependencyManifestChanged).toBe(true);
    expect(s0.flags.workflowChanged).toBe(true);
  });

  it('records a secret as a redaction marker only', () => {
    const d = [
      'diff --git a/src/k.ts b/src/k.ts',
      '--- a/src/k.ts',
      '+++ b/src/k.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      `+const key = "${SECRET}";`,
    ].join('\n');
    const s0 = runStage0(d);
    expect(s0.flags.secretsFound).toBe(true);
    expect(s0.hunks[0].secretMarkers).toEqual(['[REDACTED:ANTHROPIC]']);
    expect(JSON.stringify(s0)).not.toContain(SECRET);
  });
});

describe('diff parser', () => {
  it('keeps a body line that looks like a header inside its hunk', () => {
    const d = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '--- not a header',
      '+++ not a header',
      '\\ No newline at end of file',
    ].join('\n');
    const [f] = parseDiff(d);
    expect(f.hunks).toHaveLength(1);
    expect(f.removed).toBe(1);
    expect(f.added).toBe(1);
  });

  it('gives a binary file and a pure rename a placeholder hunk', () => {
    const d = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    const files = parseDiff(d);
    expect(files.map((f) => f.path)).toEqual(['img.png', 'new.ts']);
    expect(files[0].binary).toBe(true);
    expect(files.every((f) => f.hunks.length === 1 && f.hunks[0].synthetic)).toBe(true);
  });

  it('reports a header it cannot read as a plain path', () => {
    const d = ['diff --git "a/we ird.ts" "b/we ird.ts"', '--- a/x', '+++ b/x'].join('\n');
    const [f] = parseDiff(d);
    expect(f.unparseable).toBe(false); // the plain +++ line resolved it
    const q = parseDiff('diff --git "a/q.ts" "b/q.ts"\n');
    expect(q[0].unparseable).toBe(true);
    expect(runStage0('diff --git "a/q.ts" "b/q.ts"\n').stats.unparseableHeaders).toBe(1);
  });

  it('handles a single-line hunk header and a deleted file', () => {
    const d = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
    ].join('\n');
    const [f] = parseDiff(d);
    expect(f.path).toBe('gone.ts');
    expect(f.hunks[0].startLine).toBe(1);
    expect(f.removed).toBe(1);
  });

  it('closes a hunk that ends before its declared line count', () => {
    const d = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,5 +1,5 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n');
    expect(parseDiff(d).map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('stage 1 structural provider', () => {
  const ref = {
    id: 'h1',
    file: 'a.ts',
    fileClass: 'source' as const,
    startLine: 1,
    endLine: 2,
    text: '',
  };

  it('treats the default provider, a throwing provider and junk as unavailable', async () => {
    const throwing: StructuralProvider = {
      factsFor: () => {
        throw new Error('boom');
      },
    };
    const junk = { factsFor: () => 'nope' } as unknown as StructuralProvider;
    expect(
      (await collectStructural([ref], unavailableStructuralProvider)).get('h1'),
    ).toBeUndefined();
    expect((await collectStructural([ref], throwing)).get('h1')).toBeUndefined();
    expect((await collectStructural([ref], junk)).get('h1')).toBeUndefined();
  });

  it('normalizes facts: drops bad entries, dedupes, sorts lines', () => {
    const f = normalizeFacts({
      symbols: ['a', 'a', '', 5],
      callers: 'x',
      coverageLines: [3, 1, 1, 0, -2, 2.5],
    });
    expect(f).toEqual({
      symbols: ['a'],
      callers: [],
      callees: [],
      referencingTests: [],
      coverageLines: [1, 3],
      schemaConsumers: [],
    });
    expect(normalizeFacts(null)).toBeUndefined();
    expect(normalizeFacts([])).toBeUndefined();
  });
});

describe('request splitting', () => {
  it('halves on state-too-large and stops at one item', async () => {
    const seen: number[] = [];
    const parts = await runSplitting([1, 2, 3, 4, 5], async (chunk) => {
      seen.push(chunk.length);
      return chunk.length > 1
        ? ({ kind: 'abstain', reason: 'state-too-large' } as const)
        : ({ kind: 'act', decision: chunk[0] } as const);
    });
    expect(parts.map((p) => p.items)).toEqual([[1], [2], [3], [4], [5]]);
    const single = await runSplitting([1], async () => ({
      kind: 'abstain',
      reason: 'state-too-large',
    }));
    expect(single).toHaveLength(1);
    expect(seen[0]).toBe(5);
  });
});

describe('buildRiskMap', () => {
  it('lists every hunk for a three-file diff with its facts, and validates', async () => {
    const dir = tmp();
    const { map, filePath } = await buildRiskMap(DIFF, {
      artifactsDir: dir,
      runId: 'fixture',
      structural: factsProvider,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(validateReviewRiskMap(map).valid).toBe(true);
    expect(map.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(map.hunks).toHaveLength(3);
    const byFile = Object.fromEntries(map.hunks.map((h) => [h.file, h]));
    expect(byFile['src/auth/login.ts']).toMatchObject({
      fileClass: 'source',
      testsChanged: true, // a referencing test that also changed
      symbols: ['login'],
      startLine: 1,
      endLine: 4,
      structural: { status: 'available', callers: ['app.ts#main'], coverageLines: [2, 3] },
    });
    expect(byFile['src/util.ts']).toMatchObject({
      fileClass: 'source',
      testsChanged: true, // name match
      startLine: 10,
      endLine: 11,
      structural: { status: 'available', coverageLines: [10] },
    });
    expect(byFile['src/util.test.ts']).toMatchObject({ fileClass: 'test', testsChanged: true });
    expect(map.changedSourceFiles).toEqual([
      { path: 'src/auth/login.ts', changedTests: ['src/util.test.ts'] },
      { path: 'src/util.ts', changedTests: ['src/util.test.ts'] },
    ]);
    expect(filePath).toBe(join(dir, '_review-risk-map', 'fixture.json'));
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(map);
  });

  it('marks every hunk structural unavailable and ranked high with the default provider', async () => {
    const { map } = await buildRiskMap(DIFF, { artifactsDir: tmp() });
    for (const h of map.hunks) {
      expect(h.structural).toEqual({ status: 'unavailable' });
      expect(h.symbols).toBeUndefined();
      expect(h.riskScore).toBe(1);
      expect(h.judged).toBe(false);
    }
    // path rules still flag the authentication path
    expect(map.hunks.find((h) => h.file === 'src/auth/login.ts')?.flags).toEqual([
      'authentication',
      'authorization',
    ]);
  });

  it('leaves every hunk unjudged and high with the judgment layer disabled', async () => {
    for (const judgment of [undefined, { config: disabledJudgmentConfig() }]) {
      const { map } = await buildRiskMap(DIFF, {
        artifactsDir: tmp(),
        structural: factsProvider,
        acceptanceCriteria: ['a', 'b'],
        ...(judgment ? { judgment } : {}),
      });
      expect(map.hunks.every((h) => !h.judged && h.riskScore === 1 && !h.nouls)).toBe(true);
      expect(map.acCoverage).toEqual({ status: 'unavailable', uncovered: 2 });
      expect(map.criteria.every((c) => c.likelyUncovered)).toBe(true);
      expect(map.injectionScreen).toEqual({ status: 'unavailable', findings: [] });
      expect(map.routing.status).toBe('path-rules-only');
      expect(map.routing.reviewers.length).toBeGreaterThan(0);
    }
  });

  it('ranks by the judged Score and attaches Nouls when a provider answers', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 4, { auth: 0.9 });
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 2);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.hunks.map((h) => h.id)).toEqual(['h1', 'h3', 'h2']);
    expect(map.hunks.map((h) => h.riskScore)).toEqual([1, 0.5, 0]);
    expect(map.hunks.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(map.hunks.every((h) => h.judged && h.nouls && h.judgmentScore !== undefined)).toBe(true);
    expect(map.hunks[0].nouls?.authAuthz).toBe(0.9);
    expect(map.hunks[0].flags).toEqual(['authentication', 'authorization']);
    expect(map.hunks[2].judgmentScore).toBe(0);

    expect(map.criteria).toEqual([
      { id: 'ac-1', text: 'first', likelyUncovered: false, coverageProbability: 0.9 },
      { id: 'ac-2', text: 'second', likelyUncovered: false, coverageProbability: 0.9 },
    ]);
    expect(map.acCoverage).toEqual({ status: 'evaluated', uncovered: 0 });
    expect(map.injectionScreen).toEqual({ status: 'clean', findings: [] });
    expect(map.routing.status).toBe('judged');
    expect(map.routing.signals).toEqual(['input-handling']);
    expect(map.routing.reviewers).toEqual(expect.arrayContaining(['testing', 'security']));
  });

  it('ranks a judged hunk with unavailable structural facts as high', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 0);
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 0);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(DIFF, { artifactsDir: tmp(), judgment: ctxFor(fake) });
    expect(map.hunks.every((h) => h.judged && h.riskScore === 1)).toBe(true);
  });

  it('reports a suspicious injection screen and uncovered criteria', async () => {
    const fake = new FakeJudgmentProvider();
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(fake, id, 1);
    scriptDiffLevel(fake, 0.1);
    fake.script('addressesModel', noul(0.95));
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.injectionScreen.status).toBe('suspicious');
    expect(map.injectionScreen.findings).toHaveLength(1);
    expect(map.acCoverage).toEqual({ status: 'evaluated', uncovered: 2 });
    expect(map.criteria.every((c) => c.likelyUncovered)).toBe(true);
  });

  it('ranks every hunk as unjudged and high when the injection screen is suspicious', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 0);
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 0);
    scriptDiffLevel(fake);
    fake.script('addressesModel', noul(0.95));
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.injectionScreen.status).toBe('suspicious');
    expect(map.hunks.every((h) => !h.judged && h.riskScore === 1)).toBe(true);
    expect(map.hunks.every((h) => h.nouls === undefined)).toBe(true);
  });

  it('ranks every hunk as unjudged and high when the injection screen is unavailable', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 0);
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 0);
    fake.script('ac-0', noul(0.9));
    fake.script('ac-1', noul(0.9));
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.injectionScreen.status).toBe('unavailable');
    expect(map.hunks.every((h) => !h.judged && h.riskScore === 1)).toBe(true);
  });

  it('uses the judged scores when the injection screen is clean', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 0);
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 0);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.injectionScreen.status).toBe('clean');
    expect(map.hunks.every((h) => h.judged && h.riskScore === 0)).toBe(true);
  });

  it('redacts a secret-shaped changed file path before the routing request', async () => {
    const d = [
      `diff --git a/src/${SECRET}.ts b/src/${SECRET}.ts`,
      `--- a/src/${SECRET}.ts`,
      `+++ b/src/${SECRET}.ts`,
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
    ].join('\n');
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 2);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(d, { artifactsDir: tmp(), judgment: ctxFor(fake) });
    expect(JSON.stringify(fake.requests)).not.toContain(SECRET);
    expect(JSON.stringify(map)).not.toContain(SECRET);
  });

  it('marks hunks unjudged when the provider cannot answer', async () => {
    const fake = new FakeJudgmentProvider(); // nothing scripted: every call is a provider error
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first'],
      judgment: ctxFor(fake),
    });
    expect(map.hunks.every((h) => !h.judged && h.riskScore === 1)).toBe(true);
    expect(map.injectionScreen.status).toBe('unavailable');
    expect(map.acCoverage.status).toBe('unavailable');
    expect(map.routing.status).toBe('path-rules-only');
  });

  it('abstains in shadow mode: nothing is judged', async () => {
    const fake = new FakeJudgmentProvider();
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(fake, id, 1);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      judgment: ctxFor(fake, enforceConfig('shadow')),
    });
    expect(map.hunks.every((h) => !h.judged)).toBe(true);
  });

  it('splits requests by the state budget and by the per-request cap', async () => {
    const fake = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 1500 } });
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(fake, id, 3);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      judgment: ctxFor(fake),
    });
    expect(map.hunks.every((h) => h.judged)).toBe(true);
    const hunkRequests = fake.requests.filter((r) => r.consumerLabel === HUNK_RISK_ID);
    expect(hunkRequests.length).toBeGreaterThan(1);

    const capped = new FakeJudgmentProvider();
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(capped, id, 3);
    scriptDiffLevel(capped);
    await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      judgment: ctxFor(capped),
      maxHunksPerRequest: 1,
    });
    expect(capped.requests.filter((r) => r.consumerLabel === HUNK_RISK_ID)).toHaveLength(3);
  });

  it('stays valid when only some requests fit the state budget', async () => {
    // A tiny budget leaves most requests abstaining; the map still validates.
    const fake = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 250 } });
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(fake, id, 3);
    scriptDiffLevel(fake, 0.9);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });
    expect(validateReviewRiskMap(map).valid).toBe(true);
    expect(map.criteria).toHaveLength(2);
  });

  it('never records a secret, only its redaction marker', async () => {
    const d = [
      'diff --git a/src/k.ts b/src/k.ts',
      '--- a/src/k.ts',
      '+++ b/src/k.ts',
      `@@ -1,1 +1,2 @@ const ${SECRET}`,
      ' x',
      `+const key = "${SECRET}";`,
    ].join('\n');
    const dir = tmp();
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 2);
    scriptDiffLevel(fake);
    const { map, filePath } = await buildRiskMap(d, {
      artifactsDir: dir,
      acceptanceCriteria: [`never print ${SECRET}`, 'second'],
      judgment: ctxFor(fake),
    });
    expect(map.hunks[0].secretMarkers).toEqual(['[REDACTED:ANTHROPIC]']);
    expect(map.hunks[0].flags).toContain('secrets');
    expect(map.flags.secretsFound).toBe(true);
    expect(JSON.stringify(map)).not.toContain(SECRET);
    expect(readFileSync(filePath, 'utf8')).not.toContain(SECRET);
    expect(JSON.stringify(fake.requests)).not.toContain(SECRET);
  });

  it('keeps a binary file in the map as an unjudged placeholder', async () => {
    const d = [
      DIFF.trimEnd(),
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    const fake = new FakeJudgmentProvider();
    for (const id of ['h1', 'h2', 'h3']) scriptHunk(fake, id, 0);
    scriptDiffLevel(fake);
    const { map } = await buildRiskMap(d, {
      artifactsDir: tmp(),
      structural: factsProvider,
      judgment: ctxFor(fake),
    });
    const bin = map.hunks.find((h) => h.file === 'img.png');
    expect(bin).toMatchObject({ judged: false, riskScore: 1, rank: 1 });
  });

  it('copies developer verification results and sanitizes the run id', async () => {
    const dir = tmp();
    const { map, filePath } = await buildRiskMap(DIFF, {
      artifactsDir: dir,
      runId: '../weird id',
      verifications: { build: 'passed', test: 'failed', patchCoveragePercent: 87.5 },
    });
    expect(map.verifications).toEqual({
      build: 'passed',
      test: 'failed',
      patchCoveragePercent: 87.5,
    });
    expect(filePath).toBe(join(dir, '_review-risk-map', '.._weird_id.json'));
  });

  it('uses ARTIFACTS_DIR and a default run id when no directory is given', async () => {
    const dir = tmp();
    const prev = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = dir;
    try {
      const { filePath } = await buildRiskMap(DIFF);
      expect(filePath).toBe(join(dir, '_review-risk-map', 'run.json'));
    } finally {
      if (prev === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = prev;
    }
  });

  it('handles an empty diff', async () => {
    const { map } = await buildRiskMap('', { artifactsDir: tmp() });
    expect(map.hunks).toEqual([]);
    expect(validateReviewRiskMap(map).valid).toBe(true);
  });
});

describe('conformance with the baseline checklist input', () => {
  it('is a structural superset of RiskMapInput and drives the checklist', async () => {
    const fake = new FakeJudgmentProvider();
    scriptHunk(fake, 'h1', 4, { auth: 0.9 });
    scriptHunk(fake, 'h2', 0);
    scriptHunk(fake, 'h3', 2);
    scriptDiffLevel(fake, 0.1);
    const { map } = await buildRiskMap(DIFF, {
      artifactsDir: tmp(),
      structural: factsProvider,
      acceptanceCriteria: ['first', 'second'],
      judgment: ctxFor(fake),
    });

    // Type-level: assignable without a cast.
    const input = map satisfies RiskMapInput;

    // Runtime shape: every field the checklist reads is present and typed.
    for (const h of input.hunks) {
      expect(typeof h.id).toBe('string');
      expect(typeof h.file).toBe('string');
      expect(typeof h.fileClass).toBe('string');
      expect(typeof h.riskScore).toBe('number');
      expect(typeof h.judged).toBe('boolean');
      expect(Array.isArray(h.flags)).toBe(true);
    }
    for (const c of input.criteria) expect(typeof c.likelyUncovered).toBe('boolean');
    for (const s of input.changedSourceFiles) expect(Array.isArray(s.changedTests)).toBe(true);
    expect(Array.isArray(input.changedTestFiles)).toBe(true);
    expect(Array.isArray(input.changedFiles)).toBe(true);

    const baseline = buildBaselineProbes(
      input,
      { references: ['src/'] },
      { riskThreshold: 0.5, commandAllowlist: ['pnpm test'] },
    );
    const covered = new Set(baseline.probes.flatMap((p) => p.covers));
    for (const h of map.hunks) expect(covered.has(h.id)).toBe(true);
    // the uncovered criteria drive one compare probe each
    expect(baseline.probes.filter((p) => p.type === 'compare').length).toBeGreaterThanOrEqual(2);
  });
});
