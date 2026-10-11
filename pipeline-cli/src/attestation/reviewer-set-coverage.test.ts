/**
 * AISDLC-722 (DEC-0055) — the reviewer set is derived from the diff and the CI verifier
 * re-derives it from the same diff, on top of AISDLC-723's shared classifier.
 *
 * Covers: the single trust-chain path list (and that the pipeline and the verifier import the
 * SAME module), the classifier and its three kinds, the verifier rejecting an attestation
 * whose proven reviewers do not cover the re-derived kind, and the audit record the signer
 * writes. Hermetic: temp dirs only, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkReviewerKindCoverage,
  isSuspectPath,
  isTrustChainPath,
  matchTrustChainPaths,
  parseReviewerSetConfig,
  requiredReviewerKind,
} from '../../attestation-core/review-scope-core.mjs';
import {
  classifyReviewerSet,
  reduceForReviewScope,
  selectReviewerSet,
} from '../steps/reviewer-set.js';
import { deriveEnvelopeReviewScope } from './review-scope.js';
import { appendLeafForPatchId } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';

type Scoped = {
  status: string;
  reason: string;
  reviewScope?: Record<string, unknown>;
};
type EnforceFn = (
  result: { status: string; reason: string; [k: string]: unknown },
  ctx: { repoRoot: string; baseSha: string; headSha: string; mergeBase: string | null },
) => Scoped;
const verifyCoreUrl = new URL('../../attestation-core/verify-core.mjs', import.meta.url).href;
const enforceReviewScope: EnforceFn = (
  (await import(/* @vite-ignore */ verifyCoreUrl)) as { enforceReviewScope: EnforceFn }
).enforceReviewScope;

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE_CLI = join(HERE, '..', '..');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('trust-chain path list', () => {
  it.each([
    'ai-sdlc-plugin/hooks/enforce-blocked-actions.js',
    'ai-sdlc-plugin/hooks/lib/governance-resolver.js',
    'pipeline-cli/src/attestation/sign-v6.ts',
    'pipeline-cli/attestation-core/verify-core.mjs',
    'scripts/verify-attestation.mjs',
    'scripts/check-attestation-sign.sh',
    'spec/schemas/agent-role.schema.json',
    'pipeline-cli/src/governance/merge-if-eligible.ts',
    'pipeline-cli/src/cli/merge-if-eligible.ts',
    '.ai-sdlc/agent-role.yaml',
    '.ai-sdlc/review-policy.md',
    '.ai-sdlc/review-config.yaml',
    '.github/workflows/ci.yml',
    'ai-sdlc-plugin/agents/security-reviewer.md',
    'ai-sdlc-plugin/agents/correctness-reviewer.md',
    'ai-sdlc-plugin/agents/code-reviewer-codex.md',
    '.husky/pre-push',
    'release-please-config.json',
    '.release-please-manifest.json',
    'ai-sdlc-plugin/.claude-plugin/plugin.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/x.sh',
    '.github/CODEOWNERS',
    '.github/actions/foo/action.yml',
    'packages/x/.github/workflows/ci.yml',
    'scripts/is-docs-only-changeset.mjs',
    'scripts/stage-attestation-data.sh',
    'scripts/drop-stale-attestation-envelope.mjs',
    'scripts/squash-attestation-chores.sh',
    'scripts/pre-push-fixups.sh',
    'scripts/check-task-moved.sh',
    'scripts/check-dark-code-on-push.sh',
    'pipeline-cli/src/cli/attestation.ts',
    'pipeline-cli/bin/cli-attestation.mjs',
    'pipeline-cli/bin/cli-merge-if-eligible.mjs',
    'pipeline-cli/src/hierarchy/lease-policy.ts',
    'pipeline-cli/src/hierarchy/operational.ts',
    'pipeline-cli/src/decisions/governance-fallback.ts',
    'ai-sdlc-plugin/scripts/render-governance-hard-rules.mjs',
    'reference/src/core/generated-schemas.ts',
    'ai-sdlc-plugin/commands/review-pr.md',
    'ai-sdlc-plugin/commands/fix-pr.md',
    'ai-sdlc-plugin/commands/rebase.md',
    'ai-sdlc-plugin/agents/review-executor.md',
    'pipeline-cli/src/orchestrator/reconcile.ts',
    'pipeline-cli/src/steps/07-build-review-prompts.ts',
    'pipeline-cli/src/steps/reviewer-set-comparison.ts',
    'pipeline-cli/src/steps/reviewer-set.ts',
    'CLAUDE.md',
  ])('%s is a trust-chain path', (p) => {
    expect(isTrustChainPath(p)).toBe(true);
  });

  it.each([
    'pipeline-cli/src/dispatch/board.ts',
    'orchestrator/src/foo.ts',
    'docs/operations/reviewer-set-flag.md',
    // Review outputs every reviewed PR carries are not configuration.
    '.ai-sdlc/attestations/abc.v6.dsse.json',
    '.ai-sdlc/transcript-leaves/abc.jsonl',
    '.ai-sdlc/transcript-leaves.jsonl',
    '.ai-sdlc/reviews/aisdlc-1.jsonl',
    // AISDLC-723: decision records stay docs-equivalent data.
    '.ai-sdlc/_decisions/events.jsonl',
    '.ai-sdlc/_decisions/DEC-0001.md',
    'backlog/tasks/aisdlc-1 - x.md',
  ])('%s is not a trust-chain path', (p) => {
    expect(isTrustChainPath(p)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isTrustChainPath('CLAUDE.MD')).toBe(true);
    expect(isTrustChainPath('.GitHub/Workflows/ci.yml')).toBe(true);
    expect(isTrustChainPath('AI-SDLC-Plugin/Hooks/x.js')).toBe(true);
    expect(isTrustChainPath('.AI-SDLC/Attestations/abc.v6.dsse.json')).toBe(false);
  });

  it('fails closed on a quoted, control-character, empty or parent-relative path', () => {
    expect(isSuspectPath('"ai-sdlc-plugin/hooks/h\\303\\251llo.js"')).toBe(true);
    expect(isSuspectPath('a\nb.ts')).toBe(true);
    expect(isSuspectPath('')).toBe(true);
    expect(isSuspectPath(undefined)).toBe(true);
    expect(isSuspectPath('a/../b.ts')).toBe(true);
    expect(isSuspectPath('orchestrator/src/foo.ts')).toBe(false);
    expect(isTrustChainPath('"\\303\\251.ts"')).toBe(true);
    expect(classifyReviewerSet({ changedPaths: ['"\\303\\251.ts"'] })).toMatchObject({
      set: 'three',
      reason: 'trust-chain-path',
    });
    expect(classifyReviewerSet({ changedPaths: ['a\tb.ts'] }).set).toBe('three');
  });

  it('normalises backslashes and a leading ./', () => {
    expect(isTrustChainPath('.\\.github\\workflows\\ci.yml')).toBe(true);
    expect(isTrustChainPath('./ai-sdlc-plugin/hooks/x.js')).toBe(true);
  });

  it('matchTrustChainPaths returns the matching subset once each, in input order', () => {
    expect(
      matchTrustChainPaths(['x.ts', '.github/workflows/a.yml', '.github/workflows/a.yml', 'y.ts']),
    ).toEqual(['.github/workflows/a.yml']);
  });
});

