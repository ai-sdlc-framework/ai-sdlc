/**
 * `cli-hierarchy up`: start the planner, the dispatch session and N executors
 * as named, model-pinned, permission-mode-pinned Claude Code sessions, one tmux
 * window each, and record them in the roster.
 */

import path from 'node:path';

import { findStartedSession, readSessionRegistry } from './registry.js';
import { checkCrossSessionInbound, evaluateResourceGate, readSettingsView } from './preflight.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { hasSession, listWindows, paneInfo, startWindow } from './tmux.js';
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

  const session = HIERARCHY_TMUX_SESSION;
  const sessionExists = hasSession(deps.run, session);
  const liveWindows = new Set(sessionExists ? listWindows(deps.run, session) : []);
  const warnings: string[] = [];

  // Drop roster entries whose window is gone; they are restarted below if planned.
  const { roster: loaded, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) warnings.push(`${r}; not touched`);
  const kept = loaded.sessions.filter((e) => liveWindows.has(e.tmuxWindow));
  for (const e of loaded.sessions) {
    if (!liveWindows.has(e.tmuxWindow)) {
      warnings.push(`roster entry '${e.name}' had no live window and was dropped`);
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
    } else if (liveWindows.has(s.name)) {
      warnings.push(
        `window '${s.name}' exists but is not in the roster; leaving it alone and not starting a duplicate`,
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
  let sessionNowExists = sessionExists;
  for (const s of toStart) {
    const spawnedAt = deps.now();
    const result = startWindow(
      deps.run,
      session,
      s.name,
      buildClaudeCommand(deps.claudeBin, s),
      deps.cwd,
      sessionNowExists,
    );
    if (result.status !== 0) {
      writeRoster(deps.boardDir, roster);
      throw new Error(
        `could not start '${s.name}': ${result.stderr.trim() || 'tmux failed'} (${started.length} session(s) started before the failure)`,
      );
    }
    sessionNowExists = true;
    const pane = paneInfo(deps.run, session, s.name);
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
      tmuxSession: session,
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
  }
  for (const e of existing)
    deps.log(`already running ${e.role} '${e.tmuxWindow}' (window left alone)`);
  for (const w of warnings) deps.log(`warning: ${w}`);

  if (opts.attach) deps.attach(session);
  return { started, existing, warnings };
}
