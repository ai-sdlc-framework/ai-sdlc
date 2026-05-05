/**
 * `ai-sdlc-pipeline execute <task-id>` — umbrella subcommand that composes
 * Steps 0-13 end-to-end (AISDLC-182).
 *
 * # Why this exists
 *
 * Until this subcommand existed there was no way for a non-slash-command
 * caller (e.g. an AI assistant working alongside the operator in the main
 * Claude Code session, a cron job, or a webhook handler) to invoke the full
 * Step 0-13 pipeline in a single call WITHOUT either:
 *
 *   1. Manually composing the per-step subcommands AND remembering to write
 *      the verdict file at the right point so the pre-push hook auto-signs
 *      the DSSE envelope (the failure mode that triggered AISDLC-182 — ~10
 *      PRs shipped to main without reviewer verdicts because the assistant
 *      skipped Steps 7/8/10), OR
 *   2. Switching to the API-key-billed `pnpm --filter @ai-sdlc/dogfood watch`
 *      flow, which uses paid Anthropic API instead of the operator's
 *      subscription.
 *
 * This subcommand is a thin wrapper around the existing `executePipeline()`
 * library function (RFC-0012 §7.1) — it does NOT re-implement Step 0-13
 * logic. The wrapper's responsibilities are:
 *
 *   1. Resolve a `SubagentSpawner` from the `--spawner` flag.
 *   2. Call `executePipeline()` with that spawner + the operator's options.
 *   3. Hook into `onProgress` (per-iteration aggregated verdict callback)
 *      to write `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` after
 *      every Step 8 aggregate so the husky pre-push hook
 *      (`scripts/check-attestation-sign.sh`) can auto-sign the DSSE envelope
 *      at Step 11 push time.
 *   4. Emit `[ai-sdlc-progress] execute: <stage>` lines so the dispatching
 *      session can surface progress to the operator.
 *
 * # Spawner routing (`--spawner`)
 *
 *   - `mock`       — `MockSpawner` with hard-coded approval fixtures.
 *                    For dry-run plumbing checks + integration tests only.
 *                    Default in v1 because the harder spawners (api-key,
 *                    claude-cli) carry billing / cross-session implications
 *                    that need explicit operator opt-in. `--run --spawner
 *                    mock` refuses before filesystem mutation.
 *   - `api-key`    — `defaultSpawner()`'s SDK path (uses `ANTHROPIC_API_KEY`).
 *                    Burns API credits per dispatch — same billing model as
 *                    `pnpm dogfood watch`. Documented for AI-assistant /
 *                    unattended use until the `claude-cli` spawner ships.
 *   - `claude-cli` — DEFERRED in v1. The cross-session subagent routing
 *                    problem (how does a CLI invoked from a parent Claude
 *                    Code session dispatch subagents back INTO that parent
 *                    session) is unsolved. Selecting `claude-cli` errors
 *                    with a clear path-forward message. Until that ships,
 *                    operators wanting subscription billing should run
 *                    `/ai-sdlc execute <task-id>` (slash command) directly.
 *
 * # Hard rules honored
 *
 * Same set the slash command body honors (RFC-0012 §3.1, AISDLC-182 AC #3):
 *
 *   1. Never `gh pr merge` — Step 11 only opens PRs.
 *   2. Never `git push --force` / `-f` — Step 11 aborts on non-fast-forward.
 *   3. Never close PRs / issues — no such code path exists.
 *   4. Never delete branches — no such code path exists.
 *   5. Never edit `.ai-sdlc/**` or `.github/workflows/**` — pre-tool-use
 *      hook blocks anyway; we only WRITE to `.ai-sdlc/verdicts/` (the
 *      designated verdict drop folder, not config/CI).
 *   6. Never write CI-skip magic tokens to commit messages — the chore
 *      commit body produced by Step 10 is sanitised by the existing
 *      `finalizeTask()` step.
 *
 * @module cli/execute
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { executePipeline } from '../execute-pipeline.js';
import { computeBranchName } from '../steps/02-compute-branch.js';
import { validateTask } from '../steps/01-validate.js';
import { defaultSpawner } from '../runtime/default-spawner.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import { ROLLBACK_OUTCOMES } from '../orchestrator/loop.js';
import { rollbackDispatch, type RollbackResult } from '../orchestrator/rollback.js';
import {
  DEFAULT_LOGGER,
  type AggregatedVerdict,
  type DeveloperReturn,
  type PipelineLogger,
  type PipelineResult,
  type SubagentSpawner,
} from '../types.js';

/** Spawner identifiers accepted by `--spawner`. */
export type SpawnerKind = 'mock' | 'api-key' | 'claude-cli';