describe('classifyReviewerSet', () => {
  it('an ordinary source diff selects the two-reviewer set', () => {
    expect(classifyReviewerSet({ changedPaths: ['orchestrator/src/foo.ts', 'docs/a.md'] })).toEqual(
      {
        set: 'two',
        reviewers: ['correctness-reviewer', 'security-reviewer'],
        reason: 'no-trust-chain-path',
        triggeringPaths: [],
      },
    );
  });

  it('a diff touching a hook selects three and names the paths that triggered it', () => {
    const c = classifyReviewerSet({
      changedPaths: ['orchestrator/src/foo.ts', 'ai-sdlc-plugin/hooks/x.js'],
    });
    expect(c.set).toBe('three');
    expect(c.reviewers).toEqual(['code-reviewer', 'test-reviewer', 'security-reviewer']);
    expect(c.reason).toBe('trust-chain-path');
    expect(c.triggeringPaths).toEqual(['ai-sdlc-plugin/hooks/x.js']);
  });

  it('opt-out config selects three even for an ordinary diff', () => {
    const c = classifyReviewerSet({
      changedPaths: ['orchestrator/src/foo.ts'],
      requireThree: true,
    });
    expect(c).toMatchObject({ set: 'three', reason: 'config:require-three' });
  });

  it('fails closed to three when the diff is unreadable or empty', () => {
    expect(classifyReviewerSet({ changedPaths: null })).toMatchObject({
      set: 'three',
      reason: 'diff-unavailable',
    });
    expect(classifyReviewerSet({ changedPaths: undefined }).set).toBe('three');
    expect(classifyReviewerSet({ changedPaths: [] })).toMatchObject({
      set: 'three',
      reason: 'no-changed-files',
    });
  });
});

