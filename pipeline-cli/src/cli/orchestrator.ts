/**
 * `cli-orchestrator` — operator-facing entry point for the autonomous
 * pipeline orchestrator (RFC-0015 Phase 1).
 *
 * Subcommands:
 *   - `start`   — runs the polling loop (foreground; operator supervises via
 *                 terminal, systemd, Docker restart-policy, etc.). Honors
 *                 SIGINT/SIGTERM for clean drain.
 *   - `tick`    — runs a single tick + exits. Useful for cron-driven
 *                 invocations or "kick the loop one step" testing.
 *                 `--continue-from-result <path>` reads a pre-completed
 *                 dispatch-result.json (AISDLC-225 consumer bridge).
 *   - `write-dispatch-result` — write a dispatch-result.json to disk.
 *                 Called by the /ai-sdlc orchestrator-tick slash command body
 *                 after the Agent tool call completes (AISDLC-225).
 *   - `status`  — read-only snapshot: feature-flag state + frontier head +
 *                 queue depth + configured concurrency + tick interval.
 *
 * The yargs router is built in `buildOrchestratorCli()` so tests can drive
 * the parser without going through process.argv.
 *
 * Output is JSON on stdout. Errors emit JSON on stderr + non-zero exit.
 *
 * @module cli/orchestrator
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TICK_INTERVAL_SEC,
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  ORCHESTRATOR_SPAWNER_ENV,
  orchestratorDisabledMessage,
  OrchestratorDisabledError,
  resolveTaskFromFile,
  resolveUmbrellaSpawnerKind,
  runOrchestratorLoop,
  runOrchestratorTick,
  TaskFromFileResolutionError,
  type OrchestratorAdapters,
  type OrchestratorConfig,
} from '../orchestrator/index.js';
import {
  resolveResultPath,
  writeDispatchResult,
  type DispatchResult,
} from '../runtime/spawners/dispatch-result.js';
import { checkAndRebuildIfStale, type DistStalenessOptions } from './dist-staleness.js';
import { SPAWNER_KINDS, type SpawnerKind } from './execute.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

/**
 * AISDLC-352 — emit a billing-safety warning to stderr when there is a
 * risk that subscription-billed dispatch could silently fall through to
 * paid API tokens.
 *
 * Two conditions trigger the warning:
 *
 * 1. `--spawner claude` is requested AND `ANTHROPIC_API_KEY` is set in the
 *    environment. The `claude` spawner uses the operator's logged-in
 *    subscription auth — it does NOT consume the API key directly. But if
 *    the dispatch falls back to `--spawner api-key` for any reason (e.g.
 *    `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is also set), the key
 *    WILL be billed. Surfacing this proactively lets operators unset the key
 *    to force subscription-only billing before the tick runs.
 *
 * 2. `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is set AND the
 *    configured spawner is not `api-key`. This means the orchestrator will
 *    silently fall back to API-key billing on spawner-unavailable errors
 *    (e.g. when the configured CLI or bridge isn't reachable). Operators
 *    often don't realise the fallback is wired.
 *
 * Exported so tests can assert the exact message text.
 */
export const BILLING_SAFETY_WARNING_LINES = [
  '[orchestrator] warning: ANTHROPIC_API_KEY is set but --spawner claude is requested.',
  "If the dispatch falls back to --spawner api-key for any reason, you'll be billed",
  'for paid API tokens. To force subscription-only, unset ANTHROPIC_API_KEY before',
  'running the tick.',
] as const;

export const FALLBACK_BILLING_WARNING_LINES = [
  '[orchestrator] warning: AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key is set.',
  'If the configured spawner is unavailable the orchestrator will silently retry',
  'with --spawner api-key, billing paid API tokens. Unset ANTHROPIC_API_KEY to',
  'prevent API-key overflow, or unset AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK to',
  'disable the silent fallback entirely.',
] as const;

/**
 * Check whether billing-safety warnings should fire for the given spawner
 * kind + environment, and write them to stderr. Called before every `tick`
 * and `start` dispatch that goes through the umbrella dispatcher.
 *
 * Exported so tests can exercise the warning logic without going through
 * the full yargs parse round-trip.
 */
export function emitBillingSafetyWarnings(
  spawnerKind: string,
  env: Record<string, string | undefined> = process.env,
  stderrWrite: (msg: string) => void = (msg) => process.stderr.write(msg),
): void {
  const apiKeySet = Boolean(env.ANTHROPIC_API_KEY);
  const fallbackEnv = (env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK ?? '').trim();

  // Warning 1: spawner=claude + ANTHROPIC_API_KEY in env
  if (spawnerKind === 'claude' && apiKeySet) {
    stderrWrite(BILLING_SAFETY_WARNING_LINES.join('\n') + '\n');
  }

  // Warning 2: SPAWNER_FALLBACK=api-key AND configured spawner != api-key
  if (fallbackEnv === 'api-key' && spawnerKind !== 'api-key') {
    stderrWrite(FALLBACK_BILLING_WARNING_LINES.join('\n') + '\n');
  }
}

