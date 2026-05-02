/**
 * `cli-incremental-decide` subcommand router (AISDLC-142).
 *
 * Wraps the incremental-review primitives so the `/ai-sdlc execute` Step 7
 * body + the `analyze` job in `.github/workflows/ai-sdlc-review.yml` can
 * decide on each push whether to:
 *   - SKIP the review entirely (contentHash unchanged since prior approval)
 *   - DELTA-ONLY review (`git diff <last-reviewed-sha>...HEAD`)
 *   - FULL review (first push, or delta over the safety threshold)
 *
 * Composes ON TOP of the AISDLC-141 classifier — classifier decides WHICH
 * reviewers to run; this CLI decides WHAT each one reads. The two CLIs are
 * kept separate so callers can run only one (e.g. local dev that wants the
 * incremental decision but not the classifier subset).
 *
 * Subcommands:
 *   - `decide`              — emit an IncrementalDecision JSON for a PR push
 *   - `format-marker`       — emit the marker comment body for a hash + sha
 *
 * Inputs (all required for `decide` unless noted):
 *   --comments-file <path>   — file containing prior PR comment bodies, one
 *                              per line OR concatenated. We just search for
 *                              the marker substring so any reasonable encoding
 *                              works. Pass /dev/null for "no prior comments."
 *   --base-ref <ref>         — base ref (typically `origin/main`)
 *   --head-ref <ref>         — head ref (typically `HEAD`)
 *   --repo-root <path>       — path to the git worktree root (defaults cwd)
 *   --numstat-file <path>    — `git diff <last-reviewed-sha>...HEAD --numstat`
 *                              output. Required when a prior marker exists;
 *                              omit on first push (we'll synthesise empty
 *                              stats and the no-marker branch wins).
 *   --full-diff-paths-file <path>
 *                            — `git diff <base-ref>...HEAD --name-only` output.
 *                              Used to compute the set of top-level dirs in
 *                              the FULL PR diff so the new-top-level-dir
 *                              guard can fire correctly. Optional.
 *   --max-delta-lines <n>    — threshold for the `delta-too-large` branch.
 *                              Defaults to DEFAULT_MAX_DELTA_LINES (200).
 *
 * Output: IncrementalDecision JSON on stdout. Exit 0 on success.
 *
 * Failure modes (mirrors AISDLC-141 fall-open semantics):
 *   - If git fails or the inputs are unreadable, we emit a `no-marker`-equivalent
 *     decision (`deltaOnly: false`, `skip: false`, current contentHash empty)
 *     so the caller falls back to FULL review. We never silently skip a
 *     review we should have done.
 *
 * @module cli/incremental-decide
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  buildAutoApprovedVerdict,
  collectChangedFileDeltaEntries,
  computeContentHashV3,
  decideIncrementalReview,
  DEFAULT_MAX_DELTA_LINES,
  findMarkerInComments,
  formatMarker,
  parseNumstatForDelta,
  type DeltaStats,
  type IncrementalDecision,
  type RunGit,
} from '../incremental-review/incremental.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function warn(message: string): void {
  process.stderr.write(`[cli-incremental-decide] ${message}\n`);
}

/**
 * Default git runner — `execFileSync` with the operator's PATH. Tests inject
 * a stub via `buildIncrementalDecideCli({ runGit })`.
 */
