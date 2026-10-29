/**
 * `cli-hierarchy up`: start the planner, the dispatch session and N executors
 * as named, model-pinned, permission-mode-pinned Claude Code sessions, each in its
 * own detached tmux session (session name == window name == agent name), and
 * record them in the roster. One session per agent lets two terminals show two
 * agents; clients attached to one shared session would follow the same window.
 */

import { ghCallsPath, GH_CALL_LOG_ENV, installGhShim } from './gh-calls.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { schedulerUp } from './reconcile-scheduler.js';
import { webhookUp } from './webhook.js';
import { attachEntry } from './attach.js';
import { findStartedSession, readSessionRegistry, reconcileStartingEntries } from './registry.js';
import { checkCrossSessionInbound, evaluateResourceGate, readSettingsView } from './preflight.js';
import { isLegacyLayoutEntry, readRosterChecked, writeRoster } from './roster.js';
import { inspectVscodeTasks, syncVscodeTasks } from './terminals.js';
import { assertDispatchModuleLoaded } from './module-health.js';
import { overContextWarnings } from './context-size.js';
import {
  hasSession,
  markSessionOwned,
  OWNER_OPTION,
  paneInfo,
  setSessionTitles,
  startSession,
  windowLive,
} from './tmux.js';
import {
  HIERARCHY_TMUX_SESSION,
  type HierarchyDeps,
  type HierarchyRole,
  type RegistrySession,
  type Roster,
  type RosterEntry,
} from './types.js';
import {
  isNodeInstalled,
  missingNodeMessage,
  normalizeNodeVersion,
  nvmActivationPrefix,
  readNvmrc,
} from './node-pin.js';
import {
  assertModel,
  assertPermissionMode,
  assertProject,
  assertSessionName,
  bareRoleNames,
  executorNames,
  parseExecutorCount,
  qualifiedName,
  sanitizeProject,
  shellQuote,
} from './validate.js';

/** Options for `up`. */
export interface UpOptions {
  executors: number | string;
  plannerModel: string;
  dispatchModel: string;
  executorModel: string;
  noPlanner: boolean;
  attach: boolean;
  /**
   * Project the session names are qualified with (`<project>-<role>`). Default: the
   * repository basename. Required (with a distinct value) when sessions with the same
   * unqualified role names are already running for a different project.
   */
  project?: string;
  /** Overrides the planner permission mode; otherwise the planner starts in bypassPermissions. */
  plannerPermissionMode?: string;
  /** Deprecated no-op (AISDLC-752): every session now starts in bypassPermissions. */
  allowPlannerBypass?: boolean;
  /**
   * Regenerate `<cwd>/.vscode/tasks.json` after the roster is written (the CLI sets this
   * unless `--no-vscode-tasks` is given). Absent: no regeneration.
   */
  vscodeTasks?: boolean;
  /**
   * Node version every session runs under (`--node`). Default: the version `.nvmrc` in the
   * repository root names; with neither, sessions inherit the launching shell's Node.
   */
  node?: string;
  /** Rebuild a stale or missing repo build (`--rebuild`) instead of refusing to launch. */
  rebuild?: boolean;
  /** End with the dispatch-host module check (the CLI sets this unless `--no-module-check`). */
  verifyModule?: boolean;
}

/** The one command that rebuilds the repo's own pipeline-cli. */
export const REBUILD_COMMAND = 'pnpm --filter @ai-sdlc/pipeline-cli build';

/**
 * AISDLC-988: inside this monorepo the repo's own pipeline-cli build must be fresh.
 * Runs the resolve script's single freshness check in strict mode; a stale or missing
 * build refuses (naming the rebuild command) or, with `rebuild`, is rebuilt first.
 * Repos without the script (adopters) skip the check.
 */
export function ensureFreshRepoBuild(deps: HierarchyDeps, rebuild: boolean): void {
  const script = path.join(deps.cwd, 'ai-sdlc-plugin', 'scripts', 'resolve-pipeline-cli.sh');
  if (!existsSync(script)) return;
  const check = (): boolean =>
    deps.run('bash', [script, '--strict'], { cwd: deps.cwd }).status === 0;
  if (check()) return;
  if (!rebuild) {
    throw new Error(
      `the pipeline-cli build in ${deps.cwd} is missing or older than its sources; refusing to launch on a stale build. Run: ${REBUILD_COMMAND} (or pass --rebuild)`,
    );
  }
  deps.log(`rebuilding: ${REBUILD_COMMAND}`);
  const built = deps.run('pnpm', ['--filter', '@ai-sdlc/pipeline-cli', 'build'], { cwd: deps.cwd });
  if (built.status !== 0 || !check()) {
    throw new Error(
      `--rebuild failed; run ${REBUILD_COMMAND} by hand and fix the error: ${(built.stderr || built.stdout || '').trim().slice(0, 500)}`,
    );
  }
}

