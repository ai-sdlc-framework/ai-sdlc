import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**', '**/*.flaky.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/index.ts',
        'src/__test-helpers/**',
        // AISDLC-375: 6 quality-* source files whose tests are *.flaky.test.ts.
        // Tests cause a CI-environment-specific Coverage-job hang under vitest's
        // parallel pool. The nightly flaky-tests workflow (AISDLC-371) runs them
        // with --no-file-parallelism. Remove these exclusions once the hang root
        // cause is identified and fixed.
        'src/tui/analytics/quality-classifier.ts',
        'src/tui/analytics/quality-metrics.ts',
        'src/tui/analytics/quality-router.ts',
        'src/tui/analytics/quality-reader.ts',
        'src/tui/analytics/determinism-detector.ts',
        'src/cli/quality-corpus.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
