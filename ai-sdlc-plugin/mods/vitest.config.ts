import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.mjs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The host supplies `claude-code` and the JSX runtime when a mod loads; tests alias both to stubs.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      'claude-code': here('./tests/stubs/claude-code.ts'),
      'react/jsx-runtime': here('./tests/stubs/jsx-runtime.ts'),
      'react/jsx-dev-runtime': here('./tests/stubs/jsx-runtime.ts'),
    },
  },
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      allowExternal: true,
      include: [
        'context-meter/hooks/**/*.ts',
        'context-meter/hooks/**/*.tsx',
        '../hooks/hierarchy/**/*.ts',
        '../hooks/hierarchy/**/*.tsx',
      ],
      thresholds: { lines: 90 },
    },
  },
});
