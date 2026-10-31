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
 *   - `brief-status` — print each brief on the board with its done and total task counts.
 *   - `down [--role <name-or-role>]` — end sessions, return their inflight
 *     manifests to `queue/`, close their windows, update the roster.
 *   - `restart <name>|--all [--after-task] [--wait <sec>]` — stop and start one session (an
 *     executor, dispatch or the planner) or dispatch plus every executor, replacing its roster
 *     entry; an executor holding a task is refused unless `--after-task`.
 *   - `register <executor>` — re-record an executor restarted by hand under a new pid, after
 *     checking its tmux pane and process.
 *   - `executor-start` — an executor's identity, repository check and one claim
 *     in one call; prints `{taskId|null, ...}`.
 *   - `clear <name> [--settle-ms <n>]` — dispatch drives the executor's pane (/clear, then the
 *     executor command), falling back to restart; no request file, no acknowledgement. Reports the
 *     acknowledgement or a named refusal. Types nothing. Refuses an executor that holds
 *     an inflight task.
 *   - `tick [--worker <dispatch-name>] [--report-every-ms <n>] [--settle-ms <n>]
 *     [--retry-limit <n>] [--work-dir <path>]` — one wake-up of the dispatch
 *     loop: ingest briefs, handle new verdicts (clear, unblocking playbook),
 *     and print the escalations and reports to send, as JSON.
 *   - `check-repo` — exit 0 only when the working directory is in the repository that
 *     owns this roster's board; otherwise print why and exit 1.
 *   - `handoff write|read --role <planner|operator-dispatch|executor> [--name <n>]` — write
 *     (from board and catalog state) or read (regenerating when stale) a session's handoff file.
 *   - `send --to <name> --text <message>` — message a roster session; refused with the reason when
 *     `to` is not listed in this project's roster (AISDLC-1036).
 *   - `playbook --task <id> --action <step>` — run one named playbook step (AISDLC-918).
 *   - `route-decision --decision-id <id> --route operational|design --to <name>`
 *     — record that a decision was routed to a tier.
 *
 * All subcommands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`).
 *
 * `clear`, `tick`, `restart`, `register`, `playbook` and `route-decision` are dispatch-session commands
 * (`restart` also accepts the planner). A mistake
 * guard keeps other sessions from running them by accident: it finds the calling
 * session from the process tree and the roster and refuses unless that is the running
 * dispatch session. A `--worker` value is only compared with that result. The guard is
 * not authentication; a session running as the same user can defeat it.
 */

import { fetchClosedUnmergedPrs } from '../kpi/closed-unmerged.js';
import { parseQuota, parseQuotaFloor } from '../hierarchy/gh-calls.js';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotfixTaskId, hotfixTaskMarkdown } from '../hierarchy/canary.js';
import { runLoopCanaryCommand } from '../hierarchy/loop-canary-run.js';
import { markCanaryDue } from '../hierarchy/loop-canary.js';
import process from 'node:process';

import { promoteExpiredDecisions } from '../decisions/escalation-chain.js';
import { isDecisionCatalogEnabled } from '../decisions/feature-flag.js';
import { persistDecisionLog } from '../decisions/remote-persist.js';
import {
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  peekQueueOrder,
  TASK_ID_RE,
} from '../dispatch/board.js';
import { sanitizeVerdict } from '../dispatch/verdict-fields.js';
import { enqueueTasks, type EnqueueEntry } from '../dispatch/enqueue.js';
import { requeueFailed } from '../dispatch/requeue.js';
import { reenter } from '../hierarchy/reenter.js';
import { now as clockNow } from '../clock.js';
import { runDemo, type DemoDeps } from '../hierarchy/demo.js';
import { writeEscalationFile } from '../hierarchy/escalation-file.js';
import { correctManifestBranch } from '../dispatch/resume.js';
import { DEFAULT_REQUEUE_RETRY_LIMIT } from '../dispatch/session-reaper.js';
import { DECISION_ID_RE } from '../dispatch/verdict-fields.js';
import { resolveGovernanceFromYaml } from '../governance/merge-if-eligible.js';
import {
  attachTmuxSession,
  checkDispatchCaller,
  checkOwnWorktreeForOperator,
  clearExecutor,
  boundedHandoffView,
  readHandoff as readGeneratedHandoff,
  writeHandoff,
  noteLedger,
  createGitRunner,
  createStreamEmitter,
  createSystemIdentity,
  executorStart,
  hierarchySpawn,
  reapOrphanExecutorSessions,
  resolveCaller,
  createSystemRunner,
  createTmuxBriefSender,
  generateBrief,
  briefStatus,
  formatBriefStatus,
  notifyDispatch,
  type BriefSender,
  formatStatus,
  hierarchyAttach,
  hierarchyDown,
  hierarchyRegister,
  hierarchyRestart,
  hierarchyRestartAll,
  writeRestartRequest,
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
  checkRepoMatch,
  readRosterChecked,
  readReceivedAddresses,
  sendToRoster,
  type SocketSender,
  rosterProject,
  readParentHead,
  runDispatchTick,
  hostTickStale,
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
  managedSettingsFile,
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
  recallTranscript,
  resolveTranscriptSource,
} from '../hierarchy/index.js';
import { loadPrLifecycleConfig } from '../hierarchy/pr-lifecycle-config.js';
import { createSnapshotRunner } from '../hierarchy/pr-snapshot.js';
import { routedModel } from '../routing/role-model.js';
import { defaultRunner } from '../runtime/exec.js';
import { runParentUpkeep, type ParentUpkeepResult } from '../steps/00-parent-upkeep.js';
import { resolvePluginScriptsDir } from './next-step.js';
import {
  fileTurnBudgetDecision,
  hasOpenTurnBudgetDecision,
  loadDispatchTicks,
  reviewTurnBudget,
  type TurnBudgetDeps,
} from '../hierarchy/turn-budget.js';
import { resolveArtifactsDir } from '../routing/artifacts-dir.js';
import { loadUsageConfig } from '../usage/usage-config.js';
import { findTaskFile, parseArgv, resolveBaseSha } from './dispatch.js';
import { DEFAULT_HARNESS_BINARY } from '../harness-defaults.js';

const USAGE = `Usage: cli-hierarchy <command> [options]

