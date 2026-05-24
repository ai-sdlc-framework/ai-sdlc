import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Keep *.flaky.test.ts excluded from the default run — loop.filters.flaky.test.ts
    // documents an unresolved 6s CPU-load flake (AISDLC-368). Re-introducing it would
    // re-create the Coverage hang this PR is fixing. The flaky-tests.yml nightly
    // workflow runs them on a schedule via the `**/*.flaky.test.ts` positional glob.
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
      ],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
