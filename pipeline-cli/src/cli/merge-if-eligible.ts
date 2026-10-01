/**
 * `cli-merge-if-eligible` — yargs router for the deterministic
 * `merge-if-eligible <pr>` governance helper (RFC-0048 Phase 3 / AISDLC-603).
 *
 * Mirrors the `cli-pr-unstick` shape: a pure-function core
 * (`../governance/merge-if-eligible.ts`) plus a thin CLI router plus a bin
 * shim. All `gh` calls go through an injectable `Runner`.
 *
 * @module cli/merge-if-eligible
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  refusalResult,
  resolveRepoSlug,
  resolveTrustedMainRoot,
  runMergeIfEligible,
  type RunMergeIfEligibleResult,
  type SourceKind,
} from '../governance/merge-if-eligible.js';

/**
 * This package's root directory, used to locate the sibling
 * `ai-sdlc-plugin/hooks/lib/governance-resolver.js` module. Computed
 * relative to THIS file so it resolves identically whether running from
 * `src/cli/` (ts-node / vitest) or the compiled `dist/cli/` (bin shim).
 */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

export function renderResult(result: RunMergeIfEligibleResult): string {
  const lines: string[] = [];
  const prefix = `PR #${result.prNumber}`;
  if (result.dryRun) {
    lines.push(
      `${prefix} | DRY-RUN | eligible=${result.eligibility.eligible} | ${result.eligibility.reason}`,
    );
  } else if (result.merged) {
    lines.push(`${prefix} | MERGED | ${result.eligibility.reason}`);
  } else {
    lines.push(`${prefix} | REFUSED | ${result.eligibility.reason}`);
  }
  return lines.join('\n') + '\n';
}

export function renderJsonResult(result: RunMergeIfEligibleResult): string {
  return (
    JSON.stringify(
      {
        ok: result.eligibility.eligible,
        prNumber: result.prNumber,
        merged: result.merged,
        dryRun: result.dryRun,
        policy: result.policy,
        reason: result.eligibility.reason,
      },
      null,
      2,
    ) + '\n'
  );
}

export interface BuildCliOptions {
  /** Inject a Runner — tests pass a fake; the bin shim defaults to live exec. */
  runner?: Runner;
  /**
   * PROGRAMMATIC test seam: supplies the trusted root and the committed policy
   * text directly. It is NOT reachable from argv or the environment — only code
   * that imports this builder can set it (the bin shim never does).
   */
  trustedRootOverride?: { root: string; policyYaml: string | null };
}

export function buildMergeIfEligibleCli(opts: BuildCliOptions = {}): Argv {
  const runner = opts.runner ?? defaultRunner;

  return yargs(hideBin(process.argv))
    .scriptName('merge-if-eligible')
    .usage(
      'Usage: $0 <pr> --source-kind <backlog|gh-issue> [options]\n\n' +
        '  merge-if-eligible 176 --source-kind backlog          # merge iff green+CLEAN+trusted\n' +
        '  merge-if-eligible 176 --source-kind backlog --dry-run  # evaluate only, never merge\n' +
        '  merge-if-eligible 176 --source-kind gh-issue         # always refused (untrusted)',
    )
    .command(
      '$0 <pr>',
      'Merge a PR iff the repo governance policy allows it AND it is green + CLEAN + trusted',
      (y) =>
        y
          .positional('pr', {
            type: 'number',
            demandOption: true,
            describe: 'PR number to evaluate.',
          })
          .option('source-kind', {
            type: 'string',
            choices: ['backlog', 'gh-issue'] as const,
            demandOption: true,
            describe:
              'Work-item provenance for the OQ-2 trust boundary. Only "backlog" (internal, ' +
              'dispatched by our own orchestrator) is trusted for agent-initiated merge.',
          })
          .option('cwd', {
            type: 'string',
            describe: 'Working directory for gh calls (default: process.cwd()).',
          })
          .option('merge-method', {
            type: 'string',
            choices: ['squash', 'merge', 'rebase'] as const,
            default: 'squash' as const,
            describe: "The repo's configured merge method, used only when eligible.",
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Evaluate eligibility and print the outcome, but never call `gh pr merge`.',
          })
          .option('format', {
            type: 'string',
            choices: ['text', 'json'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const cwd = (argv.cwd as string | undefined) ?? process.cwd();
        const prNumber = argv.pr as number;
        const sourceKind = argv['source-kind'] as SourceKind;
        const mergeMethod = argv['merge-method'] as 'squash' | 'merge' | 'rebase';
        const dryRun = Boolean(argv['dry-run']);
        const format = String(argv.format) as 'text' | 'json';

        // The policy root is the VERIFIED main checkout only. There is no flag
        // or environment variable that supplies one; the override below is a
        // programmatic option of this builder.
        const override = opts.trustedRootOverride;
        const trusted = override
          ? { root: override.root, reason: '' }
          : resolveTrustedMainRoot({ cwd, anchorDir: packageRoot() });

        // The repository slug comes only from `gh repo view` in the verified checkout.
        const repoSlug = trusted.root === null ? null : await resolveRepoSlug(runner, trusted.root);

        const result =
          trusted.root !== null && repoSlug === null
            ? refusalResult(
                prNumber,
                'could not determine the repository (owner/name) with `gh repo view` in the verified ' +
                  'main checkout — refusing (fail-closed)',
                dryRun,
              )
            : await runMergeIfEligible({
                prNumber,
                sourceKind,
                repoSlug: repoSlug ?? '',
                repoRoot: trusted.root,
                rootRefusal: trusted.reason,
                runner,
                cwd,
                mergeMethod,
                dryRun,
                policyYaml: override?.policyYaml,
              });

        if (format === 'json') {
          process.stdout.write(renderJsonResult(result));
        } else {
          process.stdout.write(renderResult(result));
        }

        if (!result.eligibility.eligible) {
          process.exit(1);
        }
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Bin shim entry point. The mjs shim imports + invokes this.
 */
export async function runMergeIfEligibleCli(): Promise<void> {
  await buildMergeIfEligibleCli().parseAsync();
}