Commands:
  up         Start the planner and dispatch session (no executors by default), one tmux session each
  status     Show the roster with live state, attached clients and inflight tasks
  attach     Show one agent in this terminal: attach <name>
  terminals  Generate editor terminal tasks, one per agent (terminals --vscode)
  brief      Generate a dispatch brief (waves, sequence groups) from task metadata
  brief-status  Show each brief's done and total task counts
  down       Stop sessions and return their inflight manifests to the queue
  clear      Empty an executor's context between tasks and restart its loop
  restart    Stop and start one session or all of them, updating the roster (restart <name>|--all)
  register   Re-record an executor whose process was restarted by hand (register <executor>)
  stall-notice  Alert once when queued work has not moved for N minutes (no relaunch, no model)
  webhook    Local GitHub webhook receiver: webhook up|down|status (needs AI_SDLC_WEBHOOK_SECRET)
  hold       Pause claims and relaunches, never reporting (--reason <text>); planner or operator only
  resume     Lift the hold set by hold
  canary     Drive a synthetic task through claim, verdict, clear and re-claim: canary run --no-pr
  tick       One wake-up of the dispatch loop (ingest, verdict watch, playbook, reports)
  escalation-file  Write a board file for the planner: failure record, log tail, PR check summary
  route-decision  Record that a decision was routed to a tier
  demo       Regenerate the terminal demo clip from a scenario: demo [run|cut|render]
  playbook   Run one named playbook step for one task (playbook --task <id> --action <step>)
  handoff         Write or read a session's handoff file (handoff write|read --role <r>)
  transcript      Digest of the turns before a /clear (transcript recall --role <r>)
  send            Message a session listed in this project's roster; refuses any other name
  spawn           Start one ephemeral executor session for one task (spawn <task-id> [--model <m>])
  executor-start  Executor identity, repository check and a blocking claim, as one call
  check-repo      Exit 0 only when the working directory is this roster's repository

Options for up:
  --executors <n>          Deprecated: standing executors, 0 to 5 (default 0); dispatch spawns one per task
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
  --no-module-check        Skip the final check that the dispatch host's hooks module reports
                           loaded within 60 seconds (otherwise up exits 1 when it does not)
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
  cli-hierarchy clear <name> [--settle-ms <n>]
  Empties an idle executor's context from the dispatch side (AISDLC-1107): waits for the pane's
  prompt, types /clear, waits for the fresh prompt, types /ai-sdlc:executor. No message goes to the
  executor model and no request file exists. When the pane shows no fresh prompt within the ceiling
  the command falls back to restart (kill and relaunch). Refusals: unknown or stopped session, a
  session that is not an executor, an executor that holds an inflight task, a tmux session
  cli-hierarchy did not start.

