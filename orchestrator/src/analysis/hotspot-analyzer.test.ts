import { describe, it, expect } from 'vitest';
import { computeFileComplexity, analyzeHotspots } from './hotspot-analyzer.js';
import type { FileInfo, ImportStatement } from './types.js';

function makeFile(relativePath: string, lineCount: number): FileInfo {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    lineCount,
    extension: '.ts',
  };
}

function makeImport(specifier: string): ImportStatement {
  return { source: 'test.ts', specifier, isExternal: false, line: 1 };
}

describe('hotspot-analyzer', () => {
  describe('computeFileComplexity', () => {
    it('returns low score for trivial files', () => {
      expect(computeFileComplexity(5, 0)).toBeLessThanOrEqual(3);
    });

    it('returns moderate score for medium files', () => {
      const score = computeFileComplexity(100, 10);
      expect(score).toBeGreaterThanOrEqual(3);
      expect(score).toBeLessThanOrEqual(7);
    });

    it('returns high score for large complex files', () => {
      const score = computeFileComplexity(500, 30);
      expect(score).toBeGreaterThanOrEqual(7);
    });

    it('caps at 10', () => {
      const score = computeFileComplexity(10000, 200);
      expect(score).toBeLessThanOrEqual(10);
    });

    it('never goes below 1', () => {
      const score = computeFileComplexity(0, 0);
      expect(score).toBeGreaterThanOrEqual(1);
    });

    it('increases with more imports', () => {
      const low = computeFileComplexity(100, 2);
      const high = computeFileComplexity(100, 50);
      expect(high).toBeGreaterThanOrEqual(low);
    });
  });

  describe('analyzeHotspots', () => {
    // We can't easily test git log without a real repo, so we test with
    // a repo path that won't be a git directory (falls back to empty churn)

    it('identifies high-complexity files as hotspots even without churn', async () => {
      const files = [makeFile('small.ts', 10), makeFile('large.ts', 800)];
      const importsByFile = new Map<string, ImportStatement[]>();
      importsByFile.set('small.ts', [makeImport('./a')]);
      importsByFile.set(
        'large.ts',
        Array.from({ length: 40 }, (_, i) => makeImport(`./dep${i}`)),
      );

      const hotspots = await analyzeHotspots('/nonexistent-repo', files, importsByFile, {
        threshold: 0.3,
      });

      // The large file should appear as a hotspot due to high complexity
      const largeHotspot = hotspots.find((h) => h.filePath === 'large.ts');
      expect(largeHotspot).toBeDefined();
      expect(largeHotspot!.complexity).toBeGreaterThanOrEqual(7);
    });

    it('returns empty when all files are simple', async () => {
      const files = [makeFile('a.ts', 10), makeFile('b.ts', 15)];
      const importsByFile = new Map<string, ImportStatement[]>();
      importsByFile.set('a.ts', []);
      importsByFile.set('b.ts', [makeImport('./a')]);

      const hotspots = await analyzeHotspots('/nonexistent-repo', files, importsByFile, {
        threshold: 0.5,
      });

      expect(hotspots).toHaveLength(0);
    });

    it('sorts hotspots by composite score descending', async () => {
      const files = [makeFile('medium.ts', 200), makeFile('large.ts', 600)];
      const importsByFile = new Map<string, ImportStatement[]>();
      importsByFile.set(
        'medium.ts',
        Array.from({ length: 10 }, (_, i) => makeImport(`./d${i}`)),
      );
      importsByFile.set(
        'large.ts',
        Array.from({ length: 30 }, (_, i) => makeImport(`./d${i}`)),
      );

      const hotspots = await analyzeHotspots('/nonexistent-repo', files, importsByFile, {
        threshold: 0.1,
      });

      if (hotspots.length >= 2) {
        const score0 = hotspots[0].churnRate * 0.5 + (hotspots[0].complexity / 10) * 0.5;
        const score1 = hotspots[1].churnRate * 0.5 + (hotspots[1].complexity / 10) * 0.5;
        expect(score0).toBeGreaterThanOrEqual(score1);
      }
    });

    it('handles empty file list', async () => {
      const hotspots = await analyzeHotspots('/nonexistent-repo', [], new Map());
      expect(hotspots).toEqual([]);
    });
  });
});
