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
 *   - `stall-notice [--minutes <n>]` — one notification and one digest line when queued work has
 *     not moved for n minutes (default 45); never relaunches or messages a session.
 *   - `attach <name>` — show one agent in this terminal (`switch-client` inside
 *     tmux, `attach-session` outside).
 *   - `terminals --vscode [--out <dir>] [--force] [--print]` — generate a VS Code
 *     `tasks.json` that opens one terminal per agent.
 *   - `brief --tasks <id,...> | --rfc <RFC-NNNN> [--out <path>] [--force] [--notify]` —
 *     write a dispatch brief from task metadata and optionally tell the dispatch
 *     session about it.
 *   - `down [--role <name-or-role>]` — end sessions, return their inflight
 *     manifests to `queue/`, close their windows, update the roster.
 *   - `restart <executor> [--after-task] [--wait <sec>]` — stop and start one executor and
 *     replace its roster entry; refuses while it holds a task unless `--after-task`.
 *   - `register <executor>` — re-record an executor restarted by hand under a new pid, after
 *     checking its tmux pane and process.
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
 *   - `playbook --task <id> --action <step>` — run one named playbook step (AISDLC-918).
 *   - `route-decision --decision-id <id> --route operational|design --to <name>`
 *     — record that a decision was routed to a tier.
 *
 * All subcommands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`).
 *
 * `clear`, `tick`, `restart`, `register`, `playbook` and `route-decision` are dispatch-session commands. A mistake
 * guard keeps other sessions from running them by accident: it finds the calling
 * session from the process tree and the roster and refuses unless that is the running
 * dispatch session. A `--worker` value is only compared with that result. The guard is
 * not authentication; a session running as the same user can defeat it.
 */

import { parseQuota, parseQuotaFloor } from '../hierarchy/gh-calls.js';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { promoteExpiredDecisions } from '../decisions/escalation-chain.js';
import { isDecisionCatalogEnabled } from '../decisions/feature-flag.js';
import { persistDecisionLog } from '../decisions/remote-persist.js';
import { collectVerdicts, DEFAULT_BOARD_DIR, TASK_ID_RE } from '../dispatch/board.js';
import { sanitizeVerdict } from '../dispatch/verdict-fields.js';
import { enqueueTasks, type EnqueueEntry } from '../dispatch/enqueue.js';
import { requeueFailed } from '../dispatch/requeue.js';
import { reenter } from '../hierarchy/reenter.js';
import { correctManifestBranch } from '../dispatch/resume.js';
import { DEFAULT_REQUEUE_RETRY_LIMIT } from '../dispatch/session-reaper.js';
import { DECISION_ID_RE } from '../dispatch/verdict-fields.js';
import { resolveGovernanceFromYaml } from '../governance/merge-if-eligible.js';
import {
  attachTmuxSession,
  checkDispatchCaller,
  checkOwnWorktreeForOperator,
  clearExecutor,
  clearSelf,
  clearWarned,
  decideAutoClear,
  boundedHandoffView,
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
  hierarchyRegister,
  hierarchyRestart,
  hierarchyStatus,
  hierarchyTerminals,
  hierarchyUp,
  loadOperationalPolicy,
  markReadyAfterCodeql,
  repoHasCodeql,
  createLander,
  landEligiblePrs,
  readMergeAuthors,
  type LandReport,
  checkDispatchSender,
  checkRepoMatch,
  readRosterChecked,
  rosterProject,
  readParentHead,
  runDispatchTick,
  endsWithQuestion,
  clearHold,
  writeHold,
  findOpenPrNumber,
  paneTail,
  fetchHumanAttentionPrs,
  stallThresholdsFromEnv,
  runPlaybook,
  NAMED_STEPS,
  type PlaybookDeps,
  runStallNotice,
  DEFAULT_STALL_NOTICE_MINUTES,
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
  webhookDown,
  webhookServe,
  webhookUp,
  webhookStatus,
  formatWebhookStatus,
} from '../hierarchy/index.js';
import { loadPrLifecycleConfig } from '../hierarchy/pr-lifecycle-config.js';
import { createSnapshotRunner } from '../hierarchy/pr-snapshot.js';
import { routedModel } from '../routing/role-model.js';
import { findTaskFile, parseArgv, resolveBaseSha } from './dispatch.js';

/** Dispatch holds its resume this long (upper bound; a new board file wakes it sooner). */
const DISPATCH_RESUME_HOLD_SECONDS = 60;

const USAGE = `Usage: cli-hierarchy <command> [options]