Usage for restart and register (dispatch or planner session for restart; dispatch only for register):
  cli-hierarchy restart <name> [--after-task] [--wait <seconds>]
  cli-hierarchy restart --all [--wait <seconds>]
  cli-hierarchy register <executor>
  restart stops the named session (an executor, operator-dispatch or planner) and starts it
  again with its recorded model, mode and env, then replaces only its roster entry (pid, pane,
  started time); other sessions are not touched and inflight manifests stay on the board.
  Restarting dispatch re-registers the reconcile scheduler and the webhook receiver.
  An executor that holds a claimed task is refused unless --after-task is given, which waits
  (up to --wait seconds, default 1500) for the task boundary first.
  --all restarts dispatch and every idle executor now, and each busy executor at its task
  boundary, as --after-task does; the planner is left alone.
  register re-records an executor that is already running under a new pid, after checking
  its tmux pane, the ownership marker, the pane's launch environment and a live harness session.
  A mistake guard refuses any other caller (executors never); it is not authentication.

Options for demo:
  run | cut | render       One stage; with none, all three in order, stopping at the first failure
  --scenario <file>        run: the scenario JSON (request, task, decisions, brief, timeoutMinutes, pollSeconds)
  --out <dir>              run and render: output directory; cut: the cut cast file
  --cast <file>            cut and render: the cast to read
  --beats <file>           cut: the beats file written by run

Options for hold:
  --reason <text>          Why the board is held (required); shown by tick and executor-start

Options for tick:
  --worker <name>          Optional; when given it must equal the calling session's own roster name
  --report-every-ms <n>    Spacing of progress reports (default 900000)
  --settle-ms <n>          Ceiling for each wait for the pane prompt (default 30000, config clear.handshakeCeilingMs)
  --retry-limit <n>        Re-queues allowed per failed task (default 2; a larger value is refused)
  --work-dir <path>        Repository root (default the current directory)
  --by scheduler           Used by the watch scheduler: ticks only when the host missed three intervals

Options for spawn:
  <task-id>                Task the executor serves; its session is ai-sdlc-executor-<task-id-lowercase>.
                           A live session of that name is reported and nothing is created.
  --model <m>              Executor model (default sonnet)

Options for executor-start:
  --wait <sec>             Refused (exit 1) under AI_SDLC_EXECUTOR_TASK, which claims only that task
                           and exits 1 with the reason when it is not claimable. Also refused when
                           this session has no hooks-module heartbeat; a repeat
                           call within 60 s with no new enqueue returns {"taskId":null,"repeat":true}.
  (none)                   Prints the identity line, then one JSON line: {name, project, dispatch,
                           taskId|null, manifest?}. Claims once and does not wait: the hierarchy
                           hooks module wakes an idle executor. Exit 1 when this is not an executor
                           session or the working directory is not the project's repository.

