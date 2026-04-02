import { describe, it, expect, afterEach } from 'vitest';
import { loadReviewCalibration } from './review-calibration.js';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('loadReviewCalibration', () => {
  let tempDir: string;

  function setup(files: Record<string, string>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'review-cal-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tempDir, name), content, 'utf-8');
    }
    return tempDir;
  }

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when no config files exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      expect(loadReviewCalibration(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads review-policy.md only', () => {
    const dir = setup({ 'review-policy.md': '# Policy\nGolden rule' });
    const result = loadReviewCalibration(dir);
    expect(result).toContain('Golden rule');
  });

  it('loads review-principles.md only', () => {
    const dir = setup({ 'review-principles.md': '# Principles\nEvidence-first' });
    const result = loadReviewCalibration(dir);
    expect(result).toContain('Evidence-first');
  });

  it('loads review-exemplars.yaml only', () => {
    const dir = setup({ 'review-exemplars.yaml': 'exemplars:\n  - id: test' });
    const result = loadReviewCalibration(dir);
    expect(result).toContain('```yaml');
    expect(result).toContain('id: test');
  });

  it('combines all three files with separators', () => {
    const dir = setup({
      'review-policy.md': '# Policy',
      'review-principles.md': '# Principles',
      'review-exemplars.yaml': 'exemplars: []',
    });
    const result = loadReviewCalibration(dir)!;
    expect(result).toContain('# Policy');
    expect(result).toContain('# Principles');
    expect(result).toContain('exemplars: []');
    // Sections separated by ---
    expect(result.split('---').length).toBe(3);
  });

  it('works with real .ai-sdlc directory', () => {
    // Use the actual repo's .ai-sdlc/ directory
    const repoConfigDir = join(__dirname, '..', '..', '.ai-sdlc');
    const result = loadReviewCalibration(repoConfigDir);
    // Should have all 3 files
    expect(result).toContain('Golden Rule');
    expect(result).toContain('Evidence-First');
    expect(result).toContain('exemplars');
  });
});
