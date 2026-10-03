/**
 * `cli-hierarchy` — start, inspect and stop the session hierarchy.
 *
 * Subcommands:
 *
 *   - `up [--executors <n>] [--planner-model <m>] [--dispatch-model <m>]
 *     [--executor-model <m>] [--no-planner] [--attach]` — start the planner, the
 *     dispatch session and up to five executors, each in its own detached tmux
 *     session named after the agent, and write the roster. Idempotent.
 *   - `status [--json]` — the roster with each session's live state, whether a
 *     client is attached, and the board's inflight task.
 *   - `attach <name>` — show one agent in this terminal (`switch-client` inside
 *     tmux, `attach-session` outside).
 *   - `terminals --vscode [--out <dir>] [--force] [--print]` — generate a VS Code
 *     `tasks.json` that opens one terminal per agent.
 *   - `brief --tasks <id,...> | --rfc <RFC-NNNN> [--out <path>] [--force] [--notify]` —
 *     write a dispatch brief from task metadata and optionally tell the dispatch
 *     session about it.
 *   - `down [--role <name-or-role>]` — end sessions, return their inflight
 *     manifests to `queue/`, close their windows, update the roster.
 *   - `clear <executor-name> [--settle-ms <n>]` — empty an executor's context:
 *     `/clear`, wait, then `/ai-sdlc executor`. Refuses an executor that holds
 *     an inflight task.
 *   - `tick --worker <dispatch-name> [--report-every-ms <n>] [--settle-ms <n>]
 *     [--retry-limit <n>] [--work-dir <path>]` — one wake-up of the dispatch
 *     loop: ingest briefs, handle new verdicts (clear, unblocking playbook),
 *     and print the escalations and reports to send, as JSON.
 *   - `route-decision --decision-id <id> --route operational|design --to <name>`
 *     — record that a decision was routed to a tier.
 *
 * All subcommands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`).
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_BOARD_DIR } from '../dispatch/board.js';
import { enqueueTasks, type EnqueueEntry } from '../dispatch/enqueue.js';
import { requeueFailed } from '../dispatch/requeue.js';
import {
  attachTmuxSession,
  clearExecutor,
  createStreamEmitter,
  createSystemRunner,
  createTmuxBriefSender,
  generateBrief,
  notifyDispatch,
  type BriefSender,
  formatStatus,
  hierarchyAttach,
  hierarchyDown,
  hierarchyStatus,
  hierarchyTerminals,
  hierarchyUp,
  loadOperational,
  readRosterChecked,
  runDispatchTick,
  runPlaybook,
  systemResourceSnapshot,
  type HierarchyDeps,
} from '../hierarchy/index.js';
import { findTaskFile, parseArgv, resolveBaseSha } from './dispatch.js';

const USAGE = `Usage: cli-hierarchy <command> [options]

Commands:
  up         Start the planner, dispatch session and executors, one tmux session each
  status     Show the roster with live state, attached clients and inflight tasks
  attach     Show one agent in this terminal: attach <name>
  terminals  Generate editor terminal tasks, one per agent (terminals --vscode)
  brief      Generate a dispatch brief (waves, sequence groups) from task metadata
  down       Stop sessions and return their inflight manifests to the queue
  clear      Empty an executor's context between tasks and restart its loop
  tick       One wake-up of the dispatch loop (ingest, verdict watch, playbook, reports)
  route-decision  Record that a decision was routed to a tier

Options for up:
  --executors <n>          Number of executors, 0 to 5 (default 5)
  --planner-model <m>      Planner model (default fable)
  --dispatch-model <m>     Dispatch model (default opus)
  --executor-model <m>     Executor model (default sonnet)
  --no-planner             Do not start a planner
  --attach                 Show the planner (or the dispatch session) when done
  --allow-planner-bypass   Allow the planner to start in bypassPermissions mode

Options for status:
  --json                   Print machine-readable output

Options for attach:
  <name>                   Agent name from the roster (planner, operator-dispatch, executor-alpha, ...)
                           Uses switch-client when TMUX is set, attach-session otherwise.

Options for terminals:
  --vscode                 Write a VS Code tasks.json (the only supported target)
  --out <dir>              Output directory (default ./.vscode)
  --force                  Replace an existing tasks.json
  --print                  Print the JSON to stdout instead of writing a file

Options for brief:
  --tasks <id,...>         Task ids to include
  --rfc <RFC-NNNN>         Include every open task that references the RFC
  --out <path>             Output file (default <board-dir>/briefs/<slug>.md)
  --force                  Replace an existing brief
  --notify                 Message the dispatch session that the brief is ready; an existing
                           brief is kept as edited (use --force to regenerate it)

Options for down:
  --role <name-or-role>    Stop one session by name (executor-beta) or a role (executor)

Usage for clear:
  cli-hierarchy clear <executor-name> [--settle-ms <n>]
  Sends /clear to the executor's pane, waits for the settle time (default 8000 ms),
  then sends /ai-sdlc executor. Refuses an executor that holds an inflight task.

Options for tick:
  --worker <name>          Roster name of the dispatch session (required)
  --report-every-ms <n>    Spacing of progress reports (default 900000)
  --settle-ms <n>          Settle time used for clears (default 8000)
  --retry-limit <n>        Re-queues allowed per failed task (default 2)
  --work-dir <path>        Repository root (default the current directory)

Options for route-decision:
  --decision-id <id>       Decision Catalog id
  --route <name>           operational or design
  --to <name>              Session name or role that now owns the decision
  --task-id <id>           Task the decision belongs to (optional)
  --worker <name>          Roster name of the dispatch session (optional)

Common options:
  --board-dir <path>       Dispatch board directory (default ${DEFAULT_BOARD_DIR})
`;

/** Parse an optional whole-number flag; null (after writing an error) when malformed. */
function intFlag(flags: Record<string, string>, name: string): number | undefined | null {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    process.stderr.write(`cli-hierarchy: --${name} must be a whole number (got '${raw}')\n`);
    return null;
  }
  return Number.parseInt(raw, 10);
}

