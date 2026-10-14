/**
 * AISDLC-723 — review-scope classifier, signer-side reduction and the CI
 * verifier's re-derivation (`enforceReviewScope`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkReviewerCoverage,
  classifyReviewScope,
  isPathMissingGitError,
  parseSecurityReviewAlways,
  reviewerSetKindFor,
} from '../../attestation-core/review-scope-core.mjs';
import { deriveEnvelopeReviewScope } from './review-scope.js';
import { reduceForReviewScope } from '../steps/reviewer-set.js';

type Scoped = { status: string; reason: string; reviewScope?: Record<string, unknown> };
type EnforceFn = (
  result: { status: string; reason: string; [k: string]: unknown },
  ctx: {
    repoRoot: string;
    baseSha: string;
    headSha: string;
    mergeBase: string | null;
  },
) => Scoped;
const verifyCoreUrl = new URL('../../attestation-core/verify-core.mjs', import.meta.url).href;
const enforceReviewScope: EnforceFn = (
  (await import(/* @vite-ignore */ verifyCoreUrl)) as { enforceReviewScope: EnforceFn }
).enforceReviewScope;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('classifyReviewScope', () => {
  it('test-only: every path is a test, fixture or snapshot', () => {
    for (const p of [
      'orchestrator/src/foo.test.ts',
      'a/b.spec.js',
      'x/__tests__/y.ts',
      'x/fixtures/data.json',
      'x/__snapshots__/a.snap',
    ]) {
      expect(classifyReviewScope([p]).classification).toBe('test-only');
    }
  });

  it('docs-adjacent: Markdown anywhere or a docs-only path', () => {
    expect(classifyReviewScope(['orchestrator/README.md', 'docs/a/b.png']).classification).toBe(
      'docs-adjacent',
    );
    expect(classifyReviewScope(['pipeline-cli/docs/x.md']).classification).toBe('docs-adjacent');
  });

  it('a test file under hooks selects the full set', () => {
    expect(classifyReviewScope(['ai-sdlc-plugin/hooks/enforce.test.js']).classification).toBe(
      'full',
    );
    expect(classifyReviewScope(['tools/hook-runner.test.ts']).classification).toBe('full');
  });

  it('tests for attestation / signing / security code force full', () => {
    for (const p of [
      'pipeline-cli/src/attestation/sign-v6.test.ts',
      'scripts/verify-attestation.test.mjs',
      'x/security-gate.test.ts',
      'x/fixtures/trusted-reviewers.yaml.test.ts',
    ]) {
      expect(classifyReviewScope([p]).classification).toBe('full');
    }
  });

  it('a mixed source and test diff is not downgraded', () => {
    expect(
      classifyReviewScope(['orchestrator/src/a.ts', 'orchestrator/src/a.test.ts']).classification,
    ).toBe('full');
    expect(classifyReviewScope(['a.test.ts', 'README.md']).classification).toBe('full');
  });

  it('trust-chain paths, workflows and plugin markdown force full', () => {
    for (const p of [
      '.github/workflows/ci.yml',
      'ai-sdlc-plugin/agents/security-reviewer.md',
      '.ai-sdlc/review-policy.md',
      'pipeline-cli/attestation-core/verify-core.mjs',
      'scripts/verify-attestation.mjs',
    ]) {
      expect(classifyReviewScope([p]).classification).toBe('full');
    }
  });

  it('agent-instruction Markdown outside the plugin forces full', () => {
    for (const p of [
      '.claude/commands/foo.md',
      '.codex/prompts/x.md',
      '.cursor/rules/a.md',
      '.opencode/agent/a.md',
      'CLAUDE.md',
      'packages/x/AGENTS.md',
      'a/b/c/skill.md',
      'a/SKILL.MD',
    ]) {
      expect(classifyReviewScope([p]).classification).toBe('full');
    }
  });

  it('is case-insensitive and NFC-normalised for trust-chain and workflow paths', () => {
    expect(classifyReviewScope(['.GitHub/Workflows/ci.yml']).classification).toBe('full');
    expect(classifyReviewScope(['AI-SDLC-Plugin/agents/a.md']).classification).toBe('full');
    expect(classifyReviewScope(['Scripts/Verify-Attestation.mjs']).classification).toBe('full');
  });

  it('broadened security keywords force full for tests', () => {
    for (const w of ['merge', 'eligibility', 'reviewer', 'gate', 'guard', 'role', 'bypass']) {
      expect(classifyReviewScope([`src/${w}.test.ts`]).classification).toBe('full');
    }
    expect(classifyReviewScope(['src/dor-check.test.ts']).classification).toBe('full');
    expect(classifyReviewScope(['src/pre-push.test.ts']).classification).toBe('full');
  });

  it('data under .ai-sdlc (decisions, envelopes) stays docs-equivalent', () => {
    expect(classifyReviewScope(['.ai-sdlc/_decisions/DEC-1.md']).classification).toBe(
      'docs-adjacent',
    );
  });

  it('empty and unparseable path lists are full', () => {
    expect(classifyReviewScope([]).classification).toBe('full');
    expect(classifyReviewScope(['../x.md']).classification).toBe('full');
    expect(classifyReviewScope(['']).classification).toBe('full');
  });

  it('normalises backslashes and leading ./', () => {
    expect(classifyReviewScope(['.\\a\\b.test.ts']).classification).toBe('test-only');
    expect(classifyReviewScope(['.\\.github\\workflows\\ci.yml']).classification).toBe('full');
    expect(classifyReviewScope(['./a/b.test.ts']).classification).toBe('test-only');
  });
});

