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
  type Roster,
  type RosterEntry,
} from './types.js';
import {
  assertModel,
  assertPermissionMode,
  assertSessionName,
  executorNames,
  parseExecutorCount,
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
  /** Overrides the planner permission mode; otherwise the operator's own setting is used. */
  plannerPermissionMode?: string;
  /** Allow a planner that would start in bypassPermissions mode. */
  allowPlannerBypass?: boolean;
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
  name: string;
  model: string;
  permissionMode: string;
  prompt: string;
}

const BYPASS_MODE = 'bypassPermissions';

/** Permission mode used for the planner when the operator has none configured. */
export const FALLBACK_PLANNER_MODE = 'default';

/** Build the `claude` command line for one session. */
export function buildClaudeCommand(bin: string, s: PlannedSession): string {
  return [
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

function plan(opts: UpOptions, count: number, plannerMode: string): PlannedSession[] {
  const sessions: PlannedSession[] = [];
  if (!opts.noPlanner) {
    sessions.push({
      role: 'planner',
      name: 'planner',
      model: opts.plannerModel,
      permissionMode: plannerMode,
      prompt: '/ai-sdlc planner',
    });
  }
  sessions.push({
    role: 'operator-dispatch',
    name: 'operator-dispatch',
    model: opts.dispatchModel,
    permissionMode: BYPASS_MODE,
    prompt: '/ai-sdlc operator-dispatch',
  });
  for (const name of executorNames(count)) {
    sessions.push({
      role: 'executor',
      name,
      model: opts.executorModel,
      permissionMode: BYPASS_MODE,
      prompt: '/ai-sdlc executor',
    });
  }
  return sessions;
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

  const settings = readSettingsView(deps.settingsFiles);
  const plannerMode = opts.plannerPermissionMode ?? settings.defaultMode ?? FALLBACK_PLANNER_MODE;
  const planned = plan(opts, count, plannerMode);
  for (const s of planned) assertSessionName(s.name);

  const warnings: string[] = [];

  // An old-layout roster (windows in one shared session) is never mixed with the new
  // layout: refuse before starting anything or writing the roster.
  const { roster: loaded, rejected } = readRosterChecked(deps.boardDir);
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
  if (wantsPlanner && livePlanner && livePlanner.tmuxWindow !== 'planner') {
    throw new Error(
      `a planner is already running ('${livePlanner.name}'); refusing to start a second one. Use --no-planner to leave it alone.`,
    );
  }

  const existing: RosterEntry[] = [];
  const toStart: PlannedSession[] = [];
  for (const s of planned) {
    const entry = kept.find((e) => e.tmuxWindow === s.name);
    if (entry) {
      existing.push(entry);
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
  }
  if (toStart.length === 0 && warnings.length > 0) writeRoster(deps.boardDir, roster);

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