/** Result of `up`. */
export interface UpResult {
  started: RosterEntry[];
  existing: RosterEntry[];
  warnings: string[];
  /** Exit code of the tmux attach when `--attach` was requested and ran. */
  attachExitCode?: number;
}

export interface PlannedSession {
  role: HierarchyRole;
  /** Project-qualified name, used as the harness name and the tmux session name. */
  name: string;
  /** Unqualified role name (`executor-beta`). */
  bare: string;
  model: string;
  permissionMode: string;
  prompt: string;
  /** Task an ephemeral executor serves; exported as `AI_SDLC_EXECUTOR_TASK` (RFC-0059). */
  taskId?: string;
}

/**
 * The line `up` prints last when it runs inside a VS Code terminal, unless the
 * `vscode-hierarchy` extension is active (`AI_SDLC_VSCODE_HIERARCHY=1`): it opens the terminals itself.
 */
export const VSCODE_HINT =
  'VS Code: run task "hierarchy: open all agents" (Terminal > Run Task) to open one terminal per agent';

/** True for a VS Code integrated terminal (also a tmux pane opened from one). */
function insideVsCode(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_GIT_IPC_HANDLE);
}

const BYPASS_MODE = 'bypassPermissions';

/** First prompt each role's session starts with. */
export const ROLE_PROMPT: Record<HierarchyRole, string> = {
  planner: '/ai-sdlc planner',
  'operator-dispatch': '/ai-sdlc operator-dispatch',
  executor: '/ai-sdlc executor',
};

/** Permission mode the planner starts in unless `--planner-permission-mode` overrides it. */
export const DEFAULT_PLANNER_MODE = BYPASS_MODE;

/**
 * True when `command` carries the launch env the lease-push hook binds a session by:
 * `AI_SDLC_HIERARCHY_SESSION=<name>` and `AI_SDLC_HIERARCHY_ROLE=<role>`, quoted or not.
 */
export function hasLaunchEnv(command: string, name: string, role: string): boolean {
  // tmux `#{pane_start_command}` wraps the whole command in one pair of double quotes.
  const unwrapped =
    command.length >= 2 && command.startsWith('"') && command.endsWith('"')
      ? command.slice(1, -1)
      : command;
  const has = (key: string, value: string): boolean =>
    new RegExp(
      `(?:^|\\s)${key}=(['"]?)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1(?:\\s|$)`,
    ).test(unwrapped);
  return has('AI_SDLC_HIERARCHY_SESSION', name) && has('AI_SDLC_HIERARCHY_ROLE', role);
}

/**
 * AISDLC-1067: an executor loads only the MCP servers named by `--mcp-config`, not the operator's
 * personal connectors (their tool schemas would ride in every call). Set
 * `AI_SDLC_EXECUTOR_MCP_CONFIG=<path to an MCP config json>` to name the servers it keeps (the
 * plugin's own server); unset leaves MCP loading unchanged; `AI_SDLC_EXECUTOR_MCP=all` forces that.
 */
export function executorMcpArgs(role: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (role !== 'executor' || env.AI_SDLC_EXECUTOR_MCP === 'all') return [];
  const cfg = env.AI_SDLC_EXECUTOR_MCP_CONFIG;
  // Without a config, --strict-mcp-config would load no server at all (not even the plugin's
  // task_edit/task_complete), so the flag is only passed together with --mcp-config.
  return cfg ? ['--strict-mcp-config', '--mcp-config', shellQuote(cfg)] : [];
}

