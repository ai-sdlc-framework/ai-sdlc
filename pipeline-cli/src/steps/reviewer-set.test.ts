import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveReviewerSetMode,
  resolveReviewerSet,
  parseReviewerSetModeYaml,
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

  it('defaults to "three" with no env var and no config file (AC-4)', () => {
    const workDir = makeWorkDir();
    expect(resolveReviewerSetMode({ workDir, env: {} })).toBe('three');
  });

  it('honors AI_SDLC_REVIEWER_SET=code-test-merged (A/B override)', () => {
    const workDir = makeWorkDir();
    expect(
      resolveReviewerSetMode({ workDir, env: { AI_SDLC_REVIEWER_SET: 'code-test-merged' } }),
    ).toBe('code-test-merged');
  });

  it('honors AI_SDLC_REVIEWER_SET=three explicitly', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'review-config.yaml'),
      'reviewerSet: code-test-merged\n',
    );
    // Explicit env override wins over the config file.
    expect(resolveReviewerSetMode({ workDir, env: { AI_SDLC_REVIEWER_SET: 'three' } })).toBe(
      'three',
    );
  });

  it('ignores unrecognized AI_SDLC_REVIEWER_SET values and falls back to config/default', () => {
    const workDir = makeWorkDir();
    expect(resolveReviewerSetMode({ workDir, env: { AI_SDLC_REVIEWER_SET: 'bogus' } })).toBe(
      'three',
    );
  });

  it('reads reviewerSet: code-test-merged from .ai-sdlc/review-config.yaml', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'review-config.yaml'),
      'reviewerSet: code-test-merged\n',
    );
    expect(resolveReviewerSetMode({ workDir, env: {} })).toBe('code-test-merged');
  });

  it('falls back to "three" on a malformed config file (never blocks the pipeline)', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'review-config.yaml'),
      'reviewerSet: not-a-real-mode\n',
    );
    expect(resolveReviewerSetMode({ workDir, env: {} })).toBe('three');
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
      const set = resolveReviewerSet({ workDir, env: {} });
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
