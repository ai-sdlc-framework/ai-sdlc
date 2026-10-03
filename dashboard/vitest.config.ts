import { defineConfig } from 'vitest/config';
import path from 'path';
import { sharedTestConfig } from '../vitest.shared.mjs';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
    },
  },
});