Options for handoff:
  write | read             write regenerates the file from board and catalog state; read
                           returns it, regenerating first when it is missing or stale
  --role <r>               planner, operator-dispatch (or dispatch), or executor
  --name <n>               Session name (default the calling session's roster name, else the role)
  --out <path>             Alternative file location
  --no-archive             write (planner): do not roll older notes blocks into <basename>_archive.md
  note                     append one outward action to the role's ledger (AISDLC-1049):
                           --kind filed|commented|opened|closed|sent --url <url> [--summary <text>]
  --full                   read: print the whole file (default: block plus last 8000 chars of prose)

Options for transcript:
  recall                   Print a text digest (U/A/T/E lines) of the turns before the last /clear
  --role <r>               planner, operator-dispatch (or dispatch), or executor
  --since-clear            Window between the previous two clear markers (default)
  --last-turns <n>         The last n turns instead
  --file <path>            An archived copy under .claude/transcripts/ (whole file)
  --max-chars <n>          Output cap (default 12000); the oldest lines are dropped first

Options for send:
  --to <name>              Roster session name, as printed by status (refused when not listed)
  --text <message>         One line to type into that session; plain text, no newline

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
/** `resolveBaseSha` without git's stderr: the canary step reports a missing base itself. */
function quietBaseSha(workDir: string): string {
  for (const ref of ['origin/main', 'HEAD']) {
    const r = spawnSync('git', ['rev-parse', ref], { cwd: workDir, encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('cannot resolve a base commit');
}

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
      managedSettingsFile(),
    ],
    userSettingsFile: path.join(configDir, 'settings.json'),
    resources: () => systemResourceSnapshot(run),
    env: process.env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => process.stdout.write(line + '\n'),
    attach: attachTmuxSession,
    claudeBin: DEFAULT_HARNESS_BINARY,
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

/** The system-backed dependencies of `cli-hierarchy demo` (AISDLC-1079). */
function createDemoDeps(deps: HierarchyDeps, overrides: Partial<DemoDeps> = {}): DemoDeps {
  const run = createSystemRunner();
  const binDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const err = (line: string): void => void process.stderr.write(`${line}\n`);
  return {
    run,
    out,
    err,
    now: () => clockNow().getTime(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    which: (tool) =>
      (process.env['PATH'] ?? '').split(path.delimiter).some((dir) => {
        try {
          accessSync(path.join(dir, tool), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    idleExecutors: () =>
      hierarchyStatus(deps).rows.filter((r) => r.entry.role === 'executor' && r.state === 'idle')
        .length,
    taskState: (taskId) => {
      const file = findTaskFile(deps.cwd, taskId);
      if (!file) return null;
      const head = readFileSync(path.join(deps.cwd, file), 'utf-8').split('\n---')[0] ?? '';
      return {
        status: /^status:\s*(.+?)\s*$/m.exec(head)?.[1]?.replace(/^['"]|['"]$/g, '') ?? '',
        dispatchable: !/^dispatchable:\s*false\s*$/m.test(head),
      };
    },
    cleanCheckout: (ignore) => {
      const args = ['status', '--porcelain', '--untracked-files=all'];
      if (ignore) {
        const rel = path.relative(deps.cwd, path.resolve(deps.cwd, ignore));
        // A demo output directory inside the checkout must not dirty it on rerun.
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          args.push('--', '.', `:(exclude)${rel}`);
        }
      }
      return run('git', args, { cwd: deps.cwd }).stdout.trim() === '';
    },
    record: (args) => spawnSync('asciinema', args, { stdio: 'inherit', cwd: deps.cwd }).status ?? 1,
    binDir,
    cwd: deps.cwd,
    media: {
      run: (cmd, args) => {
        const r = run(cmd, args, { cwd: deps.cwd });
        return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      out,
      err,
    },
    ...overrides,
  };
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
    sendSocket?: SocketSender;
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
    /** Replaces the landing pass of the `land-eligible-prs` action (tests). */
    landEligible?: () => Promise<LandReport>;
    /** Replaces the parent upkeep pass of the tick (tests). */
    parentUpkeep?: () => Promise<ParentUpkeepResult>;
    /** Replaces the per-tick usage ingest launch (tests). */
    usageIngest?: () => void;
    /** Replaces the demo's system dependencies (tests). */
    demo?: Partial<DemoDeps>;
    /** Replaces the ledger, the usage config and the decision log the turn-budget review uses (tests). */
    turnBudget?: Partial<
      Pick<TurnBudgetDeps, 'budget' | 'ticks' | 'hasOpenDecision' | 'fileDecision'>
    >;
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
  const dispatchCaller = (
    command: string,
    skipCallerIdentity = false,
    allowedRoles?: readonly string[],
  ): ReturnType<typeof checkDispatchCaller> =>
    checkDispatchCaller({
      skipCallerIdentity,
      ...(allowedRoles ? { allowedRoles } : {}),
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
            executors: flags.executors ?? '0',
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
            verifyModule: flags['no-module-check'] !== 'true',
          },
          deps,
        );
        // AISDLC-1102: the loop canary runs on the first tick after `up`.
        markCanaryDue(deps.boardDir);
        return result.attachExitCode ?? 0;
      }
      case 'spawn': {
        const taskArg = firstPositional(argv);
        if (!taskArg) {
          process.stderr.write(`cli-hierarchy: spawn needs a task id\n\n${USAGE}`);
          return 2;
        }
        const spawned = await hierarchySpawn(
          { taskId: taskArg, ...(flags.model === undefined ? {} : { model: flags.model }) },
          deps,
        );
        for (const w of spawned.warnings) deps.log(`warning: ${w}`);
        deps.log(
          JSON.stringify({ name: spawned.name, taskId: spawned.taskId, created: spawned.created }),
        );
        return 0;
      }
      case 'status': {
        const result = hierarchyStatus(deps);
        if (flags.json === 'true') deps.log(JSON.stringify(result));
        else for (const line of formatStatus(result, deps.now().getTime())) deps.log(line);
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
      case 'brief-status': {
        for (const line of formatBriefStatus(briefStatus(deps.boardDir))) deps.log(line);
        return 0;
      }
      case 'down': {
        const result = await hierarchyDown({ role: flags.role }, deps);
        // A session left alone (not started by `up`, stale pane) is not a success.
        return result.refused.length > 0 ? 1 : 0;
      }
      case 'clear': {
        const caller = dispatchCaller('clear');
        if (!caller.ok) {
          process.stderr.write(`${caller.reason}\n`);
          return 1;
        }
        const target = firstPositional(argv);
        if (!target) {
          process.stderr.write('cli-hierarchy clear: a session name is required\n');
          return 2;
        }
        const flagSettleMs = intFlag(flags, 'settle-ms');
        if (flagSettleMs === null) return 2;
        const settleMs = flagSettleMs ?? loadPrLifecycleConfig(deps.cwd).clear.handshakeCeilingMs;
        try {
          const result = await clearExecutor(
            {
              executor: target,
              workerId: caller.name,
              ...(settleMs === undefined ? {} : { settleMs }),
            },
            {
              boardDir: deps.boardDir,
              run: deps.run,
              sleep: deps.sleep,
              now: deps.now,
              ...(deps.emit ? { emit: deps.emit } : {}),
              log: deps.log,
              restart: (name) => hierarchyRestart({ session: name }, deps),
            },
          );
          deps.log(JSON.stringify(result));
          return result.ok ? 0 : 1;
        } catch (err) {
          process.stderr.write(`cli-hierarchy clear: ${(err as Error).message}\n`);
          return 1;
        }
      }
      case 'restart':
      case 'register': {
        // `restart` is open to any roster session or the operator, guarded by a lock
        // (AISDLC-1110); `register` stays a dispatch-session command.
        let callerName: string | undefined;
        if (subcommand === 'register') {
          const caller = dispatchCaller(subcommand);
          if (!caller.ok) {
            process.stderr.write(`${caller.reason}\n`);
            return 1;
          }
        } else {
          callerName = resolveCaller(
            extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
          )?.name;
        }
        // `--after-task executor-beta` reads the name as the flag's value.
        const afterTask = flags['after-task'];
        const session =
          firstPositional(argv) ??
          (afterTask !== undefined && afterTask !== 'true' ? afterTask : undefined);
        const all = subcommand === 'restart' && flags.all === 'true';
        if (!session && !all) {
          process.stderr.write(
            `cli-hierarchy ${subcommand}: ${subcommand === 'restart' ? 'a session name or --all' : 'an executor name'} is required\n`,
          );
          return 2;
        }
        if (subcommand === 'register') {
          deps.log(JSON.stringify(hierarchyRegister({ session: session as string }, deps)));
          return 0;
        }
        const waitSec = intFlag(flags, 'wait');
        if (waitSec === null) return 2;
        if (all) {
          const res = await hierarchyRestartAll(
            {
              ...(waitSec === undefined ? {} : { waitSec }),
              ...(callerName ? { callerName } : {}),
            },
            deps,
          );
          deps.log(JSON.stringify(res));
          return res.failed.length === 0 ? 0 : 1;
        }
        const result = await hierarchyRestart(
          {
            session: session as string,
            afterTask: afterTask !== undefined,
            ...(callerName ? { callerName } : {}),
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
      case 'escalation-file': {
        const taskId = flags['task-id'];
        const message = flags.message;
        if (!taskId || taskId === 'true' || !message || message === 'true') {
          process.stderr.write(
            'cli-hierarchy escalation-file: --task-id and --message are required\n',
          );
          return 2;
        }
        try {
          const { file } = writeEscalationFile({
            boardDir: deps.boardDir,
            taskId,
            message,
            now: deps.now(),
            run: extras.ghRun ?? deps.run,
          });
          deps.log(JSON.stringify({ file }));
          return 0;
        } catch (err) {
          process.stderr.write(
            `cli-hierarchy escalation-file: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return 1;
        }
      }
      case 'canary': {
        const sub = firstPositional(argv);
        if (sub !== 'run') {
          process.stderr.write('cli-hierarchy canary: usage: canary run --no-pr\n');
          return 2;
        }
        if (flags['no-pr'] !== 'true') {
          process.stderr.write(
            'cli-hierarchy canary run: --no-pr is required; the canary never opens a pull request\n',
          );
          return 2;
        }
        const repoRoot = path.resolve(flags['work-dir'] ?? deps.cwd);
        return await runLoopCanaryCommand({
          boardDir: deps.boardDir,
          workDir: repoRoot,
          baseSha: resolveBaseSha(repoRoot),
          dispatchedBy: 'canary',
          now: deps.now,
          sleep: deps.sleep,
          log: deps.log,
          notifyPlanner: (text) => {
            const { roster } = readRosterChecked(deps.boardDir);
            const planner = roster.sessions.find(
              (e) => e.role === 'planner' && e.status === 'running',
            );
            if (!planner) return;
            sendToRoster(
              roster.sessions,
              planner.name,
              text,
              extras.sendBrief ?? createTmuxBriefSender(deps.run),
              readReceivedAddresses(deps.boardDir),
              extras.sendSocket,
            );
          },
        });
      }
      case 'tick': {
        // AISDLC-1096: the watch scheduler stands in for a silent host; it ticks only when the
        // host has missed three intervals, checked here, and runs as the roster's dispatch name.
        const byScheduler = flags.by === 'scheduler';
        let worker: string;
        if (byScheduler) {
          // Location checks (main checkout, board-dir, work-dir, install) still run; only the
          // dispatch-session identity requirement is skipped. work-dir must equal the trusted
          // root, so repoRoot below is pinned to it.
          const caller = dispatchCaller('tick', true);
          if (!caller.ok) {
            process.stderr.write(`${caller.reason}\n`);
            return 1;
          }
          if (!hostTickStale(deps.boardDir, deps.now())) {
            deps.log(JSON.stringify({ skipped: 'dispatch host is alive' }));
            return 0;
          }
          worker =
            readRosterChecked(deps.boardDir).roster.sessions.find(
              (e) => e.role === 'operator-dispatch' && e.status === 'running',
            )?.name ?? 'scheduler';
        } else {
          const caller = dispatchCaller('tick');
          if (!caller.ok) {
            process.stderr.write(`${caller.reason}\n`);
            return 1;
          }
          worker = caller.name;
        }
        const flagSettleMs = intFlag(flags, 'settle-ms');
        const reportEveryMs = intFlag(flags, 'report-every-ms');
        const retryLimit = intFlag(flags, 'retry-limit');
        if (flagSettleMs === null || reportEveryMs === null || retryLimit === null) return 2;
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
          ...(byScheduler ? { tickedBy: 'scheduler' as const } : {}),
          openPrNumbers: () => {
            const r = wakeGh(
              'gh',
              ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number'],
              { cwd: repoRoot },
            );
            if (r?.status !== 0) return undefined;
            try {
              const list = JSON.parse(r.stdout) as { number: number }[];
              // A full page may hide open PRs past the limit; skip the closed-PR prune.
              if (list.length >= 200) return undefined;
              return new Set(list.map((x) => x.number));
            } catch {
              return undefined;
            }
          },
          now: deps.now,
          loopCanary: { workDir: repoRoot, baseSha: () => quietBaseSha(repoRoot) },
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
                settleMs: loadPrLifecycleConfig(deps.cwd).clear.handshakeCeilingMs,
              },
              {
                boardDir: deps.boardDir,
                run: deps.run,
                sleep: deps.sleep,
                now: deps.now,
                emit,
                restart: (name) => hierarchyRestart({ session: name }, deps),
              },
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
          sessions: () =>
            hierarchyStatus(deps).rows.map((r) => ({
              name: r.entry.name,
              role: r.entry.role,
              state: r.state,
              ...(r.inflightTask ? { inflightTask: r.inflightTask } : {}),
              ...(r.overThreshold ? { overThreshold: true } : {}),
            })),
          restartSession: async (name) => {
            try {
              await hierarchyRestart({ session: name, lockHolder: worker }, deps);
              return { ok: true };
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
          },
          idleExecutors: () =>
            hierarchyStatus(deps)
              .rows.filter(
                (r) => r.entry.role === 'executor' && r.state === 'idle' && !r.inflightTask,
              )
              .map((r) => r.entry.name),
          // RFC-0059: one executor per eligible claim, downed on its verdict.
          // AI_SDLC_EPHEMERAL_EXECUTORS=0 keeps standing executors only.
          ...(deps.env.AI_SDLC_EPHEMERAL_EXECUTORS === '0'
            ? {}
            : {
                ephemeral: {
                  down: async (name: string) => {
                    const r = await hierarchyDown({ role: name }, deps);
                    const refusal = r.refused.find((x) => x.name === name);
                    return refusal ? { ok: false, reason: refusal.reason } : { ok: true };
                  },
                  spawn: async (taskId: string) => {
                    await hierarchySpawn({ taskId }, deps);
                  },
                  reapOrphans: () => reapOrphanExecutorSessions(deps),
                  // Config ceiling and budget pacer arrive with AISDLC-1076.
                  cap: () => {
                    const n = Number(deps.env.AI_SDLC_EXECUTORS_MAX);
                    return Number.isInteger(n) && n > 0 ? n : 3;
                  },
                },
              }),
          // AISDLC-1122: every tick ingests what is new; detached, so the tick never waits.
          usageIngest:
            extras.usageIngest ??
            (() => {
              const bin = path.join(repoRoot, 'pipeline-cli', 'bin', 'cli-usage.mjs');
              if (!existsSync(bin)) return;
              const child = spawn(process.execPath, [bin, 'ingest', '--max-seconds', '25'], {
                cwd: repoRoot,
                detached: true,
                stdio: 'ignore',
              });
              // A failed spawn must never crash the tick.
              child.on('error', () => undefined);
              child.unref();
            }),
          // AISDLC-981: the tick owns the parent; the open-PR list is the wake's snapshot.
          parentUpkeep:
            extras.parentUpkeep ??
            (async () => {
              const open = new Set<string>();
              const listed = wakeGh(
                'gh',
                ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName'],
                { cwd: repoRoot },
              );
              try {
                const rows = listed.status === 0 ? JSON.parse(listed.stdout) : [];
                for (const r of rows as { headRefName?: string }[]) {
                  if (r.headRefName) open.add(r.headRefName);
                }
              } catch {
                /* unreadable list: the sweep asks gh for every branch */
              }
              return runParentUpkeep({
                workDir: repoRoot,
                runner: defaultRunner,
                pluginScriptsDir: resolvePluginScriptsDir(deps.env, repoRoot),
                exists: existsSync,
                knownOpenBranches: open,
              });
            }),
          quota: () => {
            const r = (extras.ghRun ?? deps.run)('gh', ['api', 'rate_limit'], { cwd: repoRoot });
            return r?.status === 0 ? parseQuota(r.stdout) : undefined;
          },
          quotaFloor: parseQuotaFloor(process.env.AI_SDLC_GH_QUOTA_FLOOR),
          listPrs: () => fetchHumanAttentionPrs(wakeGh, repoRoot, deps.boardDir),
          listAllPrs: () => fetchClosedUnmergedPrs(wakeGh, repoRoot),
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
          // AISDLC-1023: a red pipeline canary files its hotfix through cli-file.
          fileHotfix: ({ sha, detail }) => {
            const id = hotfixTaskId(sha);
            const dir = path.join(deps.boardDir, 'hotfix');
            mkdirSync(dir, { recursive: true });
            const file = path.join(
              dir,
              `${id.toLowerCase()} - pipeline canary red at ${sha.slice(0, 8)}.md`,
            );
            writeFileSync(file, hotfixTaskMarkdown(id, sha, detail), 'utf-8');
            const bin = fileURLToPath(new URL('../../bin/cli-file.mjs', import.meta.url));
            const r = (extras.ghRun ?? deps.run)(process.execPath, [bin, 'task', file, '--pr'], {
              cwd: repoRoot,
            });
            if (r?.status !== 0) {
              throw new Error(`cli-file task failed: ${(r?.stderr ?? '').trim() || 'no output'}`);
            }
            return id;
          },
          recordTick: (marker) => emit({ type: 'DispatchTick', ...marker }),
          ...(isDecisionCatalogEnabled()
            ? {
                reviewTurnBudget: () =>
                  reviewTurnBudget({
                    budget:
                      extras.turnBudget?.budget ??
                      loadUsageConfig({ workDir: repoRoot }).dispatchTurnsPerTickBudget,
                    ticks:
                      extras.turnBudget?.ticks ??
                      (() =>
                        loadDispatchTicks({
                          repoRoot,
                          artifactsDir: resolveArtifactsDir(repoRoot),
                        })),
                    hasOpenDecision:
                      extras.turnBudget?.hasOpenDecision ??
                      (() => hasOpenTurnBudgetDecision(repoRoot)),
                    fileDecision:
                      extras.turnBudget?.fileDecision ??
                      ((input) => fileTurnBudgetDecision(repoRoot, input)),
                  }),
              }
            : {}),
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
            holdLifted: result.holdLifted === true,
            eligibleQueued: result.held ? [] : peekQueueOrder(deps.boardDir).map((e) => e.taskId),
            idleExecutors: hierarchyStatus(deps)
              .rows.filter(
                (r) => r.entry.role === 'executor' && r.state === 'idle' && !r.inflightTask,
              )
              .map((r) => r.entry.name),
            identity: { name: worker, planner: planner?.name ?? '' },
            handoff: dispatchHandoff(deps, worker),
            selfClear: selfClearAvailability(deps.env),
          }),
        );
        return 0;
      }
      case 'executor-start': {
        const startWait = intFlag(flags, 'wait');
        if (startWait === null) return 2;
        try {
          const result = await executorStart(
            {
              boardDir: deps.boardDir,
              cwd: deps.cwd,
              ...(startWait === undefined ? {} : { waitSec: startWait }),
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
        if ((action !== 'write' && action !== 'read' && action !== 'note') || !role) {
          process.stderr.write(
            `cli-hierarchy handoff: use 'handoff write|read|note --role planner|operator-dispatch|executor'\n`,
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
          transcript: resolveTranscriptSource(deps, role, name),
        };
        if (action === 'note') {
          try {
            const r = noteLedger(opts, {
              kind: flags.kind ?? '',
              url: flags.url ?? '',
              ...(flags.summary && flags.summary !== 'true' ? { summary: flags.summary } : {}),
            });
            deps.log(JSON.stringify({ ok: true, file: r.file, entry: r.entry }));
          } catch (e) {
            process.stderr.write(`cli-hierarchy handoff note: ${(e as Error).message}\n`);
            return 2;
          }
        } else if (action === 'write') {
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
      case 'transcript': {
        const role = parseRoleFlag(flags.role);
        if (firstPositional(argv) !== 'recall' || !role) {
          process.stderr.write(
            `cli-hierarchy transcript: use 'transcript recall --role <r> [--since-clear | --last-turns N] [--file <path>] [--max-chars N]'\n`,
          );
          return 2;
        }
        const lastTurns = intFlag(flags, 'last-turns');
        const maxChars = intFlag(flags, 'max-chars');
        if (lastTurns === null || maxChars === null) return 2;
        const src = resolveTranscriptSource(deps, role, flags.name);
        let file = src.file;
        if (flags.file && flags.file !== 'true') {
          file = path.resolve(deps.cwd, flags.file);
          const rel = path.relative(src.archiveDir, file);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            process.stderr.write(
              `cli-hierarchy transcript recall: --file must be under ${src.archiveDir}\n`,
            );
            return 2;
          }
        }
        if (!file) {
          deps.log(`notice: no live transcript is registered for ${role}`);
          return 0;
        }
        const r = recallTranscript({
          file,
          window: flags.file
            ? { mode: 'whole' }
            : lastTurns !== undefined
              ? { mode: 'last-turns', turns: lastTurns }
              : { mode: 'pre-clear' },
          ...(maxChars === undefined ? {} : { maxChars }),
        });
        for (const n of r.notices) deps.log(`notice: ${n}`);
        if (r.digest) deps.log(r.digest);
        return 0;
      }
      case 'send': {
        const restartTarget = flags.restart;
        if (restartTarget !== undefined) {
          if (restartTarget === 'true' || !restartTarget) {
            process.stderr.write('cli-hierarchy send: --restart <session> needs a session name\n');
            return 2;
          }
          const by =
            resolveCaller(
              extras.identity ?? createSystemIdentity(deps.boardDir, extras.processLookup),
            )?.name ?? 'operator';
          try {
            writeRestartRequest(deps.boardDir, restartTarget, by, deps.now());
          } catch (err) {
            process.stderr.write(`cli-hierarchy send: ${(err as Error).message}\n`);
            return 1;
          }
          deps.log(JSON.stringify({ ok: true, restartRequested: restartTarget, by }));
          return 0;
        }
        const to = flags.to === 'true' ? '' : (flags.to ?? '');
        const text = flags.text === 'true' ? '' : (flags.text ?? '');
        if (!to || !text) {
          process.stderr.write('cli-hierarchy send: --to and --text are required\n');
          return 2;
        }
        const { roster } = readRosterChecked(deps.boardDir);
        try {
          sendToRoster(
            roster.sessions,
            to,
            text,
            extras.sendBrief ?? createTmuxBriefSender(deps.run),
            readReceivedAddresses(deps.boardDir),
            extras.sendSocket,
          );
        } catch (err) {
          process.stderr.write(`cli-hierarchy send: ${(err as Error).message}\n`);
          return 1;
        }
        deps.log(JSON.stringify({ ok: true, sent: to }));
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
      case 'demo': {
        return await runDemo(firstPositional(argv), flags, createDemoDeps(deps, extras.demo));
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
