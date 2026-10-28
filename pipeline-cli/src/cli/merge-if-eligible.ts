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

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  defaultBacklogAuditWriter,
  refusalResult,
  resolveTargetRepo,
  runMergeIfEligible,
  type RunMergeIfEligibleResult,
  type SourceKind,
} from '../governance/merge-if-eligible.js';
import { isRebaseOnlyPush, type RebaseOnlyResult } from '../governance/rebase-rearm.js';
import { NEXT_STEP_PREFIX, runReleaseMerge } from '../governance/release-merge.js';

/**
 * Returns a refusal reason when the PR head is not provably a rebase-only
 * successor of `previousHead`, or null when re-arming may proceed to the normal
 * eligibility checks (AISDLC-872).
 */
async function checkRebaseOnly(args: {
  previousHead: string;
  prNumber: number;
  runner: Runner;
  cwd: string;
  check: (a: { previousHead: string; newHead: string; repoRoot: string }) => RebaseOnlyResult;
}): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/i.test(args.previousHead)) {
    return '--rearm-previous-head must be a 40-char commit SHA; not re-arming';
  }
  const out = await args.runner(
    'gh',
    ['pr', 'view', String(args.prNumber), '--json', 'headRefOid', '--jq', '.headRefOid'],
    { cwd: args.cwd, allowFailure: true },
  );
  const newHead = out.stdout.trim();
  if (out.code !== 0 || !/^[0-9a-f]{40}$/i.test(newHead)) {
    return 'could not read the PR head commit; not re-arming';
  }
  const r = args.check({ previousHead: args.previousHead, newHead, repoRoot: args.cwd });
  return r.rebaseOnly ? null : `not a rebase-only push: ${r.reason}`;
}

export function renderResult(result: RunMergeIfEligibleResult): string {
  const lines: string[] = [];
  const prefix = `PR #${result.prNumber}`;
  if (result.dryRun) {
    lines.push(
      `${prefix} | DRY-RUN | eligible=${result.eligibility.eligible} | ${result.eligibility.reason} | policy source: target repo origin/main via GitHub API`,
    );
  } else if (result.outcome === 'landed') {
    lines.push(`${prefix} | LANDED | ${result.eligibility.reason}`);
  } else if (result.outcome === 'not-armable') {
    lines.push(`${prefix} | NOT-ARMABLE | ${result.eligibility.reason}`);
  } else if (result.merged) {
    lines.push(`${prefix} | MERGED | ${result.eligibility.reason}`);
  } else if (result.armed) {
    lines.push(`${prefix} | ARMED | ${result.eligibility.reason}`);
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
        armed: Boolean(result.armed),
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.allowAutoMerge !== undefined ? { allowAutoMerge: result.allowAutoMerge } : {}),
        ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
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
  /** Test seam for the rebase-only predicate (AISDLC-872). */
  rebaseOnlyCheck?: (args: {
    previousHead: string;
    newHead: string;
    repoRoot: string;
  }) => RebaseOnlyResult;
}

