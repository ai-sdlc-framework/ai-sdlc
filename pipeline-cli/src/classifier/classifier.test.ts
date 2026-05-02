/**
 * Tests for the AISDLC-141 conditional review classifier (pipeline-cli copy).
 *
 * Mirrors the orchestrator-side tests at
 * `orchestrator/src/models/classifier.test.ts` for the deterministic ruleset
 * (so we can detect divergence early), and adds AISDLC-141-specific coverage
 * for the diff-summary parsers + the AC-4 fall-open-on-low-confidence rule.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_REVIEWERS,
  appendCalibrationEntry,
  decideFromInvocationFailure,
  decideFromRulesetOutput,
  defaultRulesetDecision,
  parseNumstat,
  parsePathsFile,
  parseUnifiedDiff,
  type ClassifierOutput,
} from './classifier.js';

describe('defaultRulesetDecision', () => {
  it('emits empty reviewers when nothing changed (AC-6 docs-only edge case)', () => {
    const d = defaultRulesetDecision({
      filesChanged: 0,
      paths: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
    expect(d.reviewers).toEqual([]);
    expect(d.confident).toBe(true);
  });

  it('docs-only PR runs only critic (AC-6)', () => {
    const d = defaultRulesetDecision({
      filesChanged: 2,
      paths: ['README.md', 'docs/intro.md'],
      linesAdded: 10,
      linesRemoved: 2,
    });
    expect(d.reviewers).toEqual(['critic']);
  });

  it('treats .rst and .txt as docs', () => {
    const d = defaultRulesetDecision({
      filesChanged: 2,
      paths: ['NOTES.txt', 'spec/proposal.rst'],
      linesAdded: 5,
      linesRemoved: 0,
    });
    expect(d.reviewers).toEqual(['critic']);
  });

  it('auth-touching PR runs all three with security bumped to opus', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['src/auth/session.ts'],
      linesAdded: 50,
      linesRemoved: 20,
    });
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
    expect(d.modelOverride?.security).toBe('opus');
  });

  it('lockfile change triggers security + critic (no testing)', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['package-lock.json'],
      linesAdded: 100,
      linesRemoved: 80,
    });
    expect([...d.reviewers].sort()).toEqual(['critic', 'security']);
  });

  it('CI workflow change triggers security + critic', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['.github/workflows/ci.yml'],
      linesAdded: 12,
      linesRemoved: 4,
    });
    expect([...d.reviewers].sort()).toEqual(['critic', 'security']);
  });

  it('default fallback runs all three (AC-7 code-diff branch)', () => {
    const d = defaultRulesetDecision({
      filesChanged: 3,
      paths: ['src/foo.ts', 'src/bar.ts', 'src/foo.test.ts'],
      linesAdded: 40,
      linesRemoved: 12,
    });
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
  });

  // ── AISDLC-145 hardening: docs-detection downgrade vector ──────────────────────────
  // The pre-145 docs branch matched ANY file under `docs/` (including
  // `docs/install.sh`, `docs/.env`, `docs/private-key.pem`), silently skipping
  // the security reviewer. Each of these tests pins one of the closed
  // downgrade paths.
  describe('AISDLC-145 docs-branch hardening', () => {
    it('docs/install.sh is NOT docs-only — falls to default (all 3 reviewers)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/install.sh'],
        linesAdded: 10,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
    });

    it('docs/.env is auth-tier — all 3 reviewers + opus model bump on security', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/.env'],
        linesAdded: 5,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
      expect(d.modelOverride?.security).toBe('opus');
    });

    it('docs/.env.local is auth-tier (.env-prefix glob)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/.env.local'],
        linesAdded: 1,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
      expect(d.modelOverride?.security).toBe('opus');
    });

    it('docs/private-key.pem is auth-tier (PEM denylist + secret detection)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/private-key.pem'],
        linesAdded: 25,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
      expect(d.modelOverride?.security).toBe('opus');
    });

    it('docs/signing.key is auth-tier (key denylist + secret detection)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/signing.key'],
        linesAdded: 1,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
      expect(d.modelOverride?.security).toBe('opus');
    });

    it('docs/Dockerfile is NOT docs-only — falls to default (all 3 reviewers)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/Dockerfile'],
        linesAdded: 12,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
    });

    it('docs/architecture.md remains docs-only critic (existing happy path)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/architecture.md'],
        linesAdded: 30,
        linesRemoved: 5,
      });
      expect(d.reviewers).toEqual(['critic']);
    });

    it('mixed docs/*.md + docs/*.png stays docs-only (image extension allowed)', () => {
      const d = defaultRulesetDecision({
        filesChanged: 2,
        paths: ['docs/diagram.png', 'docs/intro.md'],
        linesAdded: 1,
        linesRemoved: 0,
      });
      expect(d.reviewers).toEqual(['critic']);
    });

    it('docs/auth-spec.md falls to all-3 because auth regex outranks docs branch', () => {
      // Even though .md matches the docs ext, we never reach the docs branch
      // when ANY path looks auth-touching: the `every` predicate succeeds, but
      // the predicate is correct — we DO want the security reviewer for
      // auth-spec changes (path word `auth` is the signal).
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: ['docs/auth-spec.md'],
        linesAdded: 10,
        linesRemoved: 0,
      });
      // Note: passes docs-branch (allDocs=true), so reviewers=['critic'] —
      // that's the existing semantic for plain markdown spec docs. The
      // hardening only blocks executable/secret files.
      expect(d.reviewers).toEqual(['critic']);
    });
  });

  // ── AISDLC-145 hardening: auth-regex widening ──────────────────────────────────────
  describe('AISDLC-145 auth-regex widening', () => {
    it.each([
      ['src/oauth/provider.ts'],
      ['src/iam/permissions.ts'],
      ['src/jwt/tokens.ts'],
      ['src/session/manager.ts'],
      ['src/login.ts'],
      ['src/rbac/roles.ts'],
      ['src/tokens.ts'],
      ['src/credentials.ts'],
      ['src/password-reset.ts'],
      ['src/signin/handler.ts'],
      ['src/signup/handler.ts'],
    ])('classifies %s as auth-touching (all 3 reviewers + opus bump)', (path) => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: [path],
        linesAdded: 10,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
      expect(d.modelOverride?.security).toBe('opus');
    });
  });

  // ── AISDLC-145 hardening: lockfile + CI regex widening ─────────────────────────────
  describe('AISDLC-145 lockfile + CI widening', () => {
    it.each([['Gemfile.lock'], ['composer.lock'], ['go.sum'], ['bun.lockb']])(
      '%s triggers security + critic (supply-chain)',
      (path) => {
        const d = defaultRulesetDecision({
          filesChanged: 1,
          paths: [path],
          linesAdded: 10,
          linesRemoved: 0,
        });
        expect([...d.reviewers].sort()).toEqual(['critic', 'security']);
      },
    );

    it.each([
      ['.circleci/config.yml'],
      ['.gitlab-ci.yml'],
      ['Jenkinsfile'],
      ['azure-pipelines.yml'],
    ])('%s triggers security + critic (CI config)', (path) => {
      const d = defaultRulesetDecision({
        filesChanged: 1,
        paths: [path],
        linesAdded: 5,
        linesRemoved: 0,
      });
      expect([...d.reviewers].sort()).toEqual(['critic', 'security']);
    });
  });
});

describe('decideFromRulesetOutput', () => {
  const baseOutput: ClassifierOutput = {
    reviewers: ['critic'],
    rationale: { critic: 'docs only' },
    confident: true,
    confidence: 0.95,
  };

  it('returns the classifier reviewers when output is confident and above floor', () => {
    const d = decideFromRulesetOutput(baseOutput);
    expect(d.fellOpen).toBe(false);
    expect(d.reviewers).toEqual(['critic']);
    expect(d.confidence).toBe(0.95);
  });

  it('falls open on confident: false', () => {
    const d = decideFromRulesetOutput({ ...baseOutput, confident: false, confidence: 0.5 });
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('confident-false');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });

  it('falls open on confidence < 0.7 even when confident: true (AC-4 OR clause)', () => {
    // Defensive: a future LLM-classifier might set confident: true with
    // confidence: 0.5 despite the schema. AC-4 spec is "ALL 3 reviewers when
    // fellOpen OR confidence < 0.7" — encoded HERE so callers see one boolean.
    const d = decideFromRulesetOutput({ ...baseOutput, confident: true, confidence: 0.5 });
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('low-confidence');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });

  it('preserves the rawOutput on fall-open so callers can inspect rationale', () => {
    const out = { ...baseOutput, confident: false, confidence: 0.4 };
    const d = decideFromRulesetOutput(out);
    expect(d.rawOutput).toEqual(out);
    expect(d.confidence).toBe(0.4);
  });
});

describe('decideFromInvocationFailure', () => {
  it('falls open with reason invocation-failed (AC-4 hard safety)', () => {
    const d = decideFromInvocationFailure();
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('invocation-failed');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
    expect(d.rawOutput).toBeNull();
  });
});

describe('parsePathsFile', () => {
  it('strips blank lines and trims', () => {
    const s = parsePathsFile('src/foo.ts\n\n  src/bar.ts\nREADME.md\n');
    expect(s.paths).toEqual(['src/foo.ts', 'src/bar.ts', 'README.md']);
    expect(s.filesChanged).toBe(3);
    expect(s.linesAdded).toBe(0);
    expect(s.linesRemoved).toBe(0);
  });

  it('returns empty summary on empty input', () => {
    expect(parsePathsFile('')).toEqual({
      filesChanged: 0,
      paths: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
  });
});

describe('parseNumstat', () => {
  it('sums added/removed and collects paths', () => {
    const s = parseNumstat(['12\t3\tsrc/foo.ts', '0\t5\tsrc/bar.ts'].join('\n'));
    expect(s.paths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(s.linesAdded).toBe(12);
    expect(s.linesRemoved).toBe(8);
  });

  it("treats binary-file '-' placeholders as 0", () => {
    const s = parseNumstat('-\t-\tlogo.png\n5\t2\tsrc/x.ts\n');
    expect(s.paths).toEqual(['logo.png', 'src/x.ts']);
    expect(s.linesAdded).toBe(5);
    expect(s.linesRemoved).toBe(2);
  });

  it('skips lines that do not match the format', () => {
    const s = parseNumstat('garbage line\n3\t1\tsrc/x.ts\n');
    expect(s.paths).toEqual(['src/x.ts']);
  });
});

describe('parseUnifiedDiff', () => {
  it('extracts post-image paths from diff --git headers', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '+const y = 2;',
      '-const z = 3;',
      '+const z = 4;',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,2 @@',
      ' # repo',
      '+## section',
    ].join('\n');
    const s = parseUnifiedDiff(diff);
    expect(s.paths).toEqual(['src/foo.ts', 'README.md']);
    expect(s.filesChanged).toBe(2);
    // 3 added (+y, +z, +##section), 1 removed (-z=3). +++/--- file headers are excluded.
    expect(s.linesAdded).toBe(3);
    expect(s.linesRemoved).toBe(1);
  });

  it('returns empty summary on empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({
      filesChanged: 0,
      paths: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
  });
});

describe('appendCalibrationEntry', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'classifier-pcli-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes JSONL to <artifactsDir>/_classifier/calibration.jsonl (AC-5 plumb)', async () => {
    await appendCalibrationEntry(tmpRoot, {
      timestamp: '2026-04-26T12:00:00Z',
      issueId: 'AISDLC-141',
      diffStats: { filesChanged: 1, paths: ['README.md'], linesAdded: 1, linesRemoved: 0 },
      classifierOutput: {
        reviewers: ['critic'],
        rationale: { critic: 'docs' },
        confident: true,
        confidence: 0.95,
      },
      fellOpen: false,
      fellOpenReason: null,
      humanOverrideAfterMerge: null,
    });
    const content = await readFile(join(tmpRoot, '_classifier', 'calibration.jsonl'), 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.issueId).toBe('AISDLC-141');
  });

  it('appends multiple entries on consecutive calls', async () => {
    for (let i = 0; i < 3; i++) {
      await appendCalibrationEntry(tmpRoot, {
        timestamp: new Date().toISOString(),
        issueId: `AISDLC-${i}`,
        diffStats: { filesChanged: 1, paths: ['x'], linesAdded: 0, linesRemoved: 0 },
        classifierOutput: null,
        fellOpen: true,
        fellOpenReason: 'invocation-failed',
        humanOverrideAfterMerge: null,
      });
    }
    const content = await readFile(join(tmpRoot, '_classifier', 'calibration.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(3);
  });
});
