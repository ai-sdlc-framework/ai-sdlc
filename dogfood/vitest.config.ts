import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      exclude: [
        ...coverageConfigDefaults.exclude,
        // CLI entry-point scripts are integration boundaries — they parse argv, call into
        // libraries, and exit. The library code they wrap (in @ai-sdlc/orchestrator) is
        // unit-tested separately; CLI behavior is verified by smoke tests in CI.
        'src/cli-*.ts',
        'scripts/**',
      ],
    },
  },
});