/** Build the `claude` command line for one session. */
export function buildClaudeCommand(
  bin: string,
  s: Pick<PlannedSession, 'role' | 'name' | 'model' | 'permissionMode' | 'prompt' | 'taskId'>,
  nodeVersion?: string,
  ghLog?: { shimDir: string; logPath: string },
): string {
  // Exported ahead of the command so the plugin hook sees them at launch (the agent's
  // own Bash commands cannot change them); the lease-push guard binds an executor by them.
  return [
    ...(nodeVersion ? [nvmActivationPrefix(nodeVersion)] : []),
    // AISDLC-963: a `gh` shim first on PATH logs calls that bypass the runner.
    ...(ghLog
      ? [
          `PATH=${shellQuote(ghLog.shimDir)}:"$PATH"`,
          `${GH_CALL_LOG_ENV}=${shellQuote(ghLog.logPath)}`,
        ]
      : []),
    `AI_SDLC_HIERARCHY_SESSION=${shellQuote(s.name)}`,
    `AI_SDLC_HIERARCHY_ROLE=${shellQuote(s.role)}`,
    ...(s.taskId ? [`AI_SDLC_EXECUTOR_TASK=${shellQuote(s.taskId)}`] : []),
    shellQuote(bin),
    '--name',
    shellQuote(s.name),
    '--model',
    shellQuote(s.model),
    '--permission-mode',
    shellQuote(s.permissionMode),
    ...executorMcpArgs(s.role),
    shellQuote(s.prompt),
  ].join(' ');
}

function plan(
  opts: UpOptions,
  project: string,
  count: number,
  plannerMode: string,
): PlannedSession[] {
  const sessions: PlannedSession[] = [];
  if (!opts.noPlanner) {
    sessions.push({
      role: 'planner',
      name: qualifiedName(project, 'planner'),
      bare: 'planner',
      model: opts.plannerModel,
      permissionMode: plannerMode,
      prompt: ROLE_PROMPT.planner,
    });
  }
  sessions.push({
    role: 'operator-dispatch',
    name: qualifiedName(project, 'operator-dispatch'),
    bare: 'operator-dispatch',
    model: opts.dispatchModel,
    permissionMode: BYPASS_MODE,
    prompt: ROLE_PROMPT['operator-dispatch'],
  });
  for (const bare of executorNames(count)) {
    sessions.push({
      role: 'executor',
      name: qualifiedName(project, bare),
      bare,
      model: opts.executorModel,
      permissionMode: BYPASS_MODE,
      prompt: ROLE_PROMPT.executor,
    });
  }
  return sessions;
}

export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Live harness sessions on this machine that are not part of this hierarchy but could
 * be reached by, or collide with, its names: a bare role name (`planner`,
 * `executor-alpha`, from a hierarchy started before project scoping, or by hand) or the
 * very name this hierarchy is about to use, running in another directory. Sessions
 * already in this roster (by pid) and sessions started in this checkout are never
 * foreign.
 */
export function findForeignSessions(
  registry: readonly RegistrySession[],
  plannedNames: ReadonlySet<string>,
  ownPids: ReadonlySet<number>,
  cwd: string,
  isAlive: (pid: number) => boolean,
): RegistrySession[] {
  const bare = new Set(bareRoleNames());
  return registry.filter((s) => {
    if (ownPids.has(s.pid) || !isAlive(s.pid)) return false;
    if (s.cwd !== undefined && path.resolve(s.cwd) === path.resolve(cwd)) return false;
    return bare.has(s.name) || plannedNames.has(s.name);
  });
}

export async function waitForRegistry(
  deps: HierarchyDeps,
  requestedName: string,
  spawnedAtMs: number,
  claimed: ReadonlySet<string>,
) {
  for (let attempt = 0; attempt < deps.pollAttempts; attempt++) {
    const found = findStartedSession(
      readSessionRegistry(deps.registryDir),
      requestedName,
      spawnedAtMs,
      claimed,
    );
    if (found) return found;
    if (attempt < deps.pollAttempts - 1) await deps.sleep(deps.pollIntervalMs);
  }
  return undefined;
}

/**
 * Start one planned session in its own tmux session and build its roster entry. Shared by
 * `up` and `restart`. Returns a failure message instead of throwing so the caller can
 * record its progress first; `countable` marks a tmux failure (the caller adds how many
 * sessions had started).
 */
