import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Direct usage reporters write to the machine-level ledger by default.
    // Point them at a throwaway directory so tests never touch the real home.
    env: { AI_SDLC_USAGE_DIR: mkdtempSync(join(tmpdir(), 'orchestrator-usage-')) },
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
