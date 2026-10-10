import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.mjs';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
      },
    },
  },
});
