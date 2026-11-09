/**
 * `cli-hierarchy spawn <task-id>` (RFC-0059): one tmux session and one dynamic roster entry for
 * one task. The name is a pure function of the task id and is validated before any shell or
 * tmux call. A name that is already live is a no-op that reports the live session, so a
 * repeated tick never double-spawns. The session is the interactive `claude` (never `claude -p`)
 * with `AI_SDLC_EXECUTOR_TASK=<id>` in its environment, so `executor-start` claims that task only.
 */

import { existsSync } from 'node:fs';

import { manifestPathIn } from '../dispatch/board.js';
import { installPaneExitHook } from './pane-exit.js';
import { readNvmrc } from './node-pin.js';
import { rosterProject } from './peer-guard.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { listInflight } from './inflight.js';
import { hasSession, killSession, listSessionNames, sessionBoardTag } from './tmux.js';
import type { HierarchyDeps, RosterEntry } from './types.js';
import { launchSession, resolveProfile, ROLE_PROMPT, withProfile } from './up.js';
import {
  assertModel,
  assertProject,
  isSpawnedExecutorName,
  sanitizeProject,
  spawnedExecutorName,
} from './validate.js';
import path from 'node:path';

/** Inputs of {@link hierarchySpawn}. */
export interface SpawnOptions {
  taskId: string;
  /** Executor model (default sonnet). */
  model?: string;
}

/** What {@link hierarchySpawn} did. */
export interface SpawnResult {
  name: string;
  taskId: string;
  /** False when the session was already live and nothing was created. */
  created: boolean;
  entry: RosterEntry;
  warnings: string[];
}

/**
 * @throws before any tmux or shell call when the task id or derived name is invalid; before
 *   creating anything when the task is already inflight or the roster is unusable.
 */
export async function hierarchySpawn(
  opts: SpawnOptions,
  deps: HierarchyDeps,
): Promise<SpawnResult> {
  const name = spawnedExecutorName(opts.taskId);
  const taskId = opts.taskId.toUpperCase();
  const model = opts.model ?? 'sonnet';
  assertModel(model, '--model');

  const { roster, rejected } = readRosterChecked(deps.boardDir);
  const warnings = rejected.map((r) => `${r}; not touched`);
  const existing = roster.sessions.find((s) => s.name === name || s.tmuxSession === name);
  if (existing && hasSession(deps.run, existing.tmuxSession)) {
    deps.log(`executor '${name}' for ${taskId} is already live; nothing created`);
    return { name, taskId, created: false, entry: existing, warnings };
  }
  if (existsSync(manifestPathIn(deps.boardDir, 'inflight', taskId))) {
    throw new Error(
      `${taskId} is already claimed (inflight); refusing to spawn an executor for it`,
    );
  }
  // AISDLC-1117: the roster is the authority. A session that carries the executor name but is
  // not in the roster (checked above) and holds no inflight task is an orphan: reclaim it.
  if (hasSession(deps.run, name)) {
    const tag = sessionBoardTag(deps.run, name);
    if (tag !== path.resolve(deps.boardDir)) {
      const reason = `tmux session '${name}' is not tagged for this board (found ${tag === undefined ? 'no AI_SDLC_BOARD_DIR tag' : `AI_SDLC_BOARD_DIR=${tag}`}); refusing to kill and reuse it`;
      deps.log(reason);
      return {
        name,
        taskId,
        created: false,
        entry: existing ?? foreignEntry(name, taskId),
        warnings: [...warnings, reason],
      };
    }
    killSession(deps.run, name);
    deps.log(`reclaimed orphaned tmux session '${name}' (not in the roster)`);
    warnings.push(`reclaimed orphaned tmux session '${name}'`);
  }

  const known = rosterProject(roster.sessions);
  const project = known.ok
    ? known.project
    : roster.sessions.length === 0
      ? sanitizeProject(path.basename(path.resolve(deps.cwd)))
      : '';
  if (!project) throw new Error(known.ok ? 'cannot derive a project name' : known.reason);
  assertProject(project);

  const launched = await launchSession(
    {
      role: 'executor',
      name,
      bare: name,
      model,
      permissionMode: 'bypassPermissions',
      prompt: ROLE_PROMPT.executor,
      taskId,
      ...withProfile(resolveProfile(deps, 'executor')),
    },
    project,
    deps,
    new Set(roster.sessions.map((s) => s.name)),
    warnings,
    readNvmrc(deps.cwd),
  );
  if ('failure' in launched) throw new Error(launched.failure);

  // AISDLC-1217: the pane's exit posts to dispatch at once.
  const hook = installPaneExitHook(deps.run, name, deps.binPath ?? process.argv[1] ?? '');
  if (hook.status !== 0) {
    warnings.push(
      `could not install the pane-exited hook on '${name}'; the stall check will find it`,
    );
  }
  const entry: RosterEntry = { ...launched.entry, taskId };
  // Re-read just before the write so a concurrent spawn's entry is not dropped.
  const fresh = readRosterChecked(deps.boardDir).roster;
  writeRoster(deps.boardDir, {
    schemaVersion: 'v1',
    sessions: [...fresh.sessions.filter((s) => s.name !== name), entry],
  });
  deps.log(`spawned executor '${name}' for ${taskId} model=${model}`);
  deps.log(`  show it with: cli-hierarchy attach ${name}`);
  return { name, taskId, created: true, entry, warnings };
}

/** Placeholder entry for a refused spawn that has no roster entry. */
function foreignEntry(name: string, taskId: string): RosterEntry {
  return {
    role: 'executor',
    project: '',
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '',
    pid: 0,
    model: '',
    permissionMode: 'bypassPermissions',
    startedAt: '',
    status: 'starting',
    taskId,
  };
}

/**
 * The tick's sweep (AISDLC-1117, AISDLC-1252): kill every tmux session that is named like a spawned
 * executor, is absent from the roster, holds no inflight task and is tagged with this board's dir.
 * Same-shaped sessions tagged for another board, or untagged, are skipped and logged.
 */
export function sweepOrphanExecutorSessions(deps: HierarchyDeps): {
  reaped: string[];
  skipped: string[];
} {
  const { roster } = readRosterChecked(deps.boardDir);
  const rostered = new Set(roster.sessions.flatMap((s) => [s.name, s.tmuxSession]));
  const holding = new Set(listInflight(deps.boardDir).map((i) => i.workerId));
  const board = path.resolve(deps.boardDir);
  const reaped: string[] = [];
  const skipped: string[] = [];
  for (const name of listSessionNames(deps.run)) {
    if (!isSpawnedExecutorName(name) || rostered.has(name) || holding.has(name)) continue;
    if (sessionBoardTag(deps.run, name) !== board) {
      skipped.push(name);
      deps.log(`skipped foreign executor session '${name}'`);
      continue;
    }
    if (killSession(deps.run, name).status === 0) {
      reaped.push(name);
      deps.log(`reaped orphaned tmux session '${name}' (not in the roster)`);
    }
  }
  return { reaped, skipped };
}

/** {@link sweepOrphanExecutorSessions}, returning the names reaped. */
export function reapOrphanExecutorSessions(deps: HierarchyDeps): string[] {
  return sweepOrphanExecutorSessions(deps).reaped;
}