Commands:
  up         Start the planner, dispatch session and executors, one tmux session each
  status     Show the roster with live state, attached clients and inflight tasks
  attach     Show one agent in this terminal: attach <name>
  terminals  Generate editor terminal tasks, one per agent (terminals --vscode)
  brief      Generate a dispatch brief (waves, sequence groups) from task metadata
  down       Stop sessions and return their inflight manifests to the queue
  clear      Empty an executor's context between tasks and restart its loop
  restart    Stop and start one executor, updating its roster entry (restart <executor>)
  register   Re-record an executor whose process was restarted by hand (register <executor>)
  stall-notice  Alert once when queued work has not moved for N minutes (no relaunch, no model)
  webhook    Local GitHub webhook receiver: webhook up|down|status (needs AI_SDLC_WEBHOOK_SECRET)
  hold       Pause claims and relaunches, never reporting (--reason <text>); planner or operator only
  resume     Lift the hold set by hold
  tick       One wake-up of the dispatch loop (ingest, verdict watch, playbook, reports)
  route-decision  Record that a decision was routed to a tier
  playbook   Run one named playbook step for one task (playbook --task <id> --action <step>)
  handoff         Write or read a session's handoff file (handoff write|read --role <r>)
  auto-clear      Clear this session when its context is over the role threshold (Stop hook)
  executor-start  Executor identity, repository check and a blocking claim, as one call
  check-sender    Exit 0 only when a message sender is this roster's dispatch session
  check-repo      Exit 0 only when the working directory is this roster's repository

Options for up:
  --executors <n>          Number of executors, 0 to 5 (default 5)
  --planner-model <m>      Planner model (default: the planner cell of model-routing.yaml)
  --dispatch-model <m>     Dispatch model (default sonnet)
  --executor-model <m>     Executor model (default sonnet)
  --no-planner             Do not start a planner
  --project <name>         Project the session names are qualified with: <project>-<role>
                           (default the repository basename). Needed, with a distinct
                           value, when sessions with the same role names already run
                           for another project on this machine.
  --attach                 Show the planner (or the dispatch session) when done
  --rebuild                In the ai-sdlc monorepo, rebuild a stale or missing pipeline-cli
                           build before launching (otherwise up refuses and prints the
                           command: pnpm --filter @ai-sdlc/pipeline-cli build)
  --no-vscode-tasks        Do not regenerate .vscode/tasks.json. By default up rewrites it
                           when it starts a session or the roster changes, but only if the
                           file is absent or carries the "ai-sdlc" generated marker; inside
                           a VS Code terminal it ends by naming the task to run
  --planner-permission-mode <m>
                           Planner permission mode (default bypassPermissions, like the
                           other sessions); pass default for a prompting planner
  --allow-planner-bypass   Deprecated, no effect: every session starts in bypassPermissions
  --node <version>         Node version every session runs under, activated through nvm
                           (default the version in .nvmrc; refuses when it is not installed)

Options for status:
  --json                   Print machine-readable output

Options for stall-notice:
  --minutes <n>            Minutes without a verdict or heartbeat before alerting (default 45)

Options for webhook:
  --port <n>               Local port, bound to 127.0.0.1 (default 8765, or AI_SDLC_WEBHOOK_PORT)

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
  /clear after 20 s (waiting for an idle pane, input line emptied first) and then, once the
  pane is idle again (or --resume-after seconds later, or sooner when a new brief or verdict
  file lands on the board, for dispatch), the resume command: /ai-sdlc operator-dispatch
  for the dispatch session, /ai-sdlc:planner for the planner, /ai-sdlc executor for an idle
  executor (which is refused while it holds an inflight task). Refuses without TMUX_PANE.
  Sends /clear to the executor's pane, waits for the settle time (default 8000 ms),
  then sends /ai-sdlc executor. Refuses an executor that holds an inflight task.
  clear <executor-name> is for the dispatch session only. A mistake guard refuses any other caller, a human
  at a plain shell included; it is not authentication and a same-user session can defeat
  it. Outside the hierarchy, use tmux directly.