describe('requiredReviewerKind', () => {
  it('maps a diff to correctness-only, two or three', () => {
    expect(requiredReviewerKind(['src/a.test.ts']).kind).toBe('correctness-only');
    expect(requiredReviewerKind(['docs/a.md']).kind).toBe('correctness-only');
    expect(requiredReviewerKind(['src/a.ts']).kind).toBe('two');
    expect(requiredReviewerKind(['src/a.ts', 'src/a.test.ts']).kind).toBe('two');
    expect(requiredReviewerKind(['ai-sdlc-plugin/hooks/a.test.js']).kind).toBe('three');
    expect(requiredReviewerKind(null).kind).toBe('three');
  });

  it('securityReview: always lifts correctness-only to two; reviewerSet: three lifts anything', () => {
    expect(requiredReviewerKind(['src/a.test.ts'], { securityAlways: true }).kind).toBe('two');
    expect(requiredReviewerKind(['src/a.test.ts'], { requireThree: true })).toMatchObject({
      kind: 'three',
      reason: 'config:require-three',
    });
  });
});

describe('checkReviewerKindCoverage', () => {
  it('three needs code, test and security', () => {
    expect(
      checkReviewerKindCoverage(['code-reviewer', 'test-reviewer', 'security-reviewer'], 'three')
        .ok,
    ).toBe(true);
    expect(
      checkReviewerKindCoverage(['correctness-reviewer', 'security-reviewer'], 'three').missing,
    ).toEqual(['code-reviewer', 'test-reviewer']);
  });

  it('two needs security plus correctness (or code and test)', () => {
    expect(checkReviewerKindCoverage(['correctness-reviewer', 'security-reviewer'], 'two').ok).toBe(
      true,
    );
    expect(
      checkReviewerKindCoverage(['code-reviewer', 'test-reviewer', 'security-reviewer'], 'two').ok,
    ).toBe(true);
    expect(checkReviewerKindCoverage(['correctness-reviewer'], 'two').missing).toEqual([
      'security-reviewer',
    ]);
    expect(
      checkReviewerKindCoverage(['code-reviewer', 'security-reviewer'], 'two').missing,
    ).toEqual(['correctness-reviewer (or code-reviewer + test-reviewer)']);
  });

  it('correctness-only needs the correctness review alone', () => {
    expect(checkReviewerKindCoverage(['correctness-reviewer'], 'correctness-only').ok).toBe(true);
    expect(checkReviewerKindCoverage(['security-reviewer'], 'correctness-only').ok).toBe(false);
  });

  it('codex variants satisfy the code and test roles; security has no codex variant', () => {
    expect(
      checkReviewerKindCoverage(
        ['code-reviewer-codex', 'test-reviewer-codex', 'security-reviewer'],
        'three',
      ).ok,
    ).toBe(true);
    expect(
      checkReviewerKindCoverage(['correctness-reviewer', 'security-reviewer-codex'], 'two').missing,
    ).toEqual(['security-reviewer']);
  });
});