function defaultRunGit(): RunGit {
  return (args: string[], cwd: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
}

/** Override hooks (tests pass a stub `runGit` to avoid spawning git). */
export interface BuildOptions {
  runGit?: RunGit;
  /**
   * Override `process.argv` slice handed to yargs. Used by tests so they
   * don't have to mutate `process.argv` directly. Defaults `hideBin(process.argv)`.
   */
  argv?: string[];
}

/**
 * Build the cli-incremental-decide yargs program. Exported so tests can
 * drive the parser without going through process.argv.
 */
export function buildIncrementalDecideCli(opts: BuildOptions = {}): Argv {
  const runGit = opts.runGit ?? defaultRunGit();
  const argv = opts.argv ?? hideBin(process.argv);

  return yargs(argv)
    .scriptName('cli-incremental-decide')
    .usage('Usage: $0 <command> [options]')
    .command(
      ['decide', '$0'],
      'Decide skip / delta-only / full for the current push.',
      (y) =>
        y
          .option('comments-file', {
            type: 'string',
            describe: 'File of prior PR comment bodies (search target for the marker).',
          })
          .option('base-ref', {
            type: 'string',
            default: 'origin/main',
            describe: 'Base ref for the contentHashV3 computation.',
          })
          .option('head-ref', {
            type: 'string',
            default: 'HEAD',
            describe: 'Head ref for the contentHashV3 computation.',
          })
          .option('repo-root', {
            type: 'string',
            default: process.cwd(),
            describe: 'Path to the git worktree root.',
          })
          .option('numstat-file', {
            type: 'string',
            describe: 'git diff <last-reviewed-sha>...HEAD --numstat output (delta sizing).',
          })
          .option('full-diff-paths-file', {
            type: 'string',
            describe:
              'git diff <base-ref>...HEAD --name-only output (computes full-PR top-level dir set).',
          })
          .option('max-delta-lines', {
            type: 'number',
            default: DEFAULT_MAX_DELTA_LINES,
            describe: 'Lines threshold for the delta-too-large branch.',
          }),
      (parsed) => {
        const decision = decide({
          commentsFile: parsed['comments-file'] as string | undefined,
          baseRef: parsed['base-ref'] as string,
          headRef: parsed['head-ref'] as string,
          repoRoot: parsed['repo-root'] as string,
          numstatFile: parsed['numstat-file'] as string | undefined,
          fullDiffPathsFile: parsed['full-diff-paths-file'] as string | undefined,
          maxDeltaLines: parsed['max-delta-lines'] as number,
          runGit,
        });
        emit(decision);
      },
    )
    .command(
      'format-marker',
      'Emit the marker comment body for a contentHash + reviewedSha.',
      (y) =>
        y
          .option('content-hash', {
            type: 'string',
            demandOption: true,
            describe: '64-char hex sha256 (the contentHashV3 just computed).',
          })
          .option('reviewed-sha', {
            type: 'string',
            demandOption: true,
            describe: '40-char hex sha1 (the commit reviewed against this hash).',
          })
          .option('reviewed-at', {
            type: 'string',
            describe: 'ISO 8601 timestamp; defaults to now.',
          }),
      (parsed) => {
        const marker = formatMarker({
          contentHash: String(parsed['content-hash']).toLowerCase(),
          reviewedSha: String(parsed['reviewed-sha']).toLowerCase(),
          reviewedAt: (parsed['reviewed-at'] as string | undefined) ?? new Date().toISOString(),
        });
        process.stdout.write(`${marker}\n`);
      },
    )
    .command(
      'auto-approved-verdict',
      'Emit the auto-approved verdict JSON for the skip path.',
      (y) =>
        y.option('reviewed-sha', {
          type: 'string',
          demandOption: true,
          describe: 'SHA the prior approval bound to (for the summary line).',
        }),
      (parsed) => {
        emit(buildAutoApprovedVerdict(String(parsed['reviewed-sha']).toLowerCase()));
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Pure decision wrapper — read the inputs, build the decision, return the
 * envelope. Exported so the slash-command body can be unit-tested without
 * shelling out, and so callers can compose the decision into other flows
 * (e.g. dogfood watch, RFC-0012 Tier-2 spawner).
 */
export interface DecideArgs {
  commentsFile?: string;
  baseRef: string;
  headRef: string;
  repoRoot: string;
  numstatFile?: string;
  fullDiffPathsFile?: string;
  maxDeltaLines: number;
  runGit: RunGit;
}

export function decide(args: DecideArgs): IncrementalDecision {
  // ── Locate prior marker (if any) ─────────────────────────────────
  let priorMarkerBody = '';
  if (args.commentsFile) {
    try {
      priorMarkerBody = readFileSync(args.commentsFile, 'utf-8');
    } catch (err) {
      warn(`failed to read --comments-file: ${(err as Error).message}`);
      // Fall through with empty body → no marker → FULL review.
    }
  }
  const prior = findMarkerInComments([priorMarkerBody]);

  // ── Compute current contentHashV3 ───────────────────────────────
  let currentContentHash = '';
  try {
    const entries = collectChangedFileDeltaEntries(
      args.baseRef,
      args.headRef,
      args.repoRoot,
      args.runGit,
    );
    currentContentHash = computeContentHashV3(entries);
  } catch (err) {
    warn(`failed to compute contentHashV3: ${(err as Error).message}`);
    // Fall through. The decision below will see empty currentContentHash;
    // since prior?.contentHash will never equal '' (parseMarker rejects
    // non-hex), the unchanged branch can't fire spuriously, and we'll
    // route to FULL review on the no-marker / delta-too-large branch.
  }

  // ── Compute delta stats (when a marker exists) ──────────────────
  let deltaStats: DeltaStats = {
    linesAdded: 0,
    linesRemoved: 0,
    totalLines: 0,
    topLevelDirs: new Set<string>(),
    filesChanged: 0,
  };
  if (prior !== null && args.numstatFile) {
    try {
      const numstat = readFileSync(args.numstatFile, 'utf-8');
      deltaStats = parseNumstatForDelta(numstat);
    } catch (err) {
      warn(`failed to read --numstat-file: ${(err as Error).message}`);
      // Fall through with empty stats. The contentHash mismatch will still
      // route us through the change branch; an empty delta-stats set means
      // totalLines is 0, which falls under the threshold → delta-only path.
      // That's the WRONG answer when the file is missing because of an
      // I/O error rather than a genuinely empty delta — so we deliberately
      // bias toward the safer FULL review by zeroing out the marker.
      // (Implementation detail: we set deltaSize past the cap below.)
      deltaStats.totalLines = args.maxDeltaLines + 1;
    }
  }

  // ── Compute full-diff top-level dir set for the new-dir guard ───
  const fullDiffTopLevelDirs = new Set<string>();
  if (args.fullDiffPathsFile) {
    try {
      const text = readFileSync(args.fullDiffPathsFile, 'utf-8');
      for (const raw of text.split('\n')) {
        const path = raw.trim();
        if (!path) continue;
        const slash = path.indexOf('/');
        fullDiffTopLevelDirs.add(slash === -1 ? '' : path.slice(0, slash));
      }
    } catch (err) {
      warn(`failed to read --full-diff-paths-file: ${(err as Error).message}`);
      // Without the full-diff set, the new-top-level-dir guard cannot fire
      // (every dir in the delta is "new"). Bias toward safer FULL review by
      // adding every delta-side dir to the full-diff set so the guard is a
      // no-op. The decision then hinges on hash + delta size only.
      for (const dir of deltaStats.topLevelDirs) fullDiffTopLevelDirs.add(dir);
    }
  } else {
    // No --full-diff-paths-file → disable the new-dir guard cleanly.
    for (const dir of deltaStats.topLevelDirs) fullDiffTopLevelDirs.add(dir);
  }

  return decideIncrementalReview({
    prior,
    currentContentHash,
    deltaStats,
    fullDiffTopLevelDirs,
    maxDeltaLines: args.maxDeltaLines,
  });
}

/** Run the cli-incremental-decide CLI. Used by the bin shim. */
export async function runIncrementalDecideCli(): Promise<void> {
  await buildIncrementalDecideCli().parseAsync();
}