export function buildMergeIfEligibleCli(opts: BuildCliOptions = {}): Argv {
  const runner = opts.runner ?? defaultRunner;

  return yargs(hideBin(process.argv))
    .scriptName('merge-if-eligible')
    .usage(
      'Usage: $0 <pr> --source-kind <backlog|gh-issue|release|decisions-sync|docs|deps> [options]\n\n' +
        '  merge-if-eligible 176 --source-kind backlog          # merge iff green+CLEAN+trusted\n' +
        '                                                       # (governance-path changes are audited, not refused: DEC-0072)\n' +
        '  merge-if-eligible 176 --source-kind backlog --dry-run  # evaluate only, never merge\n' +
        '  merge-if-eligible 176 --source-kind backlog --arm    # arm auto-merge iff trusted (same policy gate)\n' +
        '  merge-if-eligible 176 --source-kind gh-issue         # always refused (untrusted)\n' +
        '  merge-if-eligible 1105 --source-kind release --arm   # arm the release-please PR (verified from GitHub)',
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
            choices: ['backlog', 'gh-issue', 'release', 'decisions-sync', 'docs', 'deps'] as const,
            demandOption: true,
            describe:
              'Work-item provenance for the OQ-2 trust boundary. Only "backlog" (internal, ' +
              'dispatched by our own orchestrator) "decisions-sync" (the ai-sdlc/decisions-sync PR, confined to .ai-sdlc/_decisions/events/**) and "release" (the release-please PR, verified from ' +
              'GitHub, caller role restricted by governance) are mergeable by an agent; "docs" is an ai-sdlc/file-* filing PR confined to the docs-only path list; "deps" is a dependabot/* PR opened and committed by dependabot.',
          })
          .option('cwd', {
            type: 'string',
            describe: 'Working directory for gh calls (default: process.cwd()).',
          })
          .option('repo', {
            type: 'string',
            describe:
              'owner/name of the PR repository. Needed only outside a checkout; a cwd whose ' +
              'origin is a different repository is refused.',
          })
          .option('merge-method', {
            type: 'string',
            choices: ['squash', 'merge', 'rebase'] as const,
            default: 'squash' as const,
            describe: "The repo's configured merge method, used only when eligible.",
          })
          .option('arm', {
            type: 'boolean',
            default: false,
            describe:
              'Arm auto-merge instead of merging now. Needs the same allowMerge grant and the same ' +
              'fork/author/base/task/head checks; GitHub then merges once its own required checks pass.',
          })
          .option('rearm-previous-head', {
            type: 'string',
            describe:
              'Re-arm after a rebase (AISDLC-872): the head SHA before the force-push. Implies --arm, ' +
              'and arms only when the patch-id of the PR head equals that of this SHA; a content ' +
              'change is refused. All eligibility checks still apply.',
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
        const previousHead = argv['rearm-previous-head'] as string | undefined;
        const mode = argv.arm || previousHead ? ('arm' as const) : ('merge' as const);
        const format = String(argv.format) as 'text' | 'json';

        // The policy is read from the target repo's main via the GitHub API;
        // no on-disk checkout is consulted. The override is a programmatic seam.
        const override = opts.trustedRootOverride;
        const target = await resolveTargetRepo({
          runner,
          cwd: override?.root ?? cwd,
          repo: argv.repo as string | undefined,
        });
        const repoSlug = target.slug;
        const trusted = {
          root: repoSlug === null ? null : (override?.root ?? cwd),
          reason: target.reason,
        };

        let rebaseRefusal: string | null = null;
        if (previousHead !== undefined) {
          rebaseRefusal = await checkRebaseOnly({
            previousHead,
            prNumber,
            runner,
            cwd,
            check: opts.rebaseOnlyCheck ?? ((a) => isRebaseOnlyPush(a)),
          });
        }

        const result =
          rebaseRefusal !== null
            ? refusalResult(prNumber, rebaseRefusal, dryRun)
            : sourceKind === 'release' && trusted.root !== null && repoSlug !== null
              ? await runReleaseMerge({
                  prNumber,
                  repoSlug,
                  runner,
                  cwd,
                  mergeMethod,
                  dryRun,
                  mode,
                  policyYaml: override?.policyYaml,
                })
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
                  mode,
                  policyYaml: override?.policyYaml,
                  auditWriter: defaultBacklogAuditWriter(),
                });

        if (sourceKind === 'release' && !result.eligibility.eligible) {
          const reason = result.eligibility.reason;
          if (!reason.includes(NEXT_STEP_PREFIX)) {
            result.eligibility = {
              ...result.eligibility,
              reason:
                `${reason} ${NEXT_STEP_PREFIX} run this with ` +
                'gh authenticated for the repository, or escalate to the dispatch/planner session.',
            };
          }
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