describe('parseReviewerSetConfig', () => {
  it('reads three, code-test-merged and auto; null otherwise', () => {
    expect(parseReviewerSetConfig('reviewerSet: three\n')).toBe('three');
    expect(parseReviewerSetConfig("reviewerSet: 'code-test-merged'")).toBe('code-test-merged');
    expect(parseReviewerSetConfig('  reviewerSet: auto')).toBe('auto');
    expect(parseReviewerSetConfig('reviewerSet: bogus')).toBeNull();
    expect(parseReviewerSetConfig(null)).toBeNull();
  });
});

describe('one module, imported by both the pipeline and the verifier', () => {
  const read = (rel: string) => readFileSync(join(PIPELINE_CLI, rel), 'utf8');

  it('the verifier, the pipeline selection and the signer record all import review-scope-core.mjs', () => {
    expect(read('attestation-core/verify-core.mjs')).toMatch(/from '\.\/review-scope-core\.mjs'/);
    expect(read('src/steps/reviewer-set.ts')).toMatch(
      /from '\.\.\/\.\.\/attestation-core\/review-scope-core\.mjs'/,
    );
    expect(read('src/attestation/review-scope.ts')).toMatch(
      /from '\.\.\/\.\.\/attestation-core\/review-scope-core\.mjs'/,
    );
  });

  it('there is no second trust-chain list', () => {
    expect(existsSync(join(PIPELINE_CLI, 'attestation-core/reviewer-set-core.mjs'))).toBe(false);
    for (const rel of [
      'attestation-core/verify-core.mjs',
      'src/steps/reviewer-set.ts',
      'src/attestation/sign-v6.ts',
      'src/attestation/review-scope.ts',
    ]) {
      const text = read(rel);
      // A second list would need these distinctive literals.
      expect(text, rel).not.toContain("'ai-sdlc-plugin/hooks/**'");
      expect(text, rel).not.toContain('TRUST_CHAIN_PATH_GLOBS');
      expect(text, rel).not.toContain('TRUST_CHAIN_PATH_PREFIXES = ');
    }
  });

  it('a diff classifies identically through the pipeline entry point and the verifier core', async () => {
    for (const files of [
      ['orchestrator/src/foo.ts'],
      ['orchestrator/src/foo.ts', 'ai-sdlc-plugin/hooks/x.js'],
      ['.github/workflows/ci.yml'],
      ['docs/a.md'],
    ]) {
      const sel = await selectReviewerSet({
        env: {},
        readBaseConfig: () => null,
        changedFiles: files,
        diff: 'diff --git a/x b/x\n+x\n',
      });
      const verifier = requiredReviewerKind(files);
      expect(sel.classifier.set).toBe(verifier.kind === 'three' ? 'three' : 'two');
      expect(sel.classifier.triggeringPaths).toEqual(verifier.triggeringPaths);
    }
  });
});

// ── real-git tests: the verifier re-derivation and the signer audit record ────────────

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** A repo whose `origin/main` is the base and `pr` adds `files`. */
function makeRepo(
  files: Record<string, string>,
  baseConfig?: string,
): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-722-git-'));
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

const names = (...n: string[]) => ({ status: 'valid', reason: 'ok', verifiedReviewerNames: n });
const TWO = ['correctness-reviewer', 'security-reviewer'];
const THREE = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

function verify(
  repo: { dir: string; base: string; head: string },
  reviewers: string[],
  mergeBase: string | null = repo.base,
) {
  return enforceReviewScope(names(...reviewers), {
    repoRoot: repo.dir,
    baseSha: repo.base,
    headSha: repo.head,
    mergeBase,
  });
}

