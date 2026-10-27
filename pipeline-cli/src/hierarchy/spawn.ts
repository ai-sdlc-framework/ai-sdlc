/**
 * `cli-hierarchy spawn <task-id>` (RFC-0059): one tmux session and one dynamic roster entry for
 * one task. The name is a pure function of the task id and is validated before any shell or
 * tmux call. A name that is already live is a no-op that reports the live session, so a
 * repeated tick never double-spawns. The session is the interactive `claude` (never `claude -p`)
 * with `AI_SDLC_EXECUTOR_TASK=<id>` in its environment, so `executor-start` claims that task only.
 */

import { existsSync } from 'node:fs';

import { manifestPathIn } from '../dispatch/board.js';
import { readNvmrc } from './node-pin.js';
import { rosterProject } from './peer-guard.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { hasSession } from './tmux.js';
import type { HierarchyDeps, RosterEntry } from './types.js';
import { launchSession, ROLE_PROMPT } from './up.js';
import { assertModel, assertProject, sanitizeProject, spawnedExecutorName } from './validate.js';
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
  if (hasSession(deps.run, name)) {
    throw new Error(
      `tmux session '${name}' exists but is not in the roster; refusing to start a duplicate`,
    );
  }
  if (existsSync(manifestPathIn(deps.boardDir, 'inflight', taskId))) {
    throw new Error(
      `${taskId} is already claimed (inflight); refusing to spawn an executor for it`,
    );
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
    },
    project,
    deps,
    new Set(roster.sessions.map((s) => s.name)),
    warnings,
    readNvmrc(deps.cwd),
  );
  if ('failure' in launched) throw new Error(launched.failure);

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