export const SPAWNER_KINDS: readonly SpawnerKind[] = ['mock', 'api-key', 'claude-cli'] as const;

/**
 * Error message surfaced when the operator picks `--spawner claude-cli`.
 * Exported so tests can assert the wording (and so the README + future
 * implementer can grep the constant when wiring the real adapter).
 */
export const CLAUDE_CLI_SPAWNER_DEFERRED_MESSAGE =
  'The `claude-cli` spawner is not implemented yet — cross-session subagent ' +
  'routing (how does a CLI invocation dispatch subagents back into the ' +
  'parent Claude Code session) is unsolved. Until it ships, choose one of:\n' +
  "  • Run `/ai-sdlc execute <task-id>` directly from the operator's slash command (subscription billing).\n" +
  '  • Pass `--spawner api-key` to use API-key billing via the @anthropic-ai/claude-code SDK.\n' +
  '  • Pass `--spawner mock` for dry-run / plumbing tests.\n' +
  'Tracked in AISDLC-182 follow-up.';

/**
 * Build a `MockSpawner` whose fixtures unconditionally APPROVE. Used by
 * `--spawner mock` so the dispatch surface is exercisable in dry-run /
 * plumbing / integration contexts without a real LLM. Does NOT actually
 * exercise the developer's work — it returns a
 * hard-coded `DeveloperReturn` whose `commitSha` is `null` to signal
 * "no real work was done; this is a plumbing check".
 *
 * Exported so tests can re-use the same fixture shape.
 */
export function buildApprovingMockSpawner(): MockSpawner {
  const approvedReviewer = (
    type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer',
  ): {
    type: typeof type;
    output: string;
    parsed: { approved: true; findings: []; summary: string };
    status: 'success';
    durationMs: 0;
  } => ({
    type,
    output: '',
    parsed: { approved: true, findings: [], summary: 'mock-spawner: approved' },
    status: 'success',
    durationMs: 0,
  });
  const devReturn: DeveloperReturn = {
    summary: 'mock spawner — no real work performed (plumbing fixture)',
    filesChanged: [],
    commitSha: null,
    verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
    acceptanceCriteriaMet: [],
    notes: 'Returned by buildApprovingMockSpawner — replace with a real spawner for real work.',
  };
  return new MockSpawner({
    developer: {
      type: 'developer',
      output: '',
      parsed: devReturn,
      status: 'success',
      durationMs: 0,
    },
    'code-reviewer': approvedReviewer('code-reviewer'),
    'test-reviewer': approvedReviewer('test-reviewer'),
    'security-reviewer': approvedReviewer('security-reviewer'),
  });
}

/**
 * Resolve a spawner from the `--spawner` flag. Async because `defaultSpawner()`
 * is async (it probes PATH for `claude` and reads env). Throws on
 * `claude-cli` (deferred) so the caller emits a clear error envelope.
 */
