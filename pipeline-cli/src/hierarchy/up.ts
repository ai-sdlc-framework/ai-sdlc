/**
 * `cli-hierarchy up`: start the planner, the dispatch session and N executors
 * as named, model-pinned, permission-mode-pinned Claude Code sessions, each in its
 * own detached tmux session (session name == window name == agent name), and
 * record them in the roster. One session per agent lets two terminals show two
 * agents; clients attached to one shared session would follow the same window.
 */

import path from 'node:path';

import { attachEntry } from './attach.js';
import { findStartedSession, readSessionRegistry } from './registry.js';
import { checkCrossSessionInbound, evaluateResourceGate, readSettingsView } from './preflight.js';
import { isLegacyLayoutEntry, readRosterChecked, writeRoster } from './roster.js';
import { inspectVscodeTasks, syncVscodeTasks } from './terminals.js';
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
  /** Overrides the planner permission mode; otherwise the operator's own setting is used. */
  plannerPermissionMode?: string;
  /** Allow a planner that would start in bypassPermissions mode. */
  allowPlannerBypass?: boolean;
  /**
   * Regenerate `<cwd>/.vscode/tasks.json` after the roster is written (the CLI sets this
   * unless `--no-vscode-tasks` is given). Absent: no regeneration.
   */
  vscodeTasks?: boolean;
}

/** Result of `up`. */
export interface UpResult {
  started: RosterEntry[];
  existing: RosterEntry[];
  warnings: string[];
  /** Exit code of the tmux attach when `--attach` was requested and ran. */
  attachExitCode?: number;
}

interface PlannedSession {
  role: HierarchyRole;
  /** Project-qualified name, used as the harness name and the tmux session name. */
  name: string;
  /** Unqualified role name (`executor-beta`). */
  bare: string;
  model: string;
  permissionMode: string;
  prompt: string;
}

/** The line `up` prints last when it runs inside a VS Code terminal. */
export const VSCODE_HINT =
  'VS Code: run task "hierarchy: open all agents" (Terminal > Run Task) to open one terminal per agent';

/** True for a VS Code integrated terminal (also a tmux pane opened from one). */
function insideVsCode(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_GIT_IPC_HANDLE);
}

const BYPASS_MODE = 'bypassPermissions';

/** Permission mode used for the planner when the operator has none configured. */
export const FALLBACK_PLANNER_MODE = 'default';

/** Build the `claude` command line for one session. */
export function buildClaudeCommand(
  bin: string,
  s: Pick<PlannedSession, 'role' | 'name' | 'model' | 'permissionMode' | 'prompt'>,
): string {
  // Exported ahead of the command so the plugin hook sees them at launch (the agent's
  // own Bash commands cannot change them); the lease-push guard binds an executor by them.
  return [
    `AI_SDLC_HIERARCHY_SESSION=${shellQuote(s.name)}`,
    `AI_SDLC_HIERARCHY_ROLE=${shellQuote(s.role)}`,
    shellQuote(bin),
    '--name',
    shellQuote(s.name),
    '--model',
    shellQuote(s.model),
    '--permission-mode',
    shellQuote(s.permissionMode),
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
      prompt: '/ai-sdlc planner',
    });
  }
  sessions.push({
    role: 'operator-dispatch',
    name: qualifiedName(project, 'operator-dispatch'),
    bare: 'operator-dispatch',
    model: opts.dispatchModel,
    permissionMode: BYPASS_MODE,
    prompt: '/ai-sdlc operator-dispatch',
  });
  for (const bare of executorNames(count)) {
    sessions.push({
      role: 'executor',
      name: qualifiedName(project, bare),
      bare,
      model: opts.executorModel,
      permissionMode: BYPASS_MODE,
      prompt: '/ai-sdlc executor',
    });
  }
  return sessions;
}

function defaultIsAlive(pid: number): boolean {
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

async function waitForRegistry(
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
 * Start whatever part of the hierarchy is not already running.
 * @throws before starting anything when validation, the settings check or the
 *   resource gate refuses; after a partial start when a window cannot be created.
 */
export async function hierarchyUp(opts: UpOptions, deps: HierarchyDeps): Promise<UpResult> {
  const count = parseExecutorCount(opts.executors);
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

  const settings = readSettingsView(deps.settingsFiles);
  const plannerMode = opts.plannerPermissionMode ?? settings.defaultMode ?? FALLBACK_PLANNER_MODE;
  const planned = plan(opts, project, count, plannerMode);
  for (const s of planned) assertSessionName(s.name);

  const warnings: string[] = [];

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
  const kept = loaded.sessions.filter((e) => windowLive(deps.run, e.tmuxSession, e.tmuxWindow));
  for (const e of loaded.sessions) {
    if (!kept.includes(e)) {
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
  if (plannerToStart) {
    assertPermissionMode(plannerToStart.permissionMode);
    if (plannerToStart.permissionMode === BYPASS_MODE && !opts.allowPlannerBypass) {
      throw new Error(
        `the planner would start in ${BYPASS_MODE} mode (from the settings in force or --planner-permission-mode); refusing. The planner is the operator-facing tier and should keep its approval prompts. Pass --allow-planner-bypass to start it anyway, or set a different defaultMode.`,
      );
    }
  }

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
    const refusal = evaluateResourceGate(deps.resources(), deps.env);
    if (refusal) throw new Error(refusal);
  }

  const roster: Roster = { schemaVersion: 'v1', sessions: [...kept] };
  const started: RosterEntry[] = [];
  for (const s of toStart) {
    const spawnedAt = deps.now();
    const result = startSession(deps.run, s.name, buildClaudeCommand(deps.claudeBin, s), deps.cwd);
    if (result.status !== 0) {
      writeRoster(deps.boardDir, roster);
      throw new Error(
        `could not start '${s.name}': ${result.stderr.trim() || 'tmux failed'} (${started.length} session(s) started before the failure)`,
      );
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
    const claimed = new Set(roster.sessions.map((e) => e.name));
    const registered = await waitForRegistry(deps, s.name, spawnedAt.getTime(), claimed);
    if (!registered) {
      warnings.push(
        `'${s.name}' was started but the harness registry did not list it; the roster keeps the requested name`,
      );
    }
    const entry: RosterEntry = {
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
      status: registered ? 'running' : 'starting',
    };
    roster.sessions.push(entry);
    started.push(entry);
    writeRoster(deps.boardDir, roster);
    deps.emit?.({
      type: 'HierarchySessionStarted',
      sessionName: entry.name,
      sessionRole: entry.role,
    });
  }
  // Also rewrites a roster written before project scoping, now carrying `project`.
  if (toStart.length === 0 && (warnings.length > 0 || kept.length > 0)) {
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
    if (owner === 'ours' && insideVsCode(deps.env)) deps.log(VSCODE_HINT);
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
