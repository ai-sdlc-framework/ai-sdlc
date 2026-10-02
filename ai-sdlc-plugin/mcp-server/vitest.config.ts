import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    globals: true,
    exclude: ['node_modules/**', 'dist/**', '**/*.flaky.test.ts'],
  },
});
