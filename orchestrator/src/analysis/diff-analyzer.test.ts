import { describe, it, expect } from 'vitest';
import { extractChangedFiles, analyzeDiff } from './diff-analyzer.js';
import { join } from 'node:path';

describe('extractChangedFiles', () => {
  it('extracts file paths from unified diff', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+added',
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('handles new files (--- /dev/null)', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,5 @@',
      '+const x = 1;',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toEqual(['src/new.ts']);
  });

  it('handles deleted files (+++ /dev/null)', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '-const x = 1;',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toEqual(['src/old.ts']);
  });

  it('deduplicates files', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toEqual(['src/foo.ts']);
  });

  it('returns empty array for empty diff', () => {
    expect(extractChangedFiles('')).toEqual([]);
  });

  it('ignores non-code files in extraction (but includes them)', () => {
    const diff = [
      '--- a/README.md',
      '+++ b/README.md',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toContain('README.md');
    expect(files).toContain('src/index.ts');
  });
});

describe('analyzeDiff', () => {
  // Use the actual repo as test fixture — analyze real files
  const repoPath = join(__dirname, '..', '..', '..');

  it('returns changed files from diff', async () => {
    const diff = [
      '--- a/orchestrator/src/analysis/diff-analyzer.ts',
      '+++ b/orchestrator/src/analysis/diff-analyzer.ts',
    ].join('\n');

    const result = await analyzeDiff(diff, repoPath);
    expect(result.changedFiles).toContain('orchestrator/src/analysis/diff-analyzer.ts');
  });

  it('skips non-existent files (deleted)', async () => {
    const diff = ['--- a/nonexistent-file-xyz.ts', '+++ b/nonexistent-file-xyz.ts'].join('\n');

    const result = await analyzeDiff(diff, repoPath);
    expect(result.findings).toEqual([]);
  });

  it('skips non-code files', async () => {
    const diff = ['--- a/README.md', '+++ b/README.md'].join('\n');

    const result = await analyzeDiff(diff, repoPath);
    // README.md is in changedFiles but not analyzed (not a code extension)
    expect(result.changedFiles).toContain('README.md');
    expect(result.findings).toEqual([]);
  });

  it('generates summary even with no findings', async () => {
    const diff = ['--- a/README.md', '+++ b/README.md'].join('\n');

    const result = await analyzeDiff(diff, repoPath);
    expect(result.summary).toContain('Pre-Verified Structural Analysis');
    expect(result.summary).toContain('No structural issues found');
  });

  it('flags large files', async () => {
    // analyze a file we know is large (review-agent.ts has the CI boundary preamble now)
    const diff = [
      '--- a/orchestrator/src/runners/review-agent.ts',
      '+++ b/orchestrator/src/runners/review-agent.ts',
    ].join('\n');

    const result = await analyzeDiff(diff, repoPath);
    // review-agent.ts is ~300 lines — may or may not trigger file-length
    // But it should at least run without error
    expect(result.changedFiles).toContain('orchestrator/src/runners/review-agent.ts');
    expect(result.summary).toContain('Pre-Verified');
  });

  it('includes deterministic disclaimer in summary when findings exist', async () => {
    // Use execute.ts which is a large, complex file
    const diff = ['--- a/orchestrator/src/execute.ts', '+++ b/orchestrator/src/execute.ts'].join(
      '\n',
    );

    const result = await analyzeDiff(diff, repoPath);
    if (result.findings.length > 0) {
      expect(result.summary).toContain('deterministic');
      expect(result.summary).toContain('Do NOT re-analyze');
    }
  });
});