/** Build the production dependencies. Tests pass overrides instead. */
export function defaultHierarchyDeps(flags: Record<string, string>): HierarchyDeps {
  const cwd = process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const run = createSystemRunner();
  return {
    run,
    boardDir: path.resolve(flags['board-dir'] ?? DEFAULT_BOARD_DIR),
    cwd,
    registryDir: path.join(configDir, 'sessions'),
    settingsFiles: [
      path.join(configDir, 'settings.json'),
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
    ],
    userSettingsFile: path.join(configDir, 'settings.json'),
    resources: () => systemResourceSnapshot(run),
    env: process.env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => process.stdout.write(line + '\n'),
    attach: attachTmuxSession,
    claudeBin: 'claude',
    pollAttempts: 20,
    pollIntervalMs: 500,
    emit: createStreamEmitter(),
  };
}

/**
 * First argument after the subcommand that is neither a `--flag` nor a flag's
 * value (`parseArgv` treats every non-flag token as a value or drops it).
 */
export function firstPositional(argv: readonly string[]): string | undefined {
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (token.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * CLI entry point. Returns the intended exit code. Tests call this with
 * synthetic argv and injected dependencies.
 */
export async function runHierarchyCli(
  argv: readonly string[] = process.argv.slice(2),
  overrides: Partial<HierarchyDeps> = {},
  extras: {
    sendBrief?: BriefSender;
    /** Replaces the policy file as the source of the operational grants (tests). */
    operational?: ReadonlySet<string>;
    /** Replaces the board enqueue (tests). */
    enqueue?: (entries: EnqueueEntry[]) => string[];
  } = {},
): Promise<number> {
  const { subcommand, flags } = parseArgv(argv);
  if (
    subcommand === '' ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    flags.help === 'true'
  ) {
    process.stdout.write(USAGE);
    return 0;
  }
  const deps: HierarchyDeps = { ...defaultHierarchyDeps(flags), ...overrides };

  try {
    switch (subcommand) {
      case 'up': {
        const result = await hierarchyUp(
          {
            executors: flags.executors ?? '5',
            plannerModel: flags['planner-model'] ?? 'fable',
            dispatchModel: flags['dispatch-model'] ?? 'opus',
            executorModel: flags['executor-model'] ?? 'sonnet',
            noPlanner: flags['no-planner'] === 'true',
            attach: flags.attach === 'true',
            allowPlannerBypass: flags['allow-planner-bypass'] === 'true',
          },
          deps,
        );
        return result.attachExitCode ?? 0;
      }
      case 'status': {
        const result = hierarchyStatus(deps);
        if (flags.json === 'true') deps.log(JSON.stringify(result));
        else for (const line of formatStatus(result)) deps.log(line);
        return 0;
      }
      case 'attach': {
        const name = firstPositional(argv);
        if (!name) {
          process.stderr.write(`cli-hierarchy: attach needs an agent name\n\n${USAGE}`);
          return 2;
        }
        return hierarchyAttach(name, deps);
      }
      case 'terminals': {
        if (flags.vscode === undefined) {
          process.stderr.write(`cli-hierarchy: terminals needs --vscode\n\n${USAGE}`);
          return 2;
        }
        hierarchyTerminals(
          {
            out: flags.out === 'true' ? undefined : flags.out,
            force: flags.force === 'true',
            print: flags.print === 'true',
          },
          deps,
        );
        return 0;
      }
      case 'brief': {
        const result = generateBrief(
          {
            tasks: flags.tasks === 'true' ? '' : flags.tasks,
            rfc: flags.rfc === 'true' ? '' : flags.rfc,
            out: flags.out === 'true' ? undefined : flags.out,
            force: flags.force === 'true',
            keepExisting: flags.notify === 'true',
          },
          deps,
        );
        deps.log(result.reused ? `kept existing ${result.file}` : `wrote ${result.file}`);
        if (flags.notify === 'true') {
          const send = extras.sendBrief ?? createTmuxBriefSender(deps.run);
          notifyDispatch(result.dispatch, result.file, deps.cwd, send);
          deps.log(`notified '${result.dispatch?.name}'`);
        }
        return 0;
      }
      case 'down': {
        const result = await hierarchyDown({ role: flags.role }, deps);
        // A session left alone (not started by `up`, stale pane) is not a success.
        return result.refused.length > 0 ? 1 : 0;
      }
      case 'clear': {
        const executor = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
        if (!executor) {
          process.stderr.write('cli-hierarchy clear: an executor name is required\n');
          return 2;
        }
        const settleMs = intFlag(flags, 'settle-ms');
        if (settleMs === null) return 2;
        const result = await clearExecutor(
          { executor, ...(settleMs === undefined ? {} : { settleMs }) },
          {
            run: deps.run,
            boardDir: deps.boardDir,
            sleep: deps.sleep,
            ...(deps.emit ? { emit: deps.emit } : {}),
            log: deps.log,
          },
        );
        deps.log(JSON.stringify(result));
        return 0;
      }
      case 'tick': {
        const worker = flags.worker;
        const sessions = readRosterChecked(deps.boardDir).roster.sessions;
        if (
          !worker ||
          !sessions.some(
            (e) => e.name === worker && e.role === 'operator-dispatch' && e.status === 'running',
          )
        ) {
          process.stderr.write(
            'cli-hierarchy tick: --worker must be the roster name of the running dispatch session\n',
          );
          return 1;
        }
        const settleMs = intFlag(flags, 'settle-ms');
        const reportEveryMs = intFlag(flags, 'report-every-ms');
        const retryLimit = intFlag(flags, 'retry-limit');
        if (settleMs === null || reportEveryMs === null || retryLimit === null) return 2;
        const repoRoot = path.resolve(flags['work-dir'] ?? deps.cwd);
        const operational = extras.operational ?? loadOperational(repoRoot, deps.cwd);
        const emit = deps.emit ?? (() => {});
        const result = await runDispatchTick({
          boardDir: deps.boardDir,
          workerId: worker,
          now: deps.now,
          enqueue:
            extras.enqueue ??
            ((entries) =>
              enqueueTasks(deps.boardDir, entries, {
                baseSha: resolveBaseSha(repoRoot),
                dispatchedBy: worker,
                resolveTaskFile: (id) => findTaskFile(repoRoot, id),
              })),
          clear: (o) =>
            clearExecutor(
              {
                executor: o.executor,
                taskId: o.taskId,
                workerId: worker,
                ...(settleMs === undefined ? {} : { settleMs }),
              },
              { run: deps.run, boardDir: deps.boardDir, sleep: deps.sleep, emit },
            ),
          playbook: (verdict) =>
            runPlaybook(verdict, {
              run: deps.run,
              repoRoot,
              operational,
              requeue: (id) =>
                requeueFailed(deps.boardDir, id, retryLimit === undefined ? {} : { retryLimit }),
              emit,
              workerId: worker,
            }),
          operational,
          ...(reportEveryMs === undefined ? {} : { reportEveryMs }),
        });
        deps.log(JSON.stringify(result));
        return 0;
      }
      case 'route-decision': {
        const route = flags.route;
        const decisionId = flags['decision-id'];
        const to = flags.to;
        if (!decisionId || decisionId === 'true' || !to || to === 'true') {
          process.stderr.write(
            'cli-hierarchy route-decision: --decision-id and --to are required\n',
          );
          return 2;
        }
        if (route !== 'operational' && route !== 'design') {
          process.stderr.write(
            'cli-hierarchy route-decision: --route must be operational or design\n',
          );
          return 2;
        }
        deps.emit?.({
          type: 'DecisionRouted',
          decisionId,
          route,
          routedTo: to,
          ...(flags['task-id'] ? { taskId: flags['task-id'] } : {}),
          ...(flags.worker ? { workerId: flags.worker } : {}),
        });
        deps.log(JSON.stringify({ ok: true, decisionId, route, routedTo: to }));
        return 0;
      }
      default:
        process.stderr.write(`cli-hierarchy: unknown command '${subcommand}'\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`cli-hierarchy: ${(err as Error).message}\n`);
    return 1;
  }
}
