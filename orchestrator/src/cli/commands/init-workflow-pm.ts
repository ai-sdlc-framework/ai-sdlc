/**
 * Spell the setup, install and run steps of a scaffolded workflow for the repository's package
 * manager (AISDLC-1362). The templates are written for pnpm; pnpm output is byte-identical.
 *
 * @module cli/commands/init-workflow-pm
 */

import type { PackageManager } from '@ai-sdlc/pipeline-cli/verification';

export function renderWorkflowForPackageManager(
  contents: string,
  pm: PackageManager,
  yarnBerry: boolean,
): string {
  if (pm === 'pnpm') return contents;
  const run = pm === 'npm' ? 'npm run' : pm === 'yarn' ? 'yarn' : 'bun run';
  const install =
    pm === 'npm'
      ? 'npm ci'
      : pm === 'bun'
        ? 'bun install --frozen-lockfile'
        : yarnBerry
          ? 'yarn install --immutable'
          : 'yarn install --frozen-lockfile';
  let out = contents;
  out =
    pm === 'bun'
      ? out.replace(/uses: pnpm\/action-setup@v4/g, 'uses: oven-sh/setup-bun@v2')
      : out.replace(/^[ ]*- uses: pnpm\/action-setup@v4\n/gm, '');
  out =
    pm === 'bun'
      ? out.replace(/^[ ]*cache: pnpm\n/gm, '')
      : out.replace(/cache: pnpm/g, `cache: ${pm}`);
  out = out.replace(/pnpm install --frozen-lockfile/g, install);
  return out.replace(/pnpm (lint|format:check|build|test:coverage|test)\b/g, `${run} $1`);
}