export async function launchSession(
  s: PlannedSession,
  project: string,
  deps: HierarchyDeps,
  claimedNames: ReadonlySet<string>,
  warnings: string[],
  nodeVersion?: string,
): Promise<{ entry: RosterEntry } | { failure: string; countable: boolean }> {
  const spawnedAt = deps.now();
  let ghLog: { shimDir: string; logPath: string } | undefined;
  try {
    ghLog = { shimDir: installGhShim(deps.boardDir), logPath: ghCallsPath(deps.boardDir) };
  } catch (err) {
    warnings.push(`could not install the gh call-log shim: ${(err as Error).message}`);
  }
  const command = buildClaudeCommand(deps.claudeBin, s, nodeVersion, ghLog);
  // Impossible by construction; asserted because a bare launch only fails at push time.
  if (!hasLaunchEnv(command, s.name, s.role)) {
    return {
      failure: `refusing to start '${s.name}': its command lacks AI_SDLC_HIERARCHY_SESSION/AI_SDLC_HIERARCHY_ROLE`,
      countable: false,
    };
  }
  const result = startSession(deps.run, s.name, command, deps.cwd);
  if (result.status !== 0) {
    return {
      failure: `could not start '${s.name}': ${result.stderr.trim() || 'tmux failed'}`,
      countable: true,
    };
  }
  // Ownership marker: `down` and `brief --notify` act only on sessions that carry it.
  // A failure leaves the agent running but out of their reach, so say so.
  if (markSessionOwned(deps.run, s.name).status !== 0) {
    warnings.push(
      `could not mark tmux session '${s.name}' with ${OWNER_OPTION}; down and brief --notify will refuse to act on it until it carries that option`,
    );
  }
  // Cosmetic: a failure here must not undo a started agent.
  if (setSessionTitles(deps.run, s.name).status !== 0) {
    warnings.push(`could not set the terminal title of tmux session '${s.name}'`);
  }
  const pane = paneInfo(deps.run, s.name, s.name);
  const registered = await waitForRegistry(deps, s.name, spawnedAt.getTime(), claimedNames);
  if (!registered) {
    warnings.push(
      `'${s.name}' was started but the harness registry did not list it; the roster keeps the requested name`,
    );
  }
  return {
    entry: {
      role: s.role,
      project,
      name: registered?.name ?? s.name,
      tmuxSession: s.name,
      tmuxWindow: s.name,
      paneId: pane.paneId,
      pid: registered?.pid ?? pane.panePid,
      model: s.model,
      permissionMode: s.permissionMode,
      startedAt: spawnedAt.toISOString(),
      ...(nodeVersion && /^\d+\.\d+\.\d+$/.test(nodeVersion) ? { nodeVersion } : {}),
      status: registered ? 'running' : 'starting',
    },
  };
}

/**
 * Start whatever part of the hierarchy is not already running.
 * @throws before starting anything when validation, the settings check or the
 *   resource gate refuses; after a partial start when a window cannot be created.
 */