describe('the verifier re-derives the required set and rejects an uncovering attestation', () => {
  it('accepts a two-leaf attestation on an ordinary diff', () => {
    const r = verify(makeRepo({ 'orchestrator/src/foo.ts': 'x' }), TWO);
    expect(r.status).toBe('valid');
    expect(r.reviewScope).toMatchObject({ requiredSet: 'two', triggeringPaths: [] });
  });

  it('rejects a two-leaf attestation on a trust-chain diff, naming the paths', () => {
    const r = verify(makeRepo({ 'ai-sdlc-plugin/hooks/x.js': 'x' }), TWO);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('reviewer set incomplete');
    expect(r.reason).toContain('requires the three reviewer set');
    expect(r.reason).toContain('ai-sdlc-plugin/hooks/x.js');
    expect(r.reason).toContain('code-reviewer, test-reviewer');
  });

  it('accepts a three-leaf attestation on a trust-chain diff, and on an ordinary diff', () => {
    const r = verify(makeRepo({ 'ai-sdlc-plugin/hooks/x.js': 'x' }), THREE);
    expect(r.status).toBe('valid');
    expect(r.reviewScope).toMatchObject({
      requiredSet: 'three',
      reason: 'trust-chain-path',
      triggeringPaths: ['ai-sdlc-plugin/hooks/x.js'],
    });
    expect(verify(makeRepo({ 'orchestrator/src/foo.ts': 'x' }), THREE).status).toBe('valid');
  });

  it('opt-out config on the BASE requires three even on an ordinary diff', () => {
    const repo = makeRepo({ 'orchestrator/src/foo.ts': 'x' }, 'reviewerSet: three\n');
    const r = verify(repo, TWO);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('config:require-three');
    expect(verify(repo, THREE).status).toBe('valid');
  });

  it('opt-out config also requires three for a test-only diff', () => {
    const repo = makeRepo({ 'src/a.test.ts': 'x' }, 'reviewerSet: three\n');
    expect(verify(repo, ['correctness-reviewer']).status).toBe('invalid');
    expect(verify(repo, THREE).status).toBe('valid');
  });

  it('an unreadable base config fails closed to three (the opt-out is never silently dropped)', () => {
    const repo = makeRepo({ 'orchestrator/src/foo.ts': 'x' }, 'reviewerSet: three\n');
    const unreadable = (reviewers: string[]) =>
      enforceReviewScope(names(...reviewers), {
        repoRoot: repo.dir,
        baseSha: 'f'.repeat(40), // a well-formed sha whose object is absent: `git show` fails
        headSha: repo.head,
        mergeBase: repo.base,
      });
    expect(unreadable(TWO).status).toBe('invalid');
    expect(unreadable(TWO).reason).toContain('config:require-three');
    expect(unreadable(THREE).status).toBe('valid');
  });

  it('a config added only in the PR is never read, but is itself a trust-chain path', () => {
    const repo = makeRepo({
      'orchestrator/src/foo.ts': 'x',
      '.ai-sdlc/review-config.yaml': 'reviewerSet: three\n',
    });
    const r = verify(repo, TWO);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('trust-chain-path');
  });

  it('fails closed to three when the diff cannot be listed', () => {
    const repo = makeRepo({ 'orchestrator/src/foo.ts': 'x' });
    expect(verify(repo, TWO, null).status).toBe('invalid');
    expect(verify(repo, TWO, null).reason).toContain('diff-unavailable');
    expect(verify(repo, THREE, null).status).toBe('valid');
  });

  it('rejects a missing security reviewer', () => {
    const r = verify(makeRepo({ 'orchestrator/src/foo.ts': 'x' }), ['correctness-reviewer']);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('security-reviewer');
  });

  it('a non-ASCII trust-chain filename is read unquoted (-z) and requires three', () => {
    const r = verify(makeRepo({ 'ai-sdlc-plugin/hooks/héllo.js': 'x' }), TWO);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('héllo.js');
  });

  it('ignores review outputs the PR carries (attestations, leaves, ledger, task move)', () => {
    const r = verify(
      makeRepo({
        'orchestrator/src/foo.ts': 'x',
        '.ai-sdlc/attestations/abc.v6.dsse.json': '{}',
        '.ai-sdlc/transcript-leaves/abc.jsonl': '{}',
        '.ai-sdlc/reviews/aisdlc-1.jsonl': '{}',
        'backlog/completed/aisdlc-1 - x.md': 'x',
      }),
      TWO,
    );
    expect(r.status).toBe('valid');
  });

  it('never trusts a reviewScope claim carried by the result', () => {
    const repo = makeRepo({ 'ai-sdlc-plugin/hooks/x.js': 'x' });
    const r = enforceReviewScope(
      {
        ...names(...TWO),
        reviewScope: { classification: 'test-only', requiredSet: 'two', triggeringPaths: [] },
      },
      { repoRoot: repo.dir, baseSha: repo.base, headSha: repo.head, mergeBase: repo.base },
    );
    expect(r.status).toBe('invalid');
  });
});

