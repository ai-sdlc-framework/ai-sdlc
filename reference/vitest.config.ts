import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '**/*.flaky.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
