/**
 * `cli-hierarchy` — start, inspect and stop the session hierarchy.
 *
 * Subcommands:
 *
 *   - `up [--executors <n>] [--planner-model <m>] [--dispatch-model <m>]
 *     [--executor-model <m>] [--no-planner] [--attach] [--no-vscode-tasks]` — start the planner, the
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
 *   - `executor-start [--wait <sec>]` — an executor's identity, repository check and a
 *     blocking claim in one call; prints `{taskId|null, ...}`.
 *   - `clear <executor-name> [--settle-ms <n>]` — empty an executor's context:
 *     `/clear`, wait, then `/ai-sdlc executor`. Refuses an executor that holds
 *     an inflight task.
 *   - `tick [--worker <dispatch-name>] [--report-every-ms <n>] [--settle-ms <n>]
 *     [--retry-limit <n>] [--work-dir <path>]` — one wake-up of the dispatch
 *     loop: ingest briefs, handle new verdicts (clear, unblocking playbook),
 *     and print the escalations and reports to send, as JSON.
 *   - `check-sender [--sender-pid <n>] [--sender-ref <ref>]` — exit 0 only when the
 *     sender is this roster's running dispatch session (compared by pid or harness ref,
 *     never by a name written in a message); otherwise print `not my dispatch session`
 *     and exit 1. When the harness reports neither a pid nor a ref it fails open: a warning
 *     on stderr, exit 0. Used by the executor skill before acting on an instruction.
 *   - `check-repo` — exit 0 only when the working directory is in the repository that
 *     owns this roster's board; otherwise print why and exit 1.
 *   - `handoff write|read --role <planner|operator-dispatch|executor> [--name <n>]` — write
 *     (from board and catalog state) or read (regenerating when stale) a session's handoff file.
 *   - `auto-clear --transcript <path>` — Stop-hook entry: when the session's context is over
 *     its role threshold, refresh its handoff and schedule `clear --self`.
 *   - `route-decision --decision-id <id> --route operational|design --to <name>`
 *     — record that a decision was routed to a tier.
 *
 * All subcommands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`).
 *
 * `clear`, `tick` and `route-decision` are dispatch-session commands. A mistake
 * guard keeps other sessions from running them by accident: it finds the calling
 * session from the process tree and the roster and refuses unless that is the running
 * dispatch session. A `--worker` value is only compared with that result. The guard is
 * not authentication; a session running as the same user can defeat it.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_BOARD_DIR, TASK_ID_RE } from '../dispatch/board.js';
import { enqueueTasks, type EnqueueEntry } from '../dispatch/enqueue.js';
import { requeueFailed } from '../dispatch/requeue.js';
import { DEFAULT_REQUEUE_RETRY_LIMIT } from '../dispatch/session-reaper.js';
import { DECISION_ID_RE } from '../dispatch/verdict-fields.js';
import {
  attachTmuxSession,
  checkDispatchCaller,
  checkOwnWorktreeForOperator,
  clearExecutor,
  clearSelf,
  decideAutoClear,
  readHandoff as readGeneratedHandoff,
  writeHandoff,
  createGitRunner,
  createStreamEmitter,
  createSystemIdentity,
  executorStart,
  resolveCaller,
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
  loadOperationalPolicy,
  markReadyAfterCodeql,
  checkDispatchSender,
  checkRepoMatch,
  readRosterChecked,
  rosterProject,
  runDispatchTick,
  runPlaybook,
  SAFE_SESSION_NAME,
  systemResourceSnapshot,
  type AsyncCommandRunner,
  type CommandRunner,
  type DispatchCallerInputs,
  type ForcePushMode,
  type GitRunner,
  type HierarchyDeps,
  type HierarchyRole,
  type IdentityDeps,
  type OperationalPolicy,
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
  handoff         Write or read a session's handoff file (handoff write|read --role <r>)
  auto-clear      Clear this session when its context is over the role threshold (Stop hook)
  executor-start  Executor identity, repository check and a blocking claim, as one call
  check-sender    Exit 0 only when a message sender is this roster's dispatch session
  check-repo      Exit 0 only when the working directory is this roster's repository

Options for up:
  --executors <n>          Number of executors, 0 to 5 (default 5)
  --planner-model <m>      Planner model (default fable)
  --dispatch-model <m>     Dispatch model (default sonnet)
  --executor-model <m>     Executor model (default sonnet)
  --no-planner             Do not start a planner
  --project <name>         Project the session names are qualified with: <project>-<role>
                           (default the repository basename). Needed, with a distinct
                           value, when sessions with the same role names already run
                           for another project on this machine.
  --attach                 Show the planner (or the dispatch session) when done
  --no-vscode-tasks        Do not regenerate .vscode/tasks.json. By default up rewrites it
                           when it starts a session or the roster changes, but only if the
                           file is absent or carries the "ai-sdlc" generated marker; inside
                           a VS Code terminal it ends by naming the task to run
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
  cli-hierarchy clear --self [--resume-after <seconds>]
  --self schedules the calling session's own pane (from its roster entry) to receive
  /clear after 20 s and then, --resume-after seconds later (default 60) or sooner when a new
  brief or verdict file lands on the board, the resume command: /ai-sdlc operator-dispatch
  for the dispatch session, /ai-sdlc:planner for the planner, /ai-sdlc executor for an idle
  executor (which is refused while it holds an inflight task). Refuses without TMUX_PANE.
  Sends /clear to the executor's pane, waits for the settle time (default 8000 ms),
  then sends /ai-sdlc executor. Refuses an executor that holds an inflight task.
  clear <executor-name> is for the dispatch session only. A mistake guard refuses any other caller, a human
  at a plain shell included; it is not authentication and a same-user session can defeat
  it. Outside the hierarchy, use tmux directly.

Options for tick:
  --worker <name>          Optional; when given it must equal the calling session's own roster name
  --report-every-ms <n>    Spacing of progress reports (default 900000)
  --settle-ms <n>          Settle time used for clears (default 8000)
  --retry-limit <n>        Re-queues allowed per failed task (default 2; a larger value is refused)
  --work-dir <path>        Repository root (default the current directory)

Options for executor-start:
  --wait <seconds>         How long to block waiting for a task (default 1500). Prints the
                           identity line, then one JSON line: {name, project, dispatch,
                           taskId|null, manifest?}. Exit 1 when this is not an executor
                           session or the working directory is not the project's repository.

Options for check-sender:
  --sender-pid <n>         Pid the harness reports for the sender
  --sender-ref <ref>       Session ref the harness reports for the sender
  (a name written in the message text is never used)

Options for handoff:
  write | read             write regenerates the file from board and catalog state; read
                           returns it, regenerating first when it is missing or stale
  --role <r>               planner, operator-dispatch (or dispatch), or executor
  --name <n>               Session name (default the calling session's roster name, else the role)
  --out <path>             Alternative file location

Options for auto-clear:
  --transcript <path>      Session transcript whose usage fields give the context size
                           Thresholds: planner 150000, dispatch 120000, executor 120000 tokens;
                           override with contextThresholds in <board-dir>/config.json

Options for route-decision:
  --decision-id <id>       Decision Catalog id
  --route <name>           operational or design
  --to <name>              Session name or role that now owns the decision
  --task-id <id>           Task the decision belongs to (optional)
  --worker <name>          Optional; when given it must equal the calling session's own roster name

Common options:
  --board-dir <path>       Dispatch board directory (default ${DEFAULT_BOARD_DIR})
`;

/** Largest handoff text `tick` hands back, in characters. */
const HANDOFF_MAX_CHARS = 8000;

