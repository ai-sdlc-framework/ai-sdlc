import { describe, it, expect } from 'vitest';
import { buildCodebaseContext, formatContextForPrompt } from './context-builder.js';
import type { CodebaseProfile } from './types.js';

function makeProfile(overrides?: Partial<CodebaseProfile>): CodebaseProfile {
  return {
    repoPath: '/repo',
    score: 6.2,
    filesCount: 847,
    modulesCount: 12,
    dependencyCount: 94,
    modules: [],
    moduleGraph: { modules: [], edges: [], externalDependencies: [], cycles: [] },
    architecturalPatterns: [
      {
        name: 'hexagonal',
        confidence: 0.89,
        description: 'Ports and adapters in src/domain/, src/adapters/',
        evidence: ['src/domain/', 'src/adapters/'],
      },
      {
        name: 'event-driven',
        confidence: 0.73,
        description: 'Event bus in src/events/ and src/handlers/',
        evidence: ['src/events/', 'src/handlers/'],
      },
    ],
    hotspots: [
      { filePath: 'src/auth/session-manager.ts', churnRate: 0.14, complexity: 8, commitCount: 28 },
      { filePath: 'src/api/routes.ts', churnRate: 0.11, complexity: 6, commitCount: 22 },
    ],
    conventions: [
      { category: 'naming', pattern: 'kebab-case for file names', confidence: 0.85, examples: [] },
      {
        category: 'testing',
        pattern: 'Co-located test files (*.test.ts)',
        confidence: 0.9,
        examples: [],
      },
      {
        category: 'imports',
        pattern: 'Relative imports, barrel re-exports via index.ts',
        confidence: 0.8,
        examples: [],
      },
    ],
    analyzedAt: '2026-02-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('context-builder', () => {
  describe('buildCodebaseContext', () => {
    it('builds context from a profile', () => {
      const ctx = buildCodebaseContext(makeProfile());

      expect(ctx.score).toBe(6.2);
      expect(ctx.filesCount).toBe(847);
      expect(ctx.modulesCount).toBe(12);
      expect(ctx.dependencyCount).toBe(94);
    });

    it('includes architecture summary', () => {
      const ctx = buildCodebaseContext(makeProfile());
      expect(ctx.architectureSummary).toContain('hexagonal');
      expect(ctx.architectureSummary).toContain('89%');
    });

    it('includes conventions summary', () => {
      const ctx = buildCodebaseContext(makeProfile());
      expect(ctx.conventionsSummary).toContain('naming');
      expect(ctx.conventionsSummary).toContain('kebab-case');
    });

    it('includes hotspots summary', () => {
      const ctx = buildCodebaseContext(makeProfile());
      expect(ctx.hotspotsSummary).toContain('session-manager.ts');
      expect(ctx.hotspotsSummary).toContain('14%');
    });

    it('handles empty patterns', () => {
      const ctx = buildCodebaseContext(makeProfile({ architecturalPatterns: [] }));
      expect(ctx.architectureSummary).toContain('No dominant architectural patterns');
    });

    it('handles empty conventions', () => {
      const ctx = buildCodebaseContext(makeProfile({ conventions: [] }));
      expect(ctx.conventionsSummary).toContain('No conventions');
    });

    it('handles empty hotspots', () => {
      const ctx = buildCodebaseContext(makeProfile({ hotspots: [] }));
      expect(ctx.hotspotsSummary).toContain('No hotspots');
    });

    it('limits hotspots to top 5', () => {
      const manyHotspots = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/file${i}.ts`,
        churnRate: 0.1,
        complexity: 7,
        commitCount: 10,
      }));

      const ctx = buildCodebaseContext(makeProfile({ hotspots: manyHotspots }));
      const lines = ctx.hotspotsSummary.split('\n').filter((l) => l.startsWith('- '));
      expect(lines.length).toBe(5);
    });
  });

  describe('formatContextForPrompt', () => {
    it('produces markdown format', () => {
      const ctx = buildCodebaseContext(makeProfile());
      const output = formatContextForPrompt(ctx);

      expect(output).toContain('## Codebase Context');
      expect(output).toContain('Complexity: 6.2/10');
      expect(output).toContain('847 files');
      expect(output).toContain('12 modules');
      expect(output).toContain('94 dependencies');
      expect(output).toContain('### Architecture');
      expect(output).toContain('### Conventions (follow these)');
      expect(output).toContain('### Hotspots (extra care required)');
    });

    it('includes architecture details', () => {
      const ctx = buildCodebaseContext(makeProfile());
      const output = formatContextForPrompt(ctx);
      expect(output).toContain('hexagonal');
    });

    it('includes convention details', () => {
      const ctx = buildCodebaseContext(makeProfile());
      const output = formatContextForPrompt(ctx);
      expect(output).toContain('kebab-case');
      expect(output).toContain('Co-located test files');
    });

    it('includes hotspot details', () => {
      const ctx = buildCodebaseContext(makeProfile());
      const output = formatContextForPrompt(ctx);
      expect(output).toContain('session-manager.ts');
      expect(output).toContain('complexity: 8/10');
    });
  });
});
