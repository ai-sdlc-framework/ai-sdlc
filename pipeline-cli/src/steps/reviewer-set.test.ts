import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveReviewerSetMode,
  resolveReviewerSet,
  parseReviewerSetModeYaml,
  readReviewConfigFromBaseRef,
  THREE_REVIEWER_SET,
  CODE_TEST_MERGED_REVIEWER_SET,
} from './reviewer-set.js';

describe('resolveReviewerSetMode (AISDLC-617)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeWorkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-617-'));
    dirs.push(dir);
    return dir;
  }

  it('defaults to "three" with no env var and no base-ref config (AC-4)', () => {
    const workDir = makeWorkDir();
    expect(resolveReviewerSetMode({ workDir, env: {}, readBaseConfig: () => null })).toBe('three');
  });

  it('honors AI_SDLC_REVIEWER_SET=code-test-merged (A/B override)', () => {
    const workDir = makeWorkDir();
    expect(
      resolveReviewerSetMode({
        workDir,
        env: { AI_SDLC_REVIEWER_SET: 'code-test-merged' },
        readBaseConfig: () => null,
      }),
    ).toBe('code-test-merged');
  });

  it('honors AI_SDLC_REVIEWER_SET=three explicitly, overriding a merged base-ref config', () => {
    const workDir = makeWorkDir();
    // Explicit env override wins even when the trusted base-ref config says merged.
    expect(
      resolveReviewerSetMode({
        workDir,
        env: { AI_SDLC_REVIEWER_SET: 'three' },
        readBaseConfig: () => 'reviewerSet: code-test-merged\n',
      }),
    ).toBe('three');
  });

  it('ignores unrecognized AI_SDLC_REVIEWER_SET values and falls back to base-ref config/default', () => {
    const workDir = makeWorkDir();
    expect(
      resolveReviewerSetMode({
        workDir,
        env: { AI_SDLC_REVIEWER_SET: 'bogus' },
        readBaseConfig: () => null,
      }),
    ).toBe('three');
  });

  it('reads reviewerSet: code-test-merged from the injected base-ref reader', () => {
    const workDir = makeWorkDir();
    expect(
      resolveReviewerSetMode({
        workDir,
        env: {},
        readBaseConfig: () => 'reviewerSet: code-test-merged\n',
      }),
    ).toBe('code-test-merged');
  });

  it('falls back to "three" on a malformed base-ref config (never blocks the pipeline)', () => {
    const workDir = makeWorkDir();
    expect(
      resolveReviewerSetMode({
        workDir,
        env: {},
        readBaseConfig: () => 'reviewerSet: not-a-real-mode\n',
      }),
    ).toBe('three');
  });

  // AISDLC-617 round-2 security fix — the PR-controlled worktree checkout
  // MUST NOT be trusted. Only origin/main's committed config counts.
  it('SECURITY: a PR-worktree config saying code-test-merged does NOT opt the PR into the merged set when origin/main has no such file', () => {
    const workDir = makeWorkDir();
    // Simulate an untrusted PR author committing `.ai-sdlc/review-config.yaml`
    // with `reviewerSet: code-test-merged` in their OWN branch/worktree.
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'review-config.yaml'),
      'reviewerSet: code-test-merged\n',
    );

    // The trusted resolver must consult origin/main, NOT this working-tree
    // file. Simulate origin/main having no such file (readBaseConfig → null).
    const mode = resolveReviewerSetMode({
      workDir,
      env: {},
      readBaseConfig: () => null,
    });
    expect(mode).toBe('three');

    // Prove the resolver never even looked at the working-tree file: the
    // resolved set is the default three, not the PR-worktree's requested two.
    const set = resolveReviewerSet({ workDir, env: {}, readBaseConfig: () => null });
    expect(set).toEqual([...THREE_REVIEWER_SET]);
  });

  it('SECURITY: env var override still works even when a self-serving PR-worktree config is present', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'review-config.yaml'),
      'reviewerSet: code-test-merged\n',
    );
    // Operator/CI explicitly opts in via env — that's the legitimate A/B path.
    const mode = resolveReviewerSetMode({
      workDir,
      env: { AI_SDLC_REVIEWER_SET: 'code-test-merged' },
      readBaseConfig: () => null,
    });
    expect(mode).toBe('code-test-merged');
  });

  it('resolves to code-test-merged when origin/main HAS the committed config, independent of the worktree', () => {
    const workDir = makeWorkDir();
    // Worktree copy absent entirely — only origin/main has it.
    const mode = resolveReviewerSetMode({
      workDir,
      env: {},
      readBaseConfig: (_workDir, baseRef) => {
        expect(baseRef).toBe('origin/main');
        return 'reviewerSet: code-test-merged\n';
      },
    });
    expect(mode).toBe('code-test-merged');
  });

  it('defaults baseRef to origin/main when not overridden', () => {
    const workDir = makeWorkDir();
    let seenBaseRef: string | undefined;
    resolveReviewerSetMode({
      workDir,
      env: {},
      readBaseConfig: (_workDir, baseRef) => {
        seenBaseRef = baseRef;
        return null;
      },
    });
    expect(seenBaseRef).toBe('origin/main');
  });
});

describe('readReviewConfigFromBaseRef (real git show)', () => {
  it('returns null (never throws) for a nonexistent ref in a non-git directory', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-617-notgit-'));
    try {
      expect(readReviewConfigFromBaseRef(workDir, 'origin/main')).toBeNull();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) for a ref/path that does not exist in THIS repo', () => {
    // This repo (the one running the test) is a real git repo, but the ref
    // below cannot plausibly exist — proves the fail-safe path without
    // needing to fabricate a full git fixture repo.
    expect(
      readReviewConfigFromBaseRef(process.cwd(), 'refs/aisdlc-617-nonexistent-ref-xyz'),
    ).toBeNull();
  });
});

describe('parseReviewerSetModeYaml', () => {
  it('parses an unquoted scalar', () => {
    expect(parseReviewerSetModeYaml('reviewerSet: three\n')).toBe('three');
  });

  it('parses a quoted scalar', () => {
    expect(parseReviewerSetModeYaml("reviewerSet: 'code-test-merged'\n")).toBe('code-test-merged');
  });

  it('returns null when the field is absent', () => {
    expect(parseReviewerSetModeYaml('someOtherField: value\n')).toBeNull();
  });
});

describe('resolveReviewerSet (AISDLC-617 AC-1)', () => {
  it('returns exactly the three default reviewers by default', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-617-'));
    try {
      const set = resolveReviewerSet({ workDir, env: {}, readBaseConfig: () => null });
      expect(set).toEqual([...THREE_REVIEWER_SET]);
      expect(set).toHaveLength(3);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('returns exactly two reviewers (correctness + security) when opted in', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-617-'));
    try {
      const set = resolveReviewerSet({
        workDir,
        env: { AI_SDLC_REVIEWER_SET: 'code-test-merged' },
        readBaseConfig: () => null,
      });
      expect(set).toEqual([...CODE_TEST_MERGED_REVIEWER_SET]);
      expect(set).toHaveLength(2);
      expect(set).toContain('correctness-reviewer');
      expect(set).toContain('security-reviewer');
      // AC-3: security reviewer path unchanged — same name in both sets.
      expect(THREE_REVIEWER_SET).toContain('security-reviewer');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
