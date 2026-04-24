import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const feedbackApi = {
    record: vi.fn(() => 42),
    structuralPrecision: vi.fn(() => ({ sampleSize: 10, correct: 6, precision: 0.6 })),
    llmPrecision: vi.fn(() => ({ sampleSize: 10, correct: 8, precision: 0.8 })),
    highFalsePositiveCategories: vi.fn(() => [] as unknown[]),
  };
  return {
    feedbackApi,
    SAFeedbackStore: vi.fn().mockImplementation(() => feedbackApi),
    stateStoreOpen: vi.fn(() => ({ close: vi.fn() })),
    resolveRepoRoot: vi.fn(),
  };
});

vi.mock('@ai-sdlc/orchestrator', () => ({
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
  StateStore: { open: mocks.stateStoreOpen },
  SAFeedbackStore: mocks.SAFeedbackStore,
  resolveRepoRoot: mocks.resolveRepoRoot,
}));

describe('cli-sa-feedback', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error — spying on process.exit
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'sa-feedback-test-'));
    mocks.feedbackApi.record.mockClear();
    mocks.feedbackApi.structuralPrecision.mockClear();
    mocks.feedbackApi.llmPrecision.mockClear();
    mocks.feedbackApi.highFalsePositiveCategories.mockClear();
    mocks.stateStoreOpen.mockClear();
    mocks.resolveRepoRoot.mockResolvedValue(tempDir);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('cmdRecord', () => {
    it('records feedback with all required flags', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdRecord([
        'node',
        'cli-sa-feedback.ts',
        'record',
        '--did',
        'acme-did',
        '--issue',
        '7',
        '--dimension',
        'SA-1',
        '--signal',
        'accept',
        '--principal',
        'alice',
        '--category',
        'product',
        '--notes',
        'looks good',
      ]);
      expect(mocks.feedbackApi.record).toHaveBeenCalledWith({
        didName: 'acme-did',
        issueNumber: 7,
        dimension: 'SA-1',
        signal: 'accept',
        principal: 'alice',
        category: 'product',
        notes: 'looks good',
      });
      expect(logSpy).toHaveBeenCalledWith('recorded feedback event #42 (SA-1 accept)');
    });

    it('exits 1 when --did is missing', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await expect(
        mod._cmdRecord([
          'node',
          'cli-sa-feedback.ts',
          'record',
          '--issue',
          '7',
          '--dimension',
          'SA-1',
          '--signal',
          'accept',
        ]),
      ).rejects.toThrow('process.exit called');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 1 when --issue is not a number', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await expect(
        mod._cmdRecord([
          'node',
          'cli-sa-feedback.ts',
          'record',
          '--did',
          'x',
          '--issue',
          'notanumber',
          '--dimension',
          'SA-1',
          '--signal',
          'accept',
        ]),
      ).rejects.toThrow('process.exit called');
      expect(errorSpy).toHaveBeenCalledWith('--issue must be a number');
    });

    it('exits 1 when --dimension is invalid', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await expect(
        mod._cmdRecord([
          'node',
          'cli-sa-feedback.ts',
          'record',
          '--did',
          'x',
          '--issue',
          '1',
          '--dimension',
          'SA-99',
          '--signal',
          'accept',
        ]),
      ).rejects.toThrow('process.exit called');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 1 when --signal is invalid', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await expect(
        mod._cmdRecord([
          'node',
          'cli-sa-feedback.ts',
          'record',
          '--did',
          'x',
          '--issue',
          '1',
          '--dimension',
          'SA-1',
          '--signal',
          'bogus',
        ]),
      ).rejects.toThrow('process.exit called');
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('cmdPrecision', () => {
    it('prints precision summary for both layers (no dimension filter)', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdPrecision(['node', 'cli-sa-feedback.ts', 'precision']);

      expect(mocks.feedbackApi.structuralPrecision).toHaveBeenCalledWith({
        dimension: undefined,
        since: undefined,
      });
      expect(mocks.feedbackApi.llmPrecision).toHaveBeenCalledWith({
        dimension: undefined,
        since: undefined,
      });
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Structural precision:');
      expect(output).toContain('LLM precision:');
      expect(output).toContain('60.0%'); // structural 0.6
      expect(output).toContain('80.0%'); // llm 0.8
      expect(output).toContain('sample size: 10');
    });

    it('appends dimension suffix when --dimension is supplied', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdPrecision([
        'node',
        'cli-sa-feedback.ts',
        'precision',
        '--dimension',
        'SA-2',
        '--since',
        '2026-01-01T00:00:00Z',
      ]);

      expect(mocks.feedbackApi.structuralPrecision).toHaveBeenCalledWith({
        dimension: 'SA-2',
        since: '2026-01-01T00:00:00Z',
      });
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Structural precision [SA-2]:');
      expect(output).toContain('LLM precision [SA-2]:');
    });

    it('exits when --dimension is invalid', async () => {
      const mod = await import('./cli-sa-feedback.js');
      await expect(
        mod._cmdPrecision(['node', 'cli-sa-feedback.ts', 'precision', '--dimension', 'SA-bogus']),
      ).rejects.toThrow('process.exit called');
    });
  });

  describe('cmdHotCategories', () => {
    it('prints "No categories" when list is empty', async () => {
      mocks.feedbackApi.highFalsePositiveCategories.mockReturnValueOnce([]);
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdHotCategories(['node', 'cli-sa-feedback.ts', 'hot-categories']);
      expect(logSpy).toHaveBeenCalledWith('No categories meet the minimum sample-size threshold.');
    });

    it('prints a formatted table when categories exist', async () => {
      mocks.feedbackApi.highFalsePositiveCategories.mockReturnValueOnce([
        {
          category: 'design-tokens',
          sampleSize: 12,
          falsePositiveCount: 5,
          falsePositiveRate: 0.4166,
        },
        {
          category: 'product',
          sampleSize: 8,
          falsePositiveCount: 2,
          falsePositiveRate: 0.25,
        },
      ]);
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdHotCategories([
        'node',
        'cli-sa-feedback.ts',
        'hot-categories',
        '--min-samples',
        '5',
        '--since',
        '2026-01-01T00:00:00Z',
      ]);
      expect(mocks.feedbackApi.highFalsePositiveCategories).toHaveBeenCalledWith(
        { since: '2026-01-01T00:00:00Z' },
        5,
      );
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Category');
      expect(output).toContain('design-tokens');
      expect(output).toContain('product');
    });

    it('defaults --min-samples to 3', async () => {
      mocks.feedbackApi.highFalsePositiveCategories.mockReturnValueOnce([]);
      const mod = await import('./cli-sa-feedback.js');
      await mod._cmdHotCategories(['node', 'cli-sa-feedback.ts', 'hot-categories']);
      expect(mocks.feedbackApi.highFalsePositiveCategories).toHaveBeenCalledWith(
        { since: undefined },
        3,
      );
    });
  });

  describe('openFeedbackStore', () => {
    it('creates config dir, opens state store, returns wrapped feedback', async () => {
      const mod = await import('./cli-sa-feedback.js');
      const { feedback, store } = await mod._openFeedbackStore();
      expect(mocks.stateStoreOpen).toHaveBeenCalledTimes(1);
      expect(mocks.SAFeedbackStore).toHaveBeenCalled();
      expect(feedback).toBe(mocks.feedbackApi);
      expect(store).toBeDefined();
    });
  });

  describe('parseSubcommand', () => {
    it('recognises the three subcommands', async () => {
      const mod = await import('./cli-sa-feedback.js');
      expect(mod._parseSubcommand(['node', 'x', 'record'])).toBe('record');
      expect(mod._parseSubcommand(['node', 'x', 'precision'])).toBe('precision');
      expect(mod._parseSubcommand(['node', 'x', 'hot-categories'])).toBe('hot-categories');
    });
    it('returns undefined when no subcommand is given', async () => {
      const mod = await import('./cli-sa-feedback.js');
      expect(mod._parseSubcommand(['node', 'x'])).toBeUndefined();
      expect(mod._parseSubcommand(['node', 'x', 'bogus'])).toBeUndefined();
    });
  });

  describe('main dispatcher', () => {
    it('errors and exits when no subcommand is supplied', async () => {
      process.argv = ['node', 'vitest-runner'];
      const mod = await import('./cli-sa-feedback.js');
      await expect(mod._main()).rejects.toThrow('process.exit called');
      expect(errorSpy).toHaveBeenCalledWith(
        'Usage: sa-feedback {record|precision|hot-categories} [options]',
      );
    });

    it('dispatches to cmdRecord when argv[2]=record', async () => {
      process.argv = [
        'node',
        'vitest-runner',
        'record',
        '--did',
        'd',
        '--issue',
        '1',
        '--dimension',
        'SA-1',
        '--signal',
        'accept',
      ];
      const mod = await import('./cli-sa-feedback.js');
      await mod._main();
      expect(mocks.feedbackApi.record).toHaveBeenCalled();
    });

    it('dispatches to cmdPrecision when argv[2]=precision', async () => {
      process.argv = ['node', 'vitest-runner', 'precision'];
      const mod = await import('./cli-sa-feedback.js');
      await mod._main();
      expect(mocks.feedbackApi.structuralPrecision).toHaveBeenCalled();
      expect(mocks.feedbackApi.llmPrecision).toHaveBeenCalled();
    });

    it('dispatches to cmdHotCategories when argv[2]=hot-categories', async () => {
      process.argv = ['node', 'vitest-runner', 'hot-categories'];
      const mod = await import('./cli-sa-feedback.js');
      await mod._main();
      expect(mocks.feedbackApi.highFalsePositiveCategories).toHaveBeenCalled();
    });
  });
});