describe('config + coverage helpers', () => {
  it('parseSecurityReviewAlways', () => {
    expect(parseSecurityReviewAlways('securityReview: always\n')).toBe(true);
    expect(parseSecurityReviewAlways('SecurityReview: ALWAYS\n')).toBe(true);
    expect(parseSecurityReviewAlways('reviewerSet: three\n  securityReview: "always" # x')).toBe(
      true,
    );
    expect(parseSecurityReviewAlways('securityReview: auto')).toBe(false);
    expect(parseSecurityReviewAlways(null)).toBe(false);
  });

  it('reviewerSetKindFor honours securityAlways', () => {
    expect(reviewerSetKindFor('test-only')).toBe('correctness-only');
    expect(reviewerSetKindFor('test-only', { securityAlways: true })).toBe('full');
    expect(reviewerSetKindFor('full')).toBe('full');
  });

  it('checkReviewerCoverage', () => {
    expect(checkReviewerCoverage(['correctness-reviewer'], 'test-only').ok).toBe(true);
    expect(
      checkReviewerCoverage(['code-reviewer-codex', 'test-reviewer'], 'docs-adjacent').ok,
    ).toBe(true);
    expect(checkReviewerCoverage(['security-reviewer'], 'test-only').ok).toBe(false);
    const r = checkReviewerCoverage(['correctness-reviewer'], 'full');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['security-reviewer']);
    expect(checkReviewerCoverage(['correctness-reviewer', 'security-reviewer'], 'full').ok).toBe(
      true,
    );
  });
});

describe('reduceForReviewScope (signer-side selection)', () => {
  const three = ['code-reviewer', 'test-reviewer', 'security-reviewer'] as const;
  const noConfig = () => null;

  it('a test-only diff selects correctness only', () => {
    const r = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['pipeline-cli/src/x.test.ts'],
      readBaseConfig: noConfig,
    });
    expect(r.reviewers).toEqual(['correctness-reviewer']);
    expect(r.classification).toBe('test-only');
  });

  it('a test file under hooks selects the full set', () => {
    const r = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['ai-sdlc-plugin/hooks/a.test.js'],
      readBaseConfig: noConfig,
    });
    expect(r.reviewers).toEqual([...three]);
  });

  it('a mixed source and test diff is not downgraded', () => {
    const r = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['a.ts', 'a.test.ts'],
      readBaseConfig: noConfig,
    });
    expect(r.reviewers).toEqual([...three]);
    expect(r.classification).toBe('full');
  });

  it('securityReview: always on the base branch keeps the full set', () => {
    const r = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['a.test.ts'],
      readBaseConfig: () => 'securityReview: always\n',
    });
    expect(r.reviewers).toEqual([...three]);
    expect(r.securityAlways).toBe(true);
  });

  it('an unavailable diff never reduces', () => {
    const r = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['a.test.ts'],
      diffUnavailable: true,
      readBaseConfig: noConfig,
    });
    expect(r.reviewers).toEqual([...three]);
  });

  it('reads the config via git show on the base ref by default (fails closed off-repo)', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-723-'));
    dirs.push(workDir);
    const r = reduceForReviewScope({ reviewers: three, changedFiles: ['a.test.ts'], workDir });
    // A git error that is not "path does not exist" fails closed to the full set.
    expect(r.reviewers).toEqual([...three]);
    expect(r.securityAlways).toBe(true);
  });
});

// ── real-git tests for the verifier re-derivation ─────────────────────────────

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** Build a repo whose `main` is the base and HEAD adds `files`; returns shas. */
function makeRepo(
  files: Record<string, string>,
  baseConfig?: string,
): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-723-git-'));
  dirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed');
  if (baseConfig !== undefined) {
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'review-config.yaml'), baseConfig);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'update-ref', 'refs/remotes/origin/main', base);
  sh(dir, 'checkout', '-q', '-b', 'pr');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'pr');
  return { dir, base, head: sh(dir, 'rev-parse', 'HEAD') };
}

function withNames(...names: string[]) {
  return { status: 'valid', reason: 'ok', verifiedReviewerNames: names };
}