Usage for restart and register (dispatch session only, executors only):
  cli-hierarchy restart <executor> [--after-task] [--wait <seconds>]
  cli-hierarchy register <executor>
  restart stops the named executor and starts it again with its recorded model and mode,
  then replaces only its roster entry (pid, pane, started time); other sessions are not touched.
  It refuses while the executor holds a claimed task unless --after-task is given, which waits
  (up to --wait seconds, default 1500) for the task boundary first.
  register re-records an executor that is already running under a new pid, after checking
  its tmux pane, the ownership marker, the pane's launch environment and a live harness session.
  A mistake guard refuses any caller but the dispatch session; it is not authentication.

Options for hold:
  --reason <text>          Why the board is held (required); shown by tick and executor-start

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
                           session, the working directory is not the project's repository, or
                           the sender is not the dispatch session. It runs the repository and
                           sender checks itself (AISDLC-764); the sender is checked from
                           --sender-pid / --sender-ref (accepts with a loud UNCHECKED START warning when neither).
  --sender-pid <n>, --sender-ref <ref>   as for check-sender

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
  --no-archive             write (planner): do not roll older notes blocks into <basename>_archive.md
  --full                   read: print the whole file (default: block plus last 8000 chars of prose)

Options for auto-clear:
  --transcript <path>      Session transcript whose usage fields give the context size
                           Thresholds: planner 150000, dispatch 120000, executor 120000 tokens;
                           override with contextThresholds in <board-dir>/config.json