export async function hierarchyUp(opts: UpOptions, deps: HierarchyDeps): Promise<UpResult> {
  ensureFreshRepoBuild(deps, opts.rebuild === true);
  const count = parseExecutorCount(opts.executors);
  if (count > 0) {
    deps.log(
      `deprecated: --executors ${count} starts standing executors; dispatch now spawns one executor per task (RFC-0059), so the default is 0 and this option is removed in the next release`,
    );
  }
  assertModel(opts.plannerModel, '--planner-model');
  assertModel(opts.dispatchModel, '--dispatch-model');
  assertModel(opts.executorModel, '--executor-model');
  if (opts.plannerPermissionMode) assertPermissionMode(opts.plannerPermissionMode);

  const explicitProject = opts.project !== undefined && opts.project !== '';
  const project = explicitProject
    ? (opts.project as string)
    : sanitizeProject(path.basename(path.resolve(deps.cwd)));
  if (!project) {
    throw new Error(
      `cannot derive a project name from the repository directory '${path.basename(deps.cwd)}'; pass --project <name>`,
    );
  }
  assertProject(project);

  let nodeVersion: string | undefined;
  if (opts.node !== undefined) {
    nodeVersion = normalizeNodeVersion(opts.node);
    if (!nodeVersion) {
      throw new Error(`--node '${opts.node}' is not a node version such as 22.23.2 or 22`);
    }
  } else {
    nodeVersion = readNvmrc(deps.cwd);
  }

  const settings = readSettingsView(deps.settingsFiles);
  // The operator's own `defaultMode` setting does not feed the planner mode: the
  // hierarchy is an unattended fleet and its mode is a hierarchy decision.
  const plannerMode = opts.plannerPermissionMode ?? DEFAULT_PLANNER_MODE;
  const planned = plan(opts, project, count, plannerMode);
  for (const s of planned) assertSessionName(s.name);

  const warnings: string[] = [];
  if (opts.allowPlannerBypass) {
    deps.log(
      'deprecated: --allow-planner-bypass has no effect; every session, the planner included, starts in bypassPermissions by default',
    );
  }

  // An old-layout roster (windows in one shared session) is never mixed with the new
  // layout: refuse before starting anything or writing the roster.
  const { roster: loaded, rejected } = readRosterChecked(deps.boardDir, project);
  if (loaded.sessions.some(isLegacyLayoutEntry)) {
    throw new Error(
      `the roster uses the old single-session layout ('${HIERARCHY_TMUX_SESSION}'); run 'cli-hierarchy down' first, then run 'cli-hierarchy up' again`,
    );
  }
  for (const r of rejected) warnings.push(`${r}; not touched`);

  // Drop roster entries whose session is gone; they are restarted below if planned.
  const liveEntries = loaded.sessions.filter((e) =>
    windowLive(deps.run, e.tmuxSession, e.tmuxWindow),
  );
  // An entry left in `starting` takes its registry name once the registry lists it.
  const reconciled = reconcileStartingEntries(liveEntries, readSessionRegistry(deps.registryDir));
  const kept = reconciled.entries;
  const reconcileChanged = reconciled.changed > 0;
  for (const e of loaded.sessions) {
    if (!liveEntries.includes(e)) {
      warnings.push(`roster entry '${e.name}' had no live tmux session and was dropped`);
    }
  }

  // A second planner is never started, whatever name the first one has.
  const livePlanner = kept.find((e) => e.role === 'planner');
  const wantsPlanner = planned.some((s) => s.role === 'planner');
  const plannedPlanner = planned.find((s) => s.role === 'planner');
  if (
    wantsPlanner &&
    livePlanner &&
    livePlanner.tmuxWindow !== plannedPlanner?.name &&
    livePlanner.tmuxWindow !== plannedPlanner?.bare
  ) {
    throw new Error(
      `a planner is already running ('${livePlanner.name}'); refusing to start a second one. Use --no-planner to leave it alone.`,
    );
  }

  const existing: RosterEntry[] = [];
  const toStart: PlannedSession[] = [];
  for (const s of planned) {
    // A session started before project scoping keeps its bare name until it is restarted.
    const entry = kept.find((e) => e.tmuxWindow === s.name || e.tmuxWindow === s.bare);
    if (entry) {
      existing.push(entry);
      if (entry.tmuxWindow === s.bare) {
        warnings.push(
          `'${entry.name}' still has the unqualified name from before project scoping; run 'cli-hierarchy down' then 'cli-hierarchy up' to get '${s.name}'`,
        );
      }
    } else if (hasSession(deps.run, s.name)) {
      warnings.push(
        `tmux session '${s.name}' exists but is not in the roster; leaving it alone and not starting a duplicate`,
      );
    } else {
      toStart.push(s);
    }
  }

  const plannerToStart = toStart.find((s) => s.role === 'planner');
  if (plannerToStart) assertPermissionMode(plannerToStart.permissionMode);

  if (toStart.length > 0) {
    const foreign = findForeignSessions(
      readSessionRegistry(deps.registryDir),
      new Set(planned.map((s) => s.name)),
      new Set(kept.map((e) => e.pid)),
      deps.cwd,
      deps.isAlive ?? defaultIsAlive,
    );
    if (foreign.length > 0) {
      const list = foreign.map((f) => `'${f.name}' (pid ${f.pid})`).join(', ');
      if (!explicitProject) {
        throw new Error(
          `sessions with the same role names are already running on this machine for another project: ${list}. Their bare names could receive this hierarchy's messages. Run again with --project <name> to start this hierarchy under its own name, or stop those sessions first`,
        );
      }
      warnings.push(
        `sessions with the same role names are already running for another project: ${list}; started under project '${project}' as requested`,
      );
    }
    if (toStart.some((s) => s.permissionMode === BYPASS_MODE)) {
      const inbound = checkCrossSessionInbound(
        settings,
        deps.userSettingsFile,
        path.join(deps.cwd, '.claude', 'settings.local.json'),
      );
      if (!inbound.ok) throw new Error(inbound.message);
    }
    if (nodeVersion) {
      const installed = deps.nodeInstalled ?? ((v: string) => isNodeInstalled(v, deps.env));
      if (!installed(nodeVersion)) throw new Error(missingNodeMessage(nodeVersion));
    }
    const refusal = evaluateResourceGate(deps.resources(), deps.env);
    if (refusal) throw new Error(refusal);
  }

  const roster: Roster = { schemaVersion: 'v1', sessions: [...kept] };
  const started: RosterEntry[] = [];
  for (const s of toStart) {
    const launched = await launchSession(
      s,
      project,
      deps,
      new Set(roster.sessions.map((e) => e.name)),
      warnings,
      nodeVersion,
    );
    if ('failure' in launched) {
      writeRoster(deps.boardDir, roster);
      throw new Error(
        launched.countable
          ? `${launched.failure} (${started.length} session(s) started before the failure)`
          : launched.failure,
      );
    }
    const entry = launched.entry;
    roster.sessions.push(entry);
    started.push(entry);
    writeRoster(deps.boardDir, roster);
    deps.emit?.({
      type: 'HierarchySessionStarted',
      sessionName: entry.name,
      sessionRole: entry.role,
      sessionModel: entry.model,
      sessionPermissionMode: entry.permissionMode,
    });
  }
  // Also rewrites a roster written before project scoping, now carrying `project`.
  if (toStart.length === 0 && (warnings.length > 0 || kept.length > 0 || reconcileChanged)) {
    writeRoster(deps.boardDir, roster);
  }

  for (const e of started) {
    const renamed = e.name === e.tmuxWindow ? '' : ` (registered as '${e.name}')`;
    deps.log(
      `started ${e.role} '${e.tmuxWindow}'${renamed} model=${e.model} mode=${e.permissionMode}`,
    );
    deps.log(`  show it with: cli-hierarchy attach ${e.tmuxWindow}`);
  }
  for (const e of existing)
    deps.log(`already running ${e.role} '${e.tmuxWindow}' (session left alone)`);
  for (const w of warnings) deps.log(`warning: ${w}`);

  // The consumer of the webhook wake file; runs whether or not a secret is set (AISDLC-932).
  try {
    schedulerUp(deps, deps.spawnScheduler);
  } catch (err) {
    deps.log(`warning: reconcile scheduler not started: ${(err as Error).message}`);
  }

  if (opts.vscodeTasks) {
    let owner: 'absent' | 'ours' | 'foreign' = 'absent';
    try {
      if (started.length > 0 || kept.length !== loaded.sessions.length) {
        if (syncVscodeTasks(deps) === 'foreign') {
          deps.log(
            'note: .vscode/tasks.json was not generated by cli-hierarchy and was left alone; to merge by hand run: cli-hierarchy terminals --vscode --print',
          );
        }
      }
      owner = inspectVscodeTasks(deps);
    } catch (err) {
      deps.log(`warning: could not write .vscode/tasks.json: ${(err as Error).message}`);
    }
    if (owner === 'ours' && insideVsCode(deps.env) && deps.env.AI_SDLC_VSCODE_HIERARCHY !== '1') {
      deps.log(VSCODE_HINT);
    }
  }

  // Poll-only mode when no secret is set; this is not an error (AISDLC-880).
  if (deps.env.AI_SDLC_WEBHOOK_SECRET) {
    try {
      webhookUp(deps);
    } catch (err) {
      deps.log(`warning: webhook receiver not started: ${(err as Error).message}`);
    }
  }

  if (opts.verifyModule) {
    const hosts = roster.sessions.filter((e) => e.role === 'operator-dispatch');
    if (hosts.length > 0) await assertDispatchModuleLoaded(deps, hosts);
  }

  try {
    for (const line of overContextWarnings(deps, roster.sessions)) deps.log(line);
  } catch {
    /* a context read must never fail up */
  }

  let attachExitCode: number | undefined;
  if (opts.attach) {
    const target =
      started.find((e) => e.role === 'planner') ??
      roster.sessions.find((e) => e.role === 'operator-dispatch');
    if (target) {
      try {
        attachExitCode = attachEntry(target, deps);
      } catch (err) {
        deps.log(`warning: could not attach to '${target.tmuxWindow}': ${(err as Error).message}`);
        attachExitCode = 1;
      }
    } else deps.log('warning: no planner or dispatch session to attach to');
  }
  return { started, existing, warnings, attachExitCode };
}
