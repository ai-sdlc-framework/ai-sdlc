/**
 * AISDLC-723 — review-scope classifier, signer-side reduction and the CI
 * verifier's re-derivation (`enforceReviewScope`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCS_ONLY_PATTERN,
  checkReviewerCoverage,
  classifyReviewScope,
  parseSecurityReviewAlways,
  reviewerSetKindFor,
} from '../../attestation-core/review-scope-core.mjs';
import { deriveEnvelopeReviewScope } from './review-scope.js';
import { reduceForReviewScope } from '../steps/reviewer-set.js';

type Scoped = { status: string; reason: string; reviewScope?: Record<string, unknown> };
type EnforceFn = (
  result: { status: string; reason: string },
  ctx: {
    envelope: object;
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

const HERE = dirname(fileURLToPath(import.meta.url));
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
    expect(classifyReviewScope(['.\\a\\b.test.ts'.replace(/\\/g, '/')]).classification).toBe(
      'test-only',
    );
    expect(classifyReviewScope(['./a/b.test.ts']).classification).toBe('test-only');
  });

  it('DOCS_ONLY_PATTERN stays in lockstep with scripts/is-docs-only-changeset.mjs', async () => {
    const mod = (await import(
      /* @vite-ignore */ resolve(HERE, '../../../scripts/is-docs-only-changeset.mjs')
    )) as { DOCS_ONLY_PATTERN: RegExp };
    expect(DOCS_ONLY_PATTERN.source).toBe(mod.DOCS_ONLY_PATTERN.source);
  });
});

describe('config + coverage helpers', () => {
  it('parseSecurityReviewAlways', () => {
    expect(parseSecurityReviewAlways('securityReview: always\n')).toBe(true);
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

  it('reads the config via git show on the base ref by default (null off-repo)', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-723-'));
    dirs.push(workDir);
    const r = reduceForReviewScope({ reviewers: three, changedFiles: ['a.test.ts'], workDir });
    expect(r.reviewers).toEqual(['correctness-reviewer']);
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

function envelopeWith(...names: string[]) {
  return { transcriptLeaves: names.map((reviewerName) => ({ reviewerName })) };
}

describe('enforceReviewScope (CI verifier re-derivation)', () => {
  const ok = { status: 'valid', reason: 'ok' };

  it('accepts a correctness-only attestation on a test-only diff and reports the class', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer'),
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
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer'),
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
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer', 'security-reviewer'),
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
      const r = enforceReviewScope(ok, {
        envelope: envelopeWith('correctness-reviewer'),
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
    const r = enforceReviewScope(ok, {
      envelope: {
        ...envelopeWith('correctness-reviewer'),
        reviewScope: { classification: 'test-only', requiredSet: 'correctness-only' },
      },
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.status).toBe('invalid');
  });

  it('securityReview: always on the BASE branch requires security even for tests', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' }, 'securityReview: always\n');
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer'),
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
    // .ai-sdlc/ is trust-chain so the diff is full anyway; confirm the base read is empty.
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer', 'security-reviewer'),
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: base,
    });
    expect(r.reviewScope?.securityAlways).toBe(false);
  });

  it('fails closed to full when the diff cannot be listed', () => {
    const { dir, base, head } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer'),
      repoRoot: dir,
      baseSha: base,
      headSha: head,
      mergeBase: null,
    });
    expect(r.status).toBe('invalid');
  });

  it('survives a git failure listing the diff (bad sha) as full', () => {
    const { dir, base } = makeRepo({ 'src/a.test.ts': 'x' });
    const r = enforceReviewScope(ok, {
      envelope: envelopeWith('correctness-reviewer'),
      repoRoot: dir,
      baseSha: base,
      headSha: 'f'.repeat(40),
      mergeBase: base,
    });
    expect(r.status).toBe('invalid');
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
      appliedReviewers: ['correctness-reviewer'],
    });
  });

  it('returns undefined off-repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-723-nogit-'));
    dirs.push(dir);
    expect(deriveEnvelopeReviewScope(dir, 'a'.repeat(40), [])).toBeUndefined();
  });
});
