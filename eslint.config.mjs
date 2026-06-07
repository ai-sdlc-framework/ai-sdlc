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
      '**/vitest.config.ts',
      '.github/workflows/__tests__/',
      '.claude/hooks/',
      'ai-sdlc-plugin/hooks/',
      'ai-sdlc-plugin/agents/',
      'ai-sdlc-plugin/commands/',
      '**/coverage/',
      'pipeline-cli/bin/',
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
