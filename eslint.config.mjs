import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'spec/',
      'research/',
      'docs/',
      'community/',
      'contrib/',
      'sdk-go/',
      'sdk-python/',
      '**/dist/',
      '**/.next/',
      'dashboard/next-env.d.ts',
      '**/scripts/',
      '.github/actions/',
      '**/vitest.config.ts',
      // AISDLC-681: plain-ESM shared vitest preset + worker setup (not in any tsconfig).
      'vitest.shared.mjs',
      'vitest.parent-watch.setup.mjs',
      '.github/workflows/__tests__/',
      '.claude/hooks/',
      'ai-sdlc-plugin/hooks/',
      'ai-sdlc-plugin/agents/',
      'ai-sdlc-plugin/commands/',
      '**/coverage/',
      'pipeline-cli/bin/',
      // AISDLC-575: single-sourced attestation verifier core — plain,
      // dependency-free ESM (not TypeScript, not part of pipeline-cli's
      // tsconfig `include`) so the exact same bytes can be imported by the
      // plugin driver, the repo CI driver, and this package's own CLI
      // without a build step. Mirrors the prior '**/scripts/' ignore that
      // covered this file at its old ai-sdlc-plugin/scripts/ location.
      'pipeline-cli/attestation-core/',
      // Zero-dep fixture for RFC-0043 UCVG live demo (plain JS, not TypeScript)
      'ucvg-demo/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'commitlint.config.mjs',
            'dashboard/next.config.mjs',
          ],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  eslintConfigPrettier,
);
