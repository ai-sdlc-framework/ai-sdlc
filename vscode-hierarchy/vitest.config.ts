import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../vitest.shared.mjs';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      // extension.ts is the thin adapter over the vscode runtime; the logic is in the other modules.
      exclude: ['src/extension.ts', 'src/**/*.test.ts'],
      thresholds: { lines: 90 },
    },
  },
});