describe('the signer records the required set and why (audit only)', () => {
  it('records three with the triggering paths, two for an ordinary diff', () => {
    const hook = makeRepo({ 'ai-sdlc-plugin/hooks/x.js': 'x' });
    expect(deriveEnvelopeReviewScope(hook.dir, hook.head, THREE)).toMatchObject({
      requiredSet: 'three',
      reason: 'trust-chain-path',
      triggeringPaths: ['ai-sdlc-plugin/hooks/x.js'],
      appliedReviewers: THREE,
    });
    const plain = makeRepo({ 'orchestrator/src/foo.ts': 'x' });
    expect(deriveEnvelopeReviewScope(plain.dir, plain.head, TWO)).toMatchObject({
      requiredSet: 'two',
      triggeringPaths: [],
    });
  });

  it('reads the require-three config from the base ref', () => {
    const repo = makeRepo({ 'orchestrator/src/foo.ts': 'x' }, 'reviewerSet: three\n');
    expect(deriveEnvelopeReviewScope(repo.dir, repo.head, THREE)).toMatchObject({
      requiredSet: 'three',
      reason: 'config:require-three',
    });
  });

  it('the envelope the signer writes carries the record', () => {
    const repo = makeRepo({ 'orchestrator/src/foo.ts': 'x' });
    const kp = generateKeyPairSync('ed25519');
    const pem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const patchId = 'd'.repeat(40);
    appendLeafForPatchId(
      {
        leafIndex: 0,
        taskId: 'AISDLC-722',
        reviewerName: 'security-reviewer',
        transcriptHash: 'a'.repeat(64),
        nonce: 'b'.repeat(64),
        harness: 'claude-code',
        model: 'opus',
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        signedAt: '2026-10-10T10:00:00.000Z',
      },
      patchId,
      repo.dir,
    );
    const out = signAndWriteV6Envelope({
      repoRoot: repo.dir,
      headSha: repo.head,
      taskId: 'AISDLC-722',
      privateKeyPem: pem,
      patchId,
    });
    expect(JSON.parse(readFileSync(out, 'utf8')).reviewScope).toMatchObject({
      requiredSet: 'two',
      reason: expect.any(String),
      triggeringPaths: [],
    });
  });
});

describe('signer-side reduction respects the require-three opt-out', () => {
  it('reduceForReviewScope never narrows a test-only diff when the repo requires three', () => {
    const three = ['code-reviewer', 'test-reviewer', 'security-reviewer'] as const;
    const kept = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['src/a.test.ts'],
      requireThree: true,
      readBaseConfig: () => null,
    });
    expect(kept.reviewers).toEqual([...three]);
    expect(kept.reason).toBe('config:require-three');
    const narrowed = reduceForReviewScope({
      reviewers: three,
      changedFiles: ['src/a.test.ts'],
      readBaseConfig: () => null,
    });
    expect(narrowed.reviewers).toEqual(['correctness-reviewer']);
  });
});