function buildConfig(argv: Record<string, unknown>): OrchestratorConfig {
  const maxTicks =
    argv['max-ticks'] === undefined || argv['max-ticks'] === null
      ? null
      : Number(argv['max-ticks']);
  return defaultOrchestratorConfig({
    workDir: String(argv['work-dir']),
    tickIntervalSec: Number(argv['tick-interval-sec'] ?? DEFAULT_TICK_INTERVAL_SEC),
    maxConcurrent: Number(argv['max-concurrent'] ?? DEFAULT_MAX_CONCURRENT),
    maxTicks: maxTicks === null || Number.isNaN(maxTicks) ? null : maxTicks,
    dryRun: Boolean(argv['dry-run']),
  });
}

function buildAdapters(
  argv: Record<string, unknown>,
  adapters?: OrchestratorAdapters,
): OrchestratorAdapters {
  const rawSpawner = argv.spawner;
  if (rawSpawner === undefined || rawSpawner === null) {
    return adapters ?? {};
  }
  return {
    ...(adapters ?? {}),
    umbrellaSpawnerKind: String(rawSpawner) as SpawnerKind,
  };
}

/**
 * Build the cli-orchestrator yargs program. Exported so tests can drive the
 * parser without going through process.argv.
 *
 * The optional `adapters` argument lets tests inject a fake dispatcher /
 * frontier / escalator. Production invocations leave it undefined and pick
 * up the real-world defaults (cli-deps frontier query, executePipeline,
 * `gh pr edit --add-label`).
 *
 * The optional `distStaleness` argument lets tests inject staleness-check
 * overrides (packageRoot, pnpmBin, spawnFn, stderrWrite). Production
 * invocations leave it undefined and pick up real env/fs defaults.
 */
