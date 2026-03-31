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
      '.claude/hooks/',
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