export async function resolveSpawner(kind: SpawnerKind): Promise<SubagentSpawner> {
  switch (kind) {
    case 'mock':
      return buildApprovingMockSpawner();
    case 'api-key': {
      // `defaultSpawner()` prefers `claude` CLI on PATH; pass an env-only
      // override so we deterministically construct the API-key SDK spawner
      // even on machines where `claude` happens to be installed (the
      // operator explicitly asked for `--spawner api-key`).
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          '`--spawner api-key` requires ANTHROPIC_API_KEY in the environment ' +
            '(uses @anthropic-ai/claude-code SDK; same billing model as `pnpm dogfood watch`).',
        );
      }
      return defaultSpawner({
        which: async () => false, // skip the `claude` CLI probe so SDK path wins
        env: () => apiKey,
      });
    }
    case 'claude-cli':
      throw new Error(CLAUDE_CLI_SPAWNER_DEFERRED_MESSAGE);
    default: {
      // Exhaustiveness — yargs `choices: SPAWNER_KINDS` already gates this,
      // but TypeScript doesn't know about yargs's runtime narrowing.
      const _exhaustive: never = kind;
      throw new Error(`unknown spawner kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Shape written to `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` so the
 * husky pre-push hook (`scripts/check-attestation-sign.sh`) can auto-sign
 * the DSSE envelope. Same shape the slash command body writes
 * (`ai-sdlc-plugin/commands/execute.md` Step 10).
 *
 * Exported for tests.
 */
export interface VerdictFilePayload {
  taskId: string;
  decision: AggregatedVerdict['decision'];
  approved: boolean;
  iteration: number;
  counts: AggregatedVerdict['counts'];
  harnessNote: string;
  summary: string;
  verdicts: AggregatedVerdict['verdicts'];
}

/**
 * Write the per-iteration verdict file to
 * `<worktreePath>/.ai-sdlc/verdicts/<taskIdLower>.json`. Idempotent — if the
 * loop runs more than once, the file is overwritten with the latest
 * iteration's aggregate (the pre-push hook reads whatever is on disk at
 * push time, which is the FINAL iteration's verdict by construction).
 *
 * Exported for tests.
 */
export function writeVerdictFile(args: {
  taskId: string;
  worktreePath: string;
  iteration: number;
  verdict: AggregatedVerdict;
}): string {
  const taskIdLower = args.taskId.toLowerCase();
  const dir = join(args.worktreePath, '.ai-sdlc', 'verdicts');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${taskIdLower}.json`);
  const payload: VerdictFilePayload = {
    taskId: args.taskId,
    decision: args.verdict.decision,
    approved: args.verdict.approved,
    iteration: args.iteration,
    counts: args.verdict.counts,
    harnessNote: args.verdict.harnessNote,
    summary: args.verdict.summary,
    verdicts: args.verdict.verdicts,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return filePath;
}

/** Options accepted by `runExecuteCommand` (the testable inner). */
export interface ExecuteCommandOptions {
  taskId: string;
  workDir: string;
  spawnerKind: SpawnerKind;
  maxIterations: number;
  dryRun: boolean;
  /** Explicit operator intent to allow filesystem/network mutation. */
  run?: boolean;
  /** Override spawner factory — tests inject a stub. */
  spawnerFactory?: (kind: SpawnerKind) => Promise<SubagentSpawner>;
  /** Override the executePipeline invocation — tests inject a stub. */
  executor?: typeof executePipeline;
  /** Override the verdict-file writer — tests inject a stub. */
  verdictWriter?: typeof writeVerdictFile;
  /**
   * Override the AISDLC-177 rollback entry point — tests inject a stub so
   * the developer-failed → rollback path is exercisable without touching a
   * real git tree.
   */
  rollback?: typeof rollbackDispatch;
  /** Override the logger — tests inject a stub. */
  logger?: PipelineLogger;
}

export interface ExecuteCommandResult {
  ok: boolean;
  /** When `dryRun=true`, the planned pipeline shape WITHOUT executing it. */
  planned?: {
    taskId: string;
    spawnerKind: SpawnerKind;
    branch: string;
    worktreePath: string;
    maxIterations: number;
  };
  /** When the pipeline ran, the `executePipeline()` result. */
  pipeline?: PipelineResult;
  /** When ok=false, the human-readable failure reason. */
  reason?: string;
  /** Path to the verdict file we wrote (when reviewers ran). */
  verdictFilePath?: string;
  /**
   * AISDLC-177 rollback outcome. Populated whenever the wrapper invoked
   * `rollbackDispatch()` — i.e. on any outcome in `ROLLBACK_OUTCOMES`
   * (AISDLC-191): `developer-failed`, `developer-json-contract-violated`,
   * `aborted`. Operators read this to see whether the side-effects from
   * Step 3 (worktree) and Step 4 (status flip + sentinel) were successfully
   * reversed, and whether any commits were preserved under a
   * `quarantine/<task>-<ts>` ref.
   */
  rollback?: RollbackResult;
}

/**
 * Run the umbrella `execute` subcommand. Exported so tests can drive it
 * without going through the yargs `process.argv` round-trip.
 *
 * Safe default: unless `run=true`, this only validates and computes the
 * branch/worktree plan. It must not resolve a spawner, call `executePipeline`,
 * create a worktree, flip task status, or push commits. `run=true` +
 * `--spawner api-key` is the real-money path that the operator opts into
 * explicitly. `run=true` + `--spawner mock` refuses before validation or any
 * filesystem mutation because mock is only a plumbing fixture.
 */
export async function runExecuteCommand(
  opts: ExecuteCommandOptions,
): Promise<ExecuteCommandResult> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  const factory = opts.spawnerFactory ?? resolveSpawner;
  const exec = opts.executor ?? executePipeline;
  const writer = opts.verdictWriter ?? writeVerdictFile;
  const rollback = opts.rollback ?? rollbackDispatch;

  logger.progress('execute', `task=${opts.taskId} spawner=${opts.spawnerKind}`);

  if (!opts.run || opts.dryRun) {
    // Pre-flight only: validate the task + compute the branch/worktree path
    // so the operator sees what WOULD run. Don't touch the worktree.
    const validation = await validateTask({ taskId: opts.taskId, workDir: opts.workDir });
    if (!validation.ok || !validation.task) {
      return { ok: false, reason: validation.reason ?? 'validation failed' };
    }
    const branch = await computeBranchName({
      taskId: opts.taskId,
      task: validation.task,
      workDir: opts.workDir,
    });
    logger.progress('execute', `dry-run plan computed for ${opts.taskId}`);
    return {
      ok: true,
      planned: {
        taskId: opts.taskId,
        spawnerKind: opts.spawnerKind,
        branch: branch.branch,
        worktreePath: branch.worktreePath,
        maxIterations: opts.maxIterations,
      },
    };
  }

  if (opts.spawnerKind === 'mock') {
    return {
      ok: false,
      reason:
        '`--spawner mock` is dry-run/plumbing only. Omit `--run` for a safe plan, or pass `--run --spawner api-key` for a real execution.',
    };
  }

  // Resolve the spawner after the explicit run gate so default/plumbing
  // invocations cannot fail through SDK/env probing and cannot mutate state.
  let spawner: SubagentSpawner;
  try {
    spawner = await factory(opts.spawnerKind);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  // Real run — drive `executePipeline` with the verdict-file hook wired into
  // `onProgress` so the file is written after every Step 8 aggregate (AC #6).
  // The husky pre-push hook reads whatever is on disk at push time —
  // overwriting per iteration is fine because the FINAL iteration's verdict
  // is the one that lands on the chore commit.
  let verdictFilePath: string | undefined;
  let lastIteration = 0;

  // Resolve worktreePath up-front so the verdict writer doesn't have to
  // re-derive it from the executePipeline result mid-iteration.
  // Capture the PRE-DISPATCH status here too — Step 4 (inside executePipeline)
  // will flip it to "In Progress", and the AISDLC-177 rollback path needs the
  // ORIGINAL status to revert TO on developer-failed outcomes. The orchestrator
  // captures the same value for the same reason (see loop.ts maybeRollback).
  const validation = await validateTask({ taskId: opts.taskId, workDir: opts.workDir });
  if (!validation.ok || !validation.task) {
    return { ok: false, reason: validation.reason ?? 'validation failed' };
  }
  const preDispatchStatus = validation.task.status;
  const branch = await computeBranchName({
    taskId: opts.taskId,
    task: validation.task,
    workDir: opts.workDir,
  });

  let result: PipelineResult;
  try {
    result = await exec({
      taskId: opts.taskId,
      workDir: opts.workDir,
      spawner,
      maxReviewIterations: opts.maxIterations,
      logger,
      onProgress: (iteration, verdict) => {
        lastIteration = iteration;
        try {
          verdictFilePath = writer({
            taskId: opts.taskId,
            worktreePath: branch.worktreePath,
            iteration,
            verdict,
          });
          logger.progress(
            'execute',
            `wrote verdict file iteration=${iteration} decision=${verdict.decision}`,
          );
        } catch (err) {
          // Verdict-file write failure is observability infra — don't poison
          // the dispatch on it. Pre-push hook will fall back to its
          // "no verdict file" exit-0 path and the CI-side attestor (AISDLC-87)
          // takes over server-side.
          logger.warn(`[ai-sdlc] verdict file write failed (non-fatal): ${(err as Error).message}`);
        }
      },
    });
  } catch (err) {
    return { ok: false, reason: `executePipeline threw: ${(err as Error).message}` };
  }

  // Belt-and-braces: even if the loop never invoked `onProgress` (e.g. a
  // future refactor), write the FINAL aggregated verdict so the pre-push
  // hook always has something to bind. `executePipeline()` populates
  // `finalVerdict` whenever the loop ran (developer-failed paths return
  // null + we skip).
  if (!verdictFilePath && result.finalVerdict) {
    try {
      verdictFilePath = writer({
        taskId: opts.taskId,
        worktreePath: branch.worktreePath,
        iteration: result.iterations || lastIteration || 1,
        verdict: result.finalVerdict,
      });
    } catch (err) {
      logger.warn(
        `[ai-sdlc] post-run verdict file write failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  logger.progress(
    'execute',
    `outcome=${result.outcome} pr=${result.prUrl ?? 'none'} iterations=${result.iterations}`,
  );

  // ── AISDLC-177 rollback wiring ─────────────────────────────────────
  // On any outcome that left Step 3 (worktree creation) + Step 4 (status
  // flip + sentinel) side-effects on disk WITHOUT successfully opening a
  // PR, those side-effects must be reversed so the operator (or a
  // re-dispatch) finds a clean slate. The full set is sourced from
  // `ROLLBACK_OUTCOMES` in `orchestrator/loop.ts` (AISDLC-191) so the
  // umbrella CLI and the autonomous orchestrator stay in lockstep:
  //   - `developer-failed` — dev subagent returned commitSha:null (AISDLC-177)
  //   - `developer-json-contract-violated` — dev returned prose twice (AISDLC-176)
  //   - `aborted` — Step 11 push or `gh pr create` failed mid-flight
  //   - `unknown-failure` — synthetic; orchestrator-only (executePipeline
  //     never returns this directly, but the membership check is harmless)
  // The orchestrator's loop.ts wires rollback for the autonomous path;
  // the umbrella subcommand wires the same helper for the manual path.
  // (This is the umbrella's CONSISTENCY OVER PARITY value-add over the
  // raw slash command body, which does NOT yet wire rollback.)
  let rollbackResult: RollbackResult | undefined;
  if (ROLLBACK_OUTCOMES.has(result.outcome)) {
    logger.progress('execute', `rollback start outcome=${result.outcome} branch=${result.branch}`);
    try {
      rollbackResult = await rollback({
        workDir: opts.workDir,
        taskId: opts.taskId,
        fromStatus: preDispatchStatus,
        worktreePath: result.worktreePath,
        branch: result.branch,
        logger,
      });
      const partial =
        !rollbackResult.statusReverted ||
        !rollbackResult.worktreeRemoved ||
        rollbackResult.warnings.length > 0;
      logger.progress(
        'execute',
        `rollback ${partial ? 'partial' : 'ok'} status=${rollbackResult.statusReverted} ` +
          `worktree=${rollbackResult.worktreeRemoved} quarantined=${rollbackResult.branchQuarantined}` +
          (rollbackResult.quarantineRef ? ` ref=${rollbackResult.quarantineRef}` : ''),
      );
    } catch (err) {
      // Defensive: rollbackDispatch is best-effort internally and
      // accumulates warnings rather than throwing, but a programming
      // error in a future refactor must not poison our return envelope —
      // the dev-failed outcome is what the operator cares about.
      logger.warn(`[ai-sdlc] rollbackDispatch threw (non-fatal): ${(err as Error).message}`);
    }
  }

  const out: ExecuteCommandResult = { ok: true, pipeline: result };
  if (verdictFilePath) out.verdictFilePath = verdictFilePath;
  if (rollbackResult) out.rollback = rollbackResult;
  return out;
}

/**
 * yargs `CommandModule` registered on the umbrella `ai-sdlc-pipeline` router
 * (see `src/cli/index.ts`). Thin shell — parses argv, calls
 * `runExecuteCommand`, emits JSON on stdout, exits non-zero on failure.
 *
 * The function signature returns the module so callers (the router) can
 * register it on a yargs builder. Kept as a factory so the `workDir`
 * default lazily reads `process.cwd()` at registration time.
 */
export function executeCommand(): CommandModule {
  return {
    command: 'execute <task-id>',
    describe:
      'AISDLC-182 — safe-by-default umbrella subcommand; use --run for real Step 0-13 execution.',
    builder: (yargs: Argv): Argv =>
      yargs
        .positional('task-id', {
          describe: 'Backlog task ID (e.g. AISDLC-182).',
          type: 'string',
          demandOption: true,
        })
        .option('max-iterations', {
          describe: 'Max review iteration loop (default 2; matches /ai-sdlc execute).',
          type: 'number',
          default: 2,
        })
        .option('spawner', {
          describe:
            'SubagentSpawner: mock (default; dry-run plumbing only) | api-key (paid Anthropic API) | claude-cli (deferred — see README).',
          type: 'string',
          choices: SPAWNER_KINDS as unknown as string[],
          default: 'mock' as SpawnerKind,
        })
        .option('run', {
          describe:
            'Explicitly allow filesystem/network mutation. Required for real execution; use with --spawner api-key.',
          type: 'boolean',
          default: false,
        })
        .option('dry-run', {
          describe:
            'Plan + log; skip the actual dispatch. This is also the default when --run is omitted.',
          type: 'boolean',
          default: false,
        }),
    handler: async (argv) => {
      const result = await runExecuteCommand({
        taskId: String(argv['task-id']),
        workDir: String(argv['work-dir']),
        spawnerKind: argv.spawner as SpawnerKind,
        maxIterations: Number(argv['max-iterations']),
        dryRun: Boolean(argv['dry-run']),
        run: Boolean(argv.run),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) {
        process.exit(1);
      }
    },
  };
}