describe('enforceReviewScope (CI verifier re-derivation)', () => {
  it('accepts a correctness-only attestation on a test-only diff and reports the class', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.status).toBe('valid');
    expect(r.reviewScope?.classification).toBe('test-only');
    expect(r.reviewScope?.requiredSet).toBe('correctness-only');
  });

  it('rejects a correctness-only attestation on a source diff', () => {
    const { dir, base, head } = makeRepo({ 'src/a.ts': 'x' });
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain("'full' diff");
    expect(r.reason).toContain('security-reviewer');
  });

  it('accepts the full set on a source diff', () => {
    const { dir, base, head } = makeRepo({ 'src/a.ts': 'x' });
    const r = enforceReviewScope(withNames('correctness-reviewer', 'security-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.status).toBe('valid');
  });

  it('rejects correctness-only for a test under hooks and for a mixed diff', () => {
    const cases: Record<string, string>[] = [
      { 'ai-sdlc-plugin/hooks/a.test.js': 'x' },
      { 'src/a.ts': 'x', 'src/a.test.ts': 'y' },
    ];
    for (const files of cases) {
      const { dir, base, head } = makeRepo(files);
      const r = enforceReviewScope(withNames('correctness-reviewer'), {
        repoRoot: dir,
        baseSha: base,
        headSha: head,
        mergeBase: base,
      });
      expect(r.status).toBe('invalid');
    }
  });

  it('does not trust a classification field written by the signer', () => {
    const { dir, base, head } = makeRepo({ 'src/a.ts': 'x' });
    const r = enforceReviewScope(
      {
        ...withNames('correctness-reviewer'),
        reviewScope: { classification: 'test-only', requiredSet: 'correctness-only' },
      },
      {
        repoRoot: dir,
        baseSha: base,
        headSha: head,
        mergeBase: base,
      },
    );
    expect(r.status).toBe('invalid');
  });

  it('securityReview: always on the BASE branch requires security even for tests', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' }, 'securityReview: always\n');
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('securityReview: always');
  });

  it('a config added only in the PR diff is ignored', () => {
    const { dir, base, head } = makeRepo({
      'src/a.test.ts': 'x',
      '.ai-sdlc/review-config.yaml': 'securityReview: always\n',
    });
    // .ai-sdlc/ is trust-chain so the diff needs three reviewers (AISDLC-722); confirm the base
    // read is empty.
    const r = enforceReviewScope(withNames('code-reviewer', 'test-reviewer', 'security-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.reviewScope?.securityAlways).toBe(false);
  });

  it('fails closed to full when the diff cannot be listed', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: null,
    });
    expect(r.status).toBe('invalid');
  });

  it('survives a git failure listing the diff (bad sha) as full', () => {
    const { dir, base } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: base,
      headSha: 'f'.repeat(40),
      mergeBase: base,
    });
    expect(r.status).toBe('invalid');
  });
});

describe('enforceReviewScope fail-closed and name sourcing', () => {
  it('a result carrying no verifiedReviewerNames is rejected (envelope names are never read)', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(
      { status: 'valid', reason: 'ok' },
      { repoRoot: dir, baseSha: base, headSha: head, mergeBase: base },
    );
    expect(r.status).toBe('invalid');
  });

  it('a git error other than a missing path fails closed to securityAlways', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-723-nogit-'));
    dirs.push(dir);
    const r = enforceReviewScope(withNames('correctness-reviewer'), {
      repoRoot: dir,
      baseSha: 'e'.repeat(40),
      headSha: 'f'.repeat(40),
      mergeBase: null,
    });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('securityReview: always');
  });

  it('isPathMissingGitError only matches a definite missing-path error', () => {
    expect(isPathMissingGitError({ stderr: "fatal: path 'x' does not exist in 'abc'" })).toBe(true);
    expect(isPathMissingGitError({ stderr: 'fatal: not a git repository' })).toBe(false);
    expect(isPathMissingGitError(new Error('boom'))).toBe(false);
  });

  it('deriveEnvelopeReviewScope records nothing when the base ref is gone', () => {
    const { dir, head } = makeRepo({ 'src/a.test.ts': 'x' });
    sh(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(deriveEnvelopeReviewScope(dir, head, ['correctness-reviewer'])).toBeUndefined();
  });
});

describe('deriveEnvelopeReviewScope (signer record)', () => {
  it('records classification and applied reviewers', () => {
    const { dir, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const rec = deriveEnvelopeReviewScope(dir, head, ['correctness-reviewer']);
    expect(rec).toEqual({
      classification: 'test-only',
      securityAlways: false,
      requiredSet: 'correctness-only',
      reason: 'every path is a test, fixture or snapshot',
      triggeringPaths: [],
      appliedReviewers: ['correctness-reviewer'],
    });
  });

  it('lists each applied reviewer once in first-seen order (AISDLC-916)', () => {
    const { dir, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const rec = deriveEnvelopeReviewScope(dir, head, [
      'correctness-reviewer',
      'security-reviewer',
      'correctness-reviewer',
      'security-reviewer',
    ]);
    expect(rec?.appliedReviewers).toEqual(['correctness-reviewer', 'security-reviewer']);
  });

  it('returns undefined off-repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-723-nogit-'));
    dirs.push(dir);
    expect(deriveEnvelopeReviewScope(dir, 'a'.repeat(40), [])).toBeUndefined();
  });
});