Options for playbook:
  --task <id>              Task whose failure record the step is run for
  --action <step>          rebase-push, retrigger-ci or requeue; refused when the role lacks the grant
  --worker <name>          Optional; when given it must equal the calling session's own roster name

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
    /** Replaces the detached process that types the self-clear keystrokes (tests). */
    spawnDetached?: (file: string, args: readonly string[]) => void;
    /** Replaces the board enqueue (tests). */
    enqueue?: (entries: EnqueueEntry[]) => string[];
    /** Replaces the `gh` runner the mark-ready pass uses (tests). */
    ghRun?: CommandRunner;
    /** Replaces the landing pass of the `land-eligible-prs` action (tests). */
    landEligible?: () => Promise<LandReport>;
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

  /** Policy, runners and playbook dependencies shared by `tick` and `playbook`. */
  const playbookSetup = (repoRoot: string, worker: string) => {
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
    const playbookDeps = (retryLimit: number | undefined): PlaybookDeps => ({
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
      correctBranch: (id, b) => void correctManifestBranch(deps.boardDir, id, b),
    });
    return { operational, emit, playbookDeps };
  };

  try {
    switch (subcommand) {
      case 'up': {
        const result = await hierarchyUp(
          {
            executors: flags.executors ?? '5',
            plannerModel: flags['planner-model'] ?? routedModel('planner'),
            dispatchModel: flags['dispatch-model'] ?? 'sonnet',
            executorModel: flags['executor-model'] ?? 'sonnet',
            noPlanner: flags['no-planner'] === 'true',
            attach: flags.attach === 'true',
            ...(flags.project === undefined
              ? {}
              : { project: flags.project === 'true' ? '' : flags.project }),
            ...(flags['planner-permission-mode'] === undefined
              ? {}
              : { plannerPermissionMode: flags['planner-permission-mode'] }),
            allowPlannerBypass: flags['allow-planner-bypass'] === 'true',
            ...(flags.node === undefined ? {} : { node: flags.node === 'true' ? '' : flags.node }),
            vscodeTasks: flags['no-vscode-tasks'] !== 'true',
            rebuild: flags.rebuild === 'true',
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
      case 'stall-notice': {
        const minutes = intFlag(flags, 'minutes');
        if (minutes === null) return 2;
        if (minutes !== undefined && minutes < 1) {
          process.stderr.write('cli-hierarchy: --minutes must be at least 1\n');
          return 2;
        }
        deps.log(
          JSON.stringify(
            runStallNotice({
              boardDir: deps.boardDir,
              now: deps.now,
              run: deps.run,
              minutes: minutes ?? DEFAULT_STALL_NOTICE_MINUTES,
            }),
          ),
        );
        return 0;
      }
      case 'webhook': {
        const action = firstPositional(argv);
        if (action === 'up') webhookUp(deps, flags.port);
        else if (action === 'down') webhookDown(deps);
        else if (action === 'status') {
          const w = webhookStatus(deps);
          deps.log(flags.json === 'true' ? JSON.stringify(w) : formatWebhookStatus(w));
        } else if (action === 'serve') await webhookServe(deps, flags.port);
        else {
          process.stderr.write(`cli-hierarchy: webhook needs up, down or status\n\n${USAGE}`);
          return 2;
        }
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
              resumeAfterSeconds: resumeAfter ?? DISPATCH_RESUME_HOLD_SECONDS,
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
      case 'restart':
      case 'register': {
        const caller = dispatchCaller(subcommand);
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        // `--after-task executor-beta` reads the name as the flag's value.
        const afterTask = flags['after-task'];
        const session =
          firstPositional(argv) ??
          (afterTask !== undefined && afterTask !== 'true' ? afterTask : undefined);
        if (!session) {
          process.stderr.write(`cli-hierarchy ${subcommand}: an executor name is required\n`);
          return 2;
        }
        if (subcommand === 'register') {
          deps.log(JSON.stringify(hierarchyRegister({ session }, deps)));
          return 0;
        }
        const waitSec = intFlag(flags, 'wait');
        if (waitSec === null) return 2;
        const result = await hierarchyRestart(
          {
            session,
            afterTask: afterTask !== undefined,
            ...(waitSec === undefined ? {} : { waitSec }),
          },
          deps,
        );
        deps.log(JSON.stringify(result));
        return 0;
      }
      case 'hold':
      case 'resume': {
        // The planner (or a human at a shell, who is no roster session) pauses the drain;
        // dispatch and executors never do.
        const who = resolveCaller(
          extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
        );
        if (who && who.role !== 'planner') {
          process.stderr.write(
            `cli-hierarchy ${subcommand}: only the planner or the operator may ${subcommand} the board; this session is '${who.name}' (${who.role}). Message the planner instead.\n`,
          );
          return 1;
        }
        const by = who?.name ?? 'unresolved';
        if (subcommand === 'hold') {
          const reason = flags.reason;
          if (!reason || reason === 'true') {
            process.stderr.write('cli-hierarchy hold: --reason <text> is required\n');
            return 2;
          }
          writeHold(deps.boardDir, { reason, since: deps.now().toISOString(), by });
          deps.log(JSON.stringify({ ok: true, held: { reason, by } }));
        } else {
          const lifted = clearHold(deps.boardDir, by, deps.now().toISOString());
          deps.log(JSON.stringify({ ok: true, resumed: lifted !== null }));
        }
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
        const { operational, emit, playbookDeps } = playbookSetup(repoRoot, worker);
        // One PR snapshot per wake, shared by every consumer below (AISDLC-959).
        const wakeGh = createSnapshotRunner(extras.ghRun ?? deps.run, { boardDir: deps.boardDir });
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
                workDir: repoRoot,
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
          playbook: (verdict) => runPlaybook(verdict, playbookDeps(retryLimit)),
          operational,
          stall: {
            ...stallThresholdsFromEnv(deps.env, loadPrLifecycleConfig(deps.cwd).stall),
            liveness: () =>
              new Map(hierarchyStatus(deps).rows.map((r) => [r.entry.name, r.state] as const)),
            lastOutputIsQuestion: (name) => {
              const entry = readRosterChecked(deps.boardDir).roster.sessions.find(
                (e) => e.name === name,
              );
              return (
                entry !== undefined &&
                endsWithQuestion(paneTail(deps.run, entry.tmuxSession, entry.tmuxWindow))
              );
            },
            requeue: (id, note, pr) => {
              if (pr === undefined) {
                void requeueFailed(
                  deps.boardDir,
                  id,
                  retryLimit === undefined ? {} : { retryLimit },
                );
                return;
              }
              void reenter(
                { target: String(pr), note },
                {
                  boardDir: deps.boardDir,
                  run: extras.ghRun ?? deps.run,
                  cwd: repoRoot,
                  reenteredBy: worker,
                  resolveBaseSha: () => resolveBaseSha(repoRoot),
                  resolveTaskFile: (tid) => findTaskFile(repoRoot, tid),
                },
              );
            },
            findPr: (id) => findOpenPrNumber(extras.ghRun ?? deps.run, repoRoot, id),
          },
          parentHead: () => readParentHead(repoRoot),
          quota: () => {
            const r = (extras.ghRun ?? deps.run)('gh', ['api', 'rate_limit'], { cwd: repoRoot });
            return r?.status === 0 ? parseQuota(r.stdout) : undefined;
          },
          quotaFloor: parseQuotaFloor(process.env.AI_SDLC_GH_QUOTA_FLOOR),
          listPrs: () => fetchHumanAttentionPrs(wakeGh, repoRoot, deps.boardDir),
          markReady: () =>
            markReadyAfterCodeql(wakeGh, repoRoot, {
              hasCodeql: repoHasCodeql(repoRoot),
            }),
          landEligible:
            extras.landEligible ??
            (() =>
              landEligiblePrs({
                boardDir: deps.boardDir,
                repoRoot,
                run: wakeGh,
                mergeAuthors: readMergeAuthors(
                  repoRoot,
                  (y) => resolveGovernanceFromYaml(y).mergeAuthors,
                ),
                land: createLander({ repoRoot }),
              })),
          promoteExpired: () =>
            isDecisionCatalogEnabled()
              ? promoteExpiredDecisions(
                  () => ({
                    boardDir: deps.boardDir,
                    identity: extras.identity ?? createSystemIdentity(deps.boardDir),
                    sessions: () => readRosterChecked(deps.boardDir).roster.sessions,
                    send: extras.sendBrief ?? createTmuxBriefSender(deps.run),
                    emit,
                  }),
                  { workDir: repoRoot, persist: () => persistDecisionLog({ workDir: repoRoot }) },
                )
              : [],
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
        const startPid = intFlag(flags, 'sender-pid');
        if (waitSec === null || startPid === null) return 2;
        const startRef = flags['sender-ref'] === 'true' ? undefined : flags['sender-ref'];
        try {
          const result = await executorStart(
            {
              boardDir: deps.boardDir,
              cwd: deps.cwd,
              ...(startPid === undefined ? {} : { senderPid: startPid }),
              ...(startRef === undefined ? {} : { senderRef: startRef }),
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
          ...(flags['no-archive'] === 'true' ? { archive: false } : {}),
        };
        if (action === 'write') {
          const r = writeHandoff(opts);
          deps.log(
            JSON.stringify({
              ok: true,
              file: r.file,
              stateHash: r.stateHash,
              ...(r.archivedBlocks === undefined
                ? {}
                : { archivedBlocks: r.archivedBlocks, archiveFile: r.archiveFile }),
            }),
          );
        } else {
          const r = readGeneratedHandoff(opts);
          deps.log(
            argv.includes('--full')
              ? `${r.content.trimEnd()}\n\n${r.file}`
              : boundedHandoffView(r.content, r.file),
          );
          if (r.regenerated) {
            process.stderr.write(
              `cli-hierarchy handoff: ${r.file} (was missing or stale; regenerated from live state)\n`,
            );
          }
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
          {
            run: deps.run,
            boardDir: deps.boardDir,
            log: deps.log,
            ...(extras.spawnDetached ? { spawnDetached: extras.spawnDetached } : {}),
          },
        );
        clearWarned(deps.boardDir, self.name);
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
      case 'playbook': {
        const caller = dispatchCaller('playbook');
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        const taskId = flags['task'];
        const action = flags['action'];
        if (!taskId || !TASK_ID_RE.test(taskId)) {
          process.stderr.write('cli-hierarchy playbook: --task <task-id> is required\n');
          return 2;
        }
        if (!NAMED_STEPS.includes(action as (typeof NAMED_STEPS)[number])) {
          process.stderr.write(
            `cli-hierarchy playbook: --action must be one of ${NAMED_STEPS.join(', ')}\n`,
          );
          return 2;
        }
        const step = action as (typeof NAMED_STEPS)[number];
        const failure = collectVerdicts(deps.boardDir)
          .filter((v) => v.taskId === taskId && v.outcome !== 'success')
          .at(-1);
        if (!failure) {
          process.stderr.write(
            `cli-hierarchy playbook: ${taskId} has no failure record on the board\n`,
          );
          return 1;
        }
        const repoRoot = path.resolve(flags['work-dir'] ?? deps.cwd);
        const { playbookDeps } = playbookSetup(repoRoot, caller.name);
        const outcome = await runPlaybook(
          sanitizeVerdict(failure).verdict,
          playbookDeps(undefined),
          step,
        );
        deps.log(JSON.stringify({ ok: outcome.result === 'done', outcome }));
        return outcome.result === 'done' ? 0 : 1;
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
