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
      // Report files no test imports too, so the patch gate sees a changed file as 0 percent
      // covered instead of "NO coverage data" (AISDLC-1119).
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts', 'src/**/*.test.ts'],
      thresholds: { lines: 90 },
    },
  },
});