/**
 * The dispatch handoff, regenerated from board and catalog state after this tick's changes
 * (so it is never stale), or undefined when it cannot be written.
 */
function dispatchHandoff(deps: HierarchyDeps, name: string): string | undefined {
  try {
    const { content } = writeHandoff({
      role: 'operator-dispatch',
      name,
      boardDir: deps.boardDir,
      now: deps.now,
    });
    return content.length > HANDOFF_MAX_CHARS
      ? `${content.slice(0, HANDOFF_MAX_CHARS)}\n[truncated]`
      : content;
  } catch {
    return undefined;
  }
}

/**
 * Whether this session can clear itself. The clear is typed into a tmux pane, so a session
 * outside tmux cannot do it; it must stop instead of polling with a growing context.
 */
export function selfClearAvailability(env: NodeJS.ProcessEnv): {
  available: boolean;
  reason?: string;
} {
  if (env.TMUX_PANE) return { available: true };
  return {
    available: false,
    reason:
      'TMUX_PANE is unset, so this session cannot clear itself. Start the dispatch session with ' +
      '`cli-hierarchy up` (it runs in tmux). Without tmux, stop after this tick instead of looping.',
  };
}

/** `--role` as a hierarchy role; `dispatch` is an alias of `operator-dispatch`. */
function parseRoleFlag(raw: string | undefined): HierarchyRole | null {
  if (raw === 'dispatch') return 'operator-dispatch';
  return raw === 'planner' || raw === 'operator-dispatch' || raw === 'executor' ? raw : null;
}

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
    /** Replaces the policy file as the source of the lease-push rules (tests). */
    lease?: {
      forcePushMode: ForcePushMode;
      protectedBranches: readonly string[];
      ownWorktree: (worktree: string) => string | null;
    };
    /** Replaces the roster and process lookups that identify the calling session (tests). */
    identity?: IdentityDeps;
    /** Replaces only the process lookups; the roster is still read from the trusted board (tests). */
    processLookup?: DispatchCallerInputs['processLookup'];
    /**
     * Replaces the git lookup of the main checkout and its board (tests). When
     * `identity` is injected without this, the board-location check is skipped.
     */
    trustedBoard?: { root: string; boardDir: string } | null;
    /** Replaces the install directory of the running module (tests). */
    installDir?: DispatchCallerInputs['installDir'];
    /** Replaces the git runner the unblocking playbook uses (tests). */
    gitRun?: CommandRunner | AsyncCommandRunner;
    /** Replaces the git lookup `check-repo` uses for the working directory's repository (tests). */
    repoGit?: GitRunner;
    /** Replaces the board enqueue (tests). */
    enqueue?: (entries: EnqueueEntry[]) => string[];
    /** Replaces the `gh` runner the mark-ready pass uses (tests). */
    ghRun?: CommandRunner;
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

  /**
   * The mistake guard: the caller should itself be the dispatch session, and
   * `--worker` is only compared with that result. Runs before anything is read,
   * written or sent. It is not authentication.
   */
  const dispatchCaller = (command: string): ReturnType<typeof checkDispatchCaller> =>
    checkDispatchCaller({
      label: `cli-hierarchy ${command}`,
      cwd: deps.cwd,
      boardDir: deps.boardDir,
      workDir: flags['work-dir'],
      worker: flags.worker,
      identity: extras.identity,
      processLookup: extras.processLookup,
      trustedBoard: extras.trustedBoard,
      installDir: extras.installDir,
    });

  try {
    switch (subcommand) {
      case 'up': {
        const result = await hierarchyUp(
          {
            executors: flags.executors ?? '5',
            plannerModel: flags['planner-model'] ?? 'fable',
            dispatchModel: flags['dispatch-model'] ?? 'sonnet',
            executorModel: flags['executor-model'] ?? 'sonnet',
            noPlanner: flags['no-planner'] === 'true',
            attach: flags.attach === 'true',
            ...(flags.project === undefined
              ? {}
              : { project: flags.project === 'true' ? '' : flags.project }),
            allowPlannerBypass: flags['allow-planner-bypass'] === 'true',
            vscodeTasks: flags['no-vscode-tasks'] !== 'true',
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
        // An idle executor and the planner may clear themselves; any other `--self` caller is the dispatch session.
        const executorSelf =
          flags.self === 'true'
            ? resolveCaller(
                extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
              )
            : null;
        if (executorSelf?.role === 'executor' || executorSelf?.role === 'planner') {
          const resumeAfter = intFlag(flags, 'resume-after');
          if (resumeAfter === null) return 2;
          const result = clearSelf(
            {
              self: executorSelf.name,
              role: executorSelf.role,
              ...(resumeAfter === undefined ? {} : { resumeAfterSeconds: resumeAfter }),
              ...(deps.env.TMUX_PANE ? { callerPane: deps.env.TMUX_PANE } : {}),
            },
            { run: deps.run, boardDir: deps.boardDir, log: deps.log },
          );
          deps.log(JSON.stringify(result));
          return 0;
        }
        const caller = dispatchCaller('clear');
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        if (flags.self === 'true') {
          const resumeAfter = intFlag(flags, 'resume-after');
          if (resumeAfter === null) return 2;
          const availability = selfClearAvailability(deps.env);
          if (!availability.available) {
            process.stderr.write(`cli-hierarchy clear --self: ${availability.reason}\n`);
            return 1;
          }
          const result = clearSelf(
            {
              self: caller.name,
              ...(resumeAfter === undefined ? {} : { resumeAfterSeconds: resumeAfter }),
              ...(deps.env.TMUX_PANE ? { callerPane: deps.env.TMUX_PANE } : {}),
              wakeOnBoardDir: deps.boardDir,
            },
            { run: deps.run, boardDir: deps.boardDir, log: deps.log },
          );
          deps.log(JSON.stringify(result));
          return 0;
        }
        const executor = firstPositional(argv);
        if (!executor) {
          process.stderr.write('cli-hierarchy clear: an executor name is required\n');
          return 2;
        }
        const settleMs = intFlag(flags, 'settle-ms');
        if (settleMs === null) return 2;
        const result = await clearExecutor(
          { executor, workerId: caller.name, ...(settleMs === undefined ? {} : { settleMs }) },
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
        const caller = dispatchCaller('tick');
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        const worker = caller.name;
        const settleMs = intFlag(flags, 'settle-ms');
        const reportEveryMs = intFlag(flags, 'report-every-ms');
        const retryLimit = intFlag(flags, 'retry-limit');
        if (settleMs === null || reportEveryMs === null || retryLimit === null) return 2;
        // Refused, not clamped; checked after the caller guard, like `cli-dispatch requeue`,
        // and before anything is read, written or sent.
        if (retryLimit !== undefined && retryLimit > DEFAULT_REQUEUE_RETRY_LIMIT) {
          process.stderr.write(
            `cli-hierarchy tick: --retry-limit may not exceed ${DEFAULT_REQUEUE_RETRY_LIMIT}; use ${DEFAULT_REQUEUE_RETRY_LIMIT} or less, or escalate with \`cli-decisions escalate\`\n`,
          );
          return 2;
        }
        const repoRoot = path.resolve(flags['work-dir'] ?? deps.cwd);
        let policy: OperationalPolicy | undefined;
        const readPolicy = (): OperationalPolicy =>
          (policy ??= loadOperationalPolicy(repoRoot, deps.cwd));
        const operational = extras.operational ?? readPolicy().operational;
        const lease = extras.lease ?? {
          forcePushMode: readPolicy().forcePushMode,
          protectedBranches: readPolicy().protectedBranches,
          ownWorktree: (worktree: string) => checkOwnWorktreeForOperator(repoRoot, worktree),
        };
        const gitRun = extras.gitRun ?? createGitRunner();
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
              run: gitRun,
              repoRoot,
              operational,
              forcePushMode: lease.forcePushMode,
              protectedBranches: lease.protectedBranches,
              ownWorktree: lease.ownWorktree,
              requeue: (id) =>
                requeueFailed(deps.boardDir, id, retryLimit === undefined ? {} : { retryLimit }),
              emit,
              workerId: worker,
            }),
          operational,
          markReady: () => markReadyAfterCodeql(extras.ghRun ?? deps.run, repoRoot),
          ...(reportEveryMs === undefined ? {} : { reportEveryMs }),
        });
        const planner = readRosterChecked(deps.boardDir).roster.sessions.find(
          (e) => e.role === 'planner' && e.status === 'running',
        );
        deps.log(
          JSON.stringify({
            ...result,
            identity: { name: worker, planner: planner?.name ?? '' },
            handoff: dispatchHandoff(deps, worker),
            selfClear: selfClearAvailability(deps.env),
          }),
        );
        return 0;
      }
      case 'executor-start': {
        const waitSec = intFlag(flags, 'wait');
        if (waitSec === null) return 2;
        try {
          const result = await executorStart(
            {
              boardDir: deps.boardDir,
              cwd: deps.cwd,
              ...(waitSec === undefined ? {} : { waitSec }),
            },
            {
              identity:
                extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
              ...(extras.repoGit ? { repoGit: extras.repoGit } : {}),
              log: deps.log,
            },
          );
          deps.log(JSON.stringify(result));
          return 0;
        } catch (err) {
          process.stderr.write(`cli-hierarchy executor-start: ${(err as Error).message}\n`);
          return 1;
        }
      }
      case 'check-sender': {
        const pid = intFlag(flags, 'sender-pid');
        if (pid === null) return 2;
        const ref = flags['sender-ref'] === 'true' ? undefined : flags['sender-ref'];
        const { roster } = readRosterChecked(deps.boardDir);
        const check = checkDispatchSender(roster.sessions, { pid, ref });
        if (!check.ok) {
          process.stderr.write(`${check.reason}\n`);
          return 1;
        }
        if (check.warning !== undefined) {
          process.stderr.write(`cli-hierarchy check-sender: ${check.warning}\n`);
          deps.log(JSON.stringify({ ok: true, verified: false }));
          return 0;
        }
        deps.log(JSON.stringify({ ok: true, dispatch: check.name }));
        return 0;
      }
      case 'check-repo': {
        const { roster } = readRosterChecked(deps.boardDir);
        const project = rosterProject(roster.sessions);
        if (!project.ok) {
          process.stderr.write(`cli-hierarchy check-repo: ${project.reason}\n`);
          return 1;
        }
        const check = checkRepoMatch({
          cwd: deps.cwd,
          boardDir: deps.boardDir,
          project: project.project,
          ...(extras.repoGit ? { git: extras.repoGit } : {}),
        });
        if (!check.ok) {
          process.stderr.write(`cli-hierarchy check-repo: ${check.reason}\n`);
          return 1;
        }
        deps.log(JSON.stringify({ ok: true, project: check.project }));
        return 0;
      }
      case 'handoff': {
        const action = firstPositional(argv);
        const role = parseRoleFlag(flags.role);
        if ((action !== 'write' && action !== 'read') || !role) {
          process.stderr.write(
            `cli-hierarchy handoff: use 'handoff write|read --role planner|operator-dispatch|executor'\n`,
          );
          return 2;
        }
        const caller = resolveCaller(
          extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
        );
        const name =
          flags.name && flags.name !== 'true'
            ? flags.name
            : caller?.role === role
              ? caller.name
              : undefined;
        const opts = {
          role,
          boardDir: deps.boardDir,
          now: deps.now,
          ...(name ? { name } : {}),
          ...(flags.out && flags.out !== 'true' ? { file: flags.out } : {}),
        };
        if (action === 'write') {
          const r = writeHandoff(opts);
          deps.log(JSON.stringify({ ok: true, file: r.file, stateHash: r.stateHash }));
        } else {
          const r = readGeneratedHandoff(opts);
          deps.log(r.content.trimEnd());
          process.stderr.write(
            `cli-hierarchy handoff: ${r.file}${r.regenerated ? ' (was missing or stale; regenerated from live state)' : ''}\n`,
          );
        }
        return 0;
      }
      case 'auto-clear': {
        const transcript = flags.transcript;
        if (!transcript || transcript === 'true') {
          process.stderr.write('cli-hierarchy auto-clear: --transcript is required\n');
          return 2;
        }
        const self = resolveCaller(
          extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
        );
        if (!self) {
          deps.log(JSON.stringify({ action: 'none', reason: 'not a hierarchy session' }));
          return 0;
        }
        const role = self.role as HierarchyRole;
        const decision = decideAutoClear({
          boardDir: deps.boardDir,
          role,
          name: self.name,
          transcriptPath: transcript,
          now: deps.now,
        });
        if (decision.action !== 'clear') {
          deps.log(JSON.stringify(decision));
          return 0;
        }
        const handoff = writeHandoff({
          role,
          name: self.name,
          boardDir: deps.boardDir,
          now: deps.now,
        });
        const result = clearSelf(
          {
            self: self.name,
            role,
            ...(deps.env.TMUX_PANE ? { callerPane: deps.env.TMUX_PANE } : {}),
          },
          { run: deps.run, boardDir: deps.boardDir, log: deps.log },
        );
        deps.log(JSON.stringify({ ...decision, handoff: handoff.file, scheduled: result }));
        return 0;
      }
      case 'route-decision': {
        const caller = dispatchCaller('route-decision');
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        const route = flags.route;
        const decisionId = flags['decision-id'];
        const to = flags.to;
        if (!decisionId || decisionId === 'true' || !to || to === 'true') {
          process.stderr.write(
            'cli-hierarchy route-decision: --decision-id and --to are required\n',
          );
          return 2;
        }
        if (!DECISION_ID_RE.test(decisionId)) {
          process.stderr.write(
            'cli-hierarchy route-decision: --decision-id must look like DEC-0000\n',
          );
          return 2;
        }
        if (flags['task-id'] !== undefined && !TASK_ID_RE.test(flags['task-id'])) {
          process.stderr.write('cli-hierarchy route-decision: --task-id is not a valid task id\n');
          return 2;
        }
        if (!SAFE_SESSION_NAME.test(to)) {
          process.stderr.write('cli-hierarchy route-decision: --to is not a valid session name\n');
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
          workerId: caller.name,
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
