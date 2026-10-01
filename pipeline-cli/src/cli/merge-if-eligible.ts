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
  loadTrustedPolicyModule,
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
          .option('repo', {
            type: 'string',
            describe: 'owner/repo slug (default: derived from cwd via `gh repo view`).',
          })
          .option('repo-root', {
            type: 'string',
            describe:
              'TEST-ONLY. Honoured solely when AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS=1; otherwise ' +
              'ignored. Production always reads .ai-sdlc/agent-role.yaml from the verified main ' +
              'checkout of the repo containing this CLI, never from cwd or a worktree copy.',
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
        const pkgRoot = packageRoot();

        // H3: the policy root is the VERIFIED main checkout only; --repo-root is
        // honoured solely under the explicit test-only env var.
        const trusted = resolveTrustedMainRoot({
          cwd,
          anchorDir: pkgRoot,
          repoRootOverride: argv['repo-root'] as string | undefined,
          trustedModule: loadTrustedPolicyModule(pkgRoot),
        });

        if (argv['repo-root'] !== undefined && !trusted.testOverride) {
          process.stderr.write(
            '[merge-if-eligible] --repo-root is test-only and was ignored; policy is read from the ' +
              'verified main checkout.\n',
          );
        }

        let result: RunMergeIfEligibleResult;
        let repoSlug = (argv.repo as string | undefined) ?? '';
        let slugMismatch: string | null = null;
        if (trusted.root !== null && !trusted.testOverride) {
          // Derive the slug from the verified checkout; a conflicting --repo is refused.
          const derived = await resolveRepoSlug(runner, trusted.root);
          if (repoSlug && repoSlug.toLowerCase() !== derived.toLowerCase()) {
            slugMismatch =
              `--repo "${repoSlug}" does not match the verified checkout's repository ` +
              `"${derived}" — refusing`;
          }
          repoSlug = derived;
        } else if (trusted.root !== null && !repoSlug) {
          repoSlug = await resolveRepoSlug(runner, cwd);
        }

        if (slugMismatch) {
          result = refusalResult(prNumber, slugMismatch, dryRun);
        } else {
          result = await runMergeIfEligible({
            prNumber,
            sourceKind,
            repoSlug,
            repoRoot: trusted.root,
            rootRefusal: trusted.reason,
            pkgRoot,
            runner,
            cwd,
            mergeMethod,
            dryRun,
          });
        }

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