export function buildOrchestratorCli(
  adapters?: OrchestratorAdapters,
  distStaleness?: DistStalenessOptions,
): Argv {
  const cwdDefault = (): string => process.cwd();

  return yargs(hideBin(process.argv))
    .scriptName('cli-orchestrator')
    .usage('Usage: $0 <command> [options]')
    .option('work-dir', {
      alias: 'w',
      describe: 'Project root (defaults to cwd).',
      type: 'string',
      default: cwdDefault(),
    })
    .option('tick-interval-sec', {
      describe: 'Polling cadence between ticks (default 30s).',
      type: 'number',
      default: DEFAULT_TICK_INTERVAL_SEC,
    })
    .option('max-concurrent', {
      describe: 'Max concurrent dispatches per tick (Phase 1 default 1).',
      type: 'number',
      default: DEFAULT_MAX_CONCURRENT,
    })
    .option('spawner', {
      describe:
        `Spawner for umbrella dispatch. Also configurable with ${ORCHESTRATOR_SPAWNER_ENV}. ` +
        'Effective default is claude (subscription billing via claude -p) — resolved in ' +
        'resolveUmbrellaSpawnerKind so the env var is honored when --spawner is absent. ' +
        'The legacy `claude-cli` inline-manifest spawner was removed in RFC-0041 ' +
        'Phase 3.3 (AISDLC-377.6); use the Dispatch Board model ' +
        '(`/ai-sdlc orchestrator-tick` + `/ai-sdlc dispatch-worker`) for ' +
        'subscription-billed parallel autonomous drain.',
      type: 'string',
      choices: SPAWNER_KINDS,
      // NO yargs `default` — see AISDLC-352 code-reviewer MAJOR. A yargs default
      // populates argv.spawner unconditionally, which shadows AI_SDLC_ORCHESTRATOR_SPAWNER
      // env var in resolveUmbrellaSpawnerKind. The 'claude' fallback lives in
      // resolveUmbrellaSpawnerKind (loop.ts) ONLY, where it correctly runs AFTER the
      // env-var check.
    })
    .command(
      'start',
      'Run the polling loop until SIGINT/SIGTERM. Foreground process — supervise via terminal, systemd, Docker, or GH Actions self-hosted runner.',
      (y) =>
        y.option('max-ticks', {
          describe: 'Optional cap on tick count (default: run forever).',
          type: 'number',
        }),
      async (argv) => {
        if (!isOrchestratorEnabled()) {
          fail(orchestratorDisabledMessage(), 2);
        }
        checkAndRebuildIfStale(distStaleness);
        const config = buildConfig(argv as Record<string, unknown>);
        const resolvedAdapters = buildAdapters(argv as Record<string, unknown>, adapters);
        // AISDLC-352 — emit billing-safety warnings before dispatch
        emitBillingSafetyWarnings(resolveUmbrellaSpawnerKind(resolvedAdapters));
        try {
          const ticks = await runOrchestratorLoop(config, resolvedAdapters);
          emit({
            ok: true,
            mode: 'start',
            ticksRun: ticks.length,
            lastTick: ticks[ticks.length - 1] ?? null,
          });
        } catch (err) {
          if (err instanceof OrchestratorDisabledError) {
            fail(err.message, 2);
          }
          throw err;
        }
      },
    )
    .command(
      'tick',
      'Run a single tick and exit. Useful for cron-driven invocations or one-shot testing.',
      (y) =>
        y
          .option('dry-run', {
            describe: 'Resolve the frontier but skip dispatch.',
            type: 'boolean',
            default: false,
          })
          .option('continue-from-result', {
            describe:
              'Path to a dispatch-result.json written by the slash command body. ' +
              'When set, the tick reads the pre-completed Agent result and forwards it to the ' +
              'pipeline (Steps 6+) instead of re-dispatching the task. ' +
              'Defaults to $ARTIFACTS_DIR/_orchestrator/dispatch-result.json when the flag is ' +
              'present but no path is given.',
            type: 'string',
            // Allow `--continue-from-result` without a value (boolean-style).
            // Yargs treats a `string` option without a value as an empty string;
            // we normalize that below.
          })
          .option('task-from-file', {
            describe:
              'AISDLC-373 — single-PR operator-driven path. Path to a backlog ' +
              'task file (under `backlog/tasks/` or `backlog/completed/`, often ' +
              'inside `.worktrees/<id>/`) the operator has already created. ' +
              'Bypasses the frontier scan AND the §4.3 admission filter chain ' +
              'and dispatches a developer subagent against the file directly. ' +
              'The dispatched dev commits the task file alongside the ' +
              'implementation, landing both in a single PR.',
            type: 'string',
          }),
      async (argv) => {
        if (!isOrchestratorEnabled()) {
          fail(orchestratorDisabledMessage(), 2);
        }
        checkAndRebuildIfStale(distStaleness);
        const config = buildConfig({ ...argv, 'max-ticks': 1 } as Record<string, unknown>);

        // AISDLC-225 — resolve the continueFromResultPath when the flag is
        // present. A bare `--continue-from-result` (no value) resolves to the
        // default artifact path; an explicit path is used as-is.
        const rawContinue = argv['continue-from-result'];
        const continueFromResultPath: string | undefined =
          rawContinue !== undefined && rawContinue !== null
            ? rawContinue.length > 0
              ? rawContinue
              : resolveResultPath() // bare flag → default path
            : undefined;

        // AISDLC-373 — single-PR operator-driven path. When --task-from-file
        // is set, synthesize a one-element frontier from the resolved task file
        // and bypass the §4.3 admission filter chain. The operator has already
        // chosen the task; the dependency-graph frontier hasn't observed the
        // worktree-local task file yet, so consulting it would return empty.
        const rawTaskFromFile = argv['task-from-file'];
        let taskFromFileFrontier: OrchestratorAdapters['frontier'] | undefined;
        let bypassFilters = false;
        if (typeof rawTaskFromFile === 'string' && rawTaskFromFile.length > 0) {
          try {
            const resolved = resolveTaskFromFile(rawTaskFromFile, config.workDir);
            // AISDLC-373 round 2 — include the resolved absolute `filePath` on
            // the synthetic frontier entry so the orchestrator loop can build
            // its per-task taskFilePathOverride map (consumed by the default
            // dispatchers when calling `runExecuteCommand` / `executePipeline`).
            // Without this, the inner Step 1 `validateTask` would scan
            // `<workDir>/backlog/tasks/` and never find the worktree-local
            // file the operator created — breaking the documented runbook.
            taskFromFileFrontier = () => [
              { id: resolved.id, title: resolved.title, filePath: resolved.filePath },
            ];
            bypassFilters = true;
          } catch (err) {
            if (err instanceof TaskFromFileResolutionError) {
              fail(`--task-from-file: ${err.message}`, 1);
            }
            throw err;
          }
        }

        const baseAdapters = buildAdapters(argv as Record<string, unknown>, adapters);
        const tickAdapters: OrchestratorAdapters = {
          ...baseAdapters,
          ...(continueFromResultPath !== undefined ? { continueFromResultPath } : {}),
          // --task-from-file overrides any injected frontier (CLI flag wins
          // over test-injected fakes that didn't anticipate this path).
          ...(taskFromFileFrontier !== undefined ? { frontier: taskFromFileFrontier } : {}),
          ...(bypassFilters ? { bypassFilters: true } : {}),
        };

        // AISDLC-352 — emit billing-safety warnings before dispatch
        emitBillingSafetyWarnings(resolveUmbrellaSpawnerKind(tickAdapters));

        const result = await runOrchestratorTick(config, tickAdapters, 1);
        emit({ ok: true, mode: 'tick', tick: result });
      },
    )
    .command(
      'write-dispatch-result',
      'Write a dispatch-result.json to disk. Called by the /ai-sdlc orchestrator-tick slash ' +
        'command body after the Agent tool call completes (AISDLC-225 consumer bridge).',
      (y) =>
        y
          .option('task-id', {
            describe: 'Task ID that was dispatched (e.g. AISDLC-123).',
            type: 'string',
            demandOption: true,
          })
          .option('subagent-type', {
            describe:
              'Subagent type that was invoked (developer | code-reviewer | test-reviewer | security-reviewer).',
            type: 'string',
            demandOption: true,
          })
          .option('status', {
            describe: 'Outcome of the Agent call: success | error.',
            type: 'string',
            choices: ['success', 'error'],
            demandOption: true,
          })
          .option('output', {
            describe: 'Raw output from the Agent call.',
            type: 'string',
            default: '',
          })
          .option('result-path', {
            describe:
              'Absolute path where the result JSON is written. ' +
              'Defaults to $ARTIFACTS_DIR/_orchestrator/dispatch-result.json.',
            type: 'string',
          })
          .option('parsed', {
            describe:
              'Parsed structured payload from the Agent output (JSON string). ' +
              'For developer subagents this is the JSON return envelope.',
            type: 'string',
          })
          .option('error', {
            describe: 'Error message when status is "error".',
            type: 'string',
          })
          .option('start-ms', {
            describe:
              'Unix epoch timestamp in milliseconds when the dispatch started. ' +
              'Used to compute durationMs = Date.now() - startMs.',
            type: 'number',
          })
          .option('duration-ms', {
            describe:
              'Duration of the Agent call in milliseconds. ' +
              'Mutually exclusive with --start-ms (start-ms wins when both are set).',
            type: 'number',
            default: 0,
          }),
      (argv) => {
        const taskId = String(argv['task-id']);
        const subagentType = String(argv['subagent-type']);
        const status = argv['status'] as 'success' | 'error';
        const output = String(argv['output'] ?? '');
        const resultPath = argv['result-path'] ? String(argv['result-path']) : undefined;
        const errorMsg = argv['error'] ? String(argv['error']) : undefined;

        // Parse the optional --parsed JSON string.
        let parsedPayload: unknown | undefined;
        const rawParsed = argv['parsed'];
        if (rawParsed) {
          try {
            parsedPayload = JSON.parse(rawParsed);
          } catch {
            fail(`--parsed is not valid JSON: ${rawParsed}`, 1);
          }
        }

        // Compute durationMs: prefer (now - startMs) when --start-ms is given.
        const startMs = argv['start-ms'];
        const durationMs =
          typeof startMs === 'number' && startMs > 0
            ? Math.max(0, Date.now() - startMs)
            : ((argv['duration-ms'] as number | undefined) ?? 0);

        const resultFields: Omit<DispatchResult, 'version' | 'writtenAt'> = {
          taskId,
          // Cast to SubagentType — CLI validates the string is one of the known values
          // via the allowed `choices` on `subagent-type` (no .choices() here since
          // SubagentType is a TS union; runtime validation is intentionally permissive
          // to allow future types without a deploy).
          subagentType: subagentType as DispatchResult['subagentType'],
          status,
          output,
          durationMs,
          ...(parsedPayload !== undefined ? { parsed: parsedPayload } : {}),
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
        };

        const envelope = writeDispatchResult(resultFields, { resultPath });
        emit({ ok: true, mode: 'write-dispatch-result', result: envelope });
      },
    )
    .command(
      'status',
      'Print the current frontier + queue depth + configured concurrency. Read-only — does not dispatch.',
      (y) => y,
      async (argv) => {
        const config = buildConfig(argv as Record<string, unknown>);
        const status = await buildOrchestratorStatus(config, adapters ?? {});
        emit({
          ok: true,
          mode: 'status',
          status,
          flag: ORCHESTRATOR_FLAG,
        });
      },
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Entry point used by the cli-orchestrator bin shim. Tests typically call
 * `buildOrchestratorCli(adapters).parseAsync(...)` instead so they can pass
 * fakes; the bin shim has no fakes to inject.
 */
export async function runOrchestratorCli(): Promise<void> {
  await buildOrchestratorCli().parseAsync();
}
