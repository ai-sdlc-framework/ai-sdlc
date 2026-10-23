/**
 * `cli-hierarchy executor-start`: everything an executor does before it has a
 * task, in one deterministic call that costs no model calls while it waits.
 *
 *  1. Identify the session: the nearest ancestor process that is a running,
 *     claude-process roster entry, and it must be an executor. The name is used
 *     exactly as the roster has it.
 *  2. Check the working directory is the repository of the roster's project.
 *  3. When the board is held (`cli-hierarchy hold`), print the reason and claim nothing.
 *     Otherwise claim the next eligible task under that name, once and without waiting: the
 *     hierarchy hooks module wakes an idle executor on an enqueue message (RFC-0058, AISDLC-1034).
 *     The board claim is the authority (RFC-0051): no sender flag and no start token.
 *  4. Write `inflight/<task>.state.json` naming the worker, before returning and so
 *     before any model call: the lease-push hook binds an executor to its task by
 *     that heartbeat, so it must hold from the first push. A write failure throws.
 *  5. Run the lease-push preflight (AISDLC-798) on the new claim and print what the
 *     PreToolUse hook would refuse later (missing launch env, a second claim, a missing
 *     heartbeat), so a misconfigured executor is caught at claim time.
 *
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now } from '../clock.js';
import { writeHeartbeat } from '../dispatch/board.js';
import { claimWithWait } from '../dispatch/claim-wait.js';
import { formatResumeFeedback } from '../dispatch/resume.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { resolveCaller, type IdentityDeps } from './caller-identity.js';
import { claimPreflight, type LeasePreflight } from './lease-preflight.js';
import { readHold } from './hold.js';
import { readModuleHealth } from './module-health.js';
import { checkRepoMatch, rosterProject } from './peer-guard.js';
import { readRosterChecked } from './roster.js';
import type { GitRunner } from './trusted-root.js';

/** Seconds an idle executor hibernates when it cannot clear itself (`emptyQueueHibernateSec`). */
export const DEFAULT_EMPTY_QUEUE_HIBERNATE_SEC = 1800;

/** Inputs of {@link executorStart}. */
export interface ExecutorStartOptions {
  boardDir: string;
  cwd: string;
  /** `--wait <sec>`: refused (AISDLC-1065) unless this session has a loaded hooks-module heartbeat. */
  waitSec?: number;
}

/** A second idle `executor-start` inside this window, with no new enqueue, is a repeat. */
export const REPEAT_WINDOW_MS = 60_000;

function queueSignature(boardDir: string): string {
  try {
    return readdirSync(path.join(boardDir, 'queue')).sort().join('|');
  } catch {
    return '';
  }
}

function startsFile(boardDir: string, name: string): string {
  return path.join(boardDir, 'starts', `${name}.json`);
}

function lastIdleStart(boardDir: string, name: string): { at: number; queue: string } | undefined {
  try {
    const r = JSON.parse(readFileSync(startsFile(boardDir, name), 'utf8')) as {
      at?: unknown;
      queue?: unknown;
    };
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (Number.isNaN(at) || typeof r.queue !== 'string') return undefined;
    return { at, queue: r.queue };
  } catch {
    return undefined;
  }
}

function recordStart(boardDir: string, name: string, idle: boolean, queue: string): void {
  try {
    mkdirSync(path.join(boardDir, 'starts'), { recursive: true });
    writeFileSync(
      startsFile(boardDir, name),
      JSON.stringify(idle ? { at: now().toISOString(), queue } : {}),
    );
  } catch {
    // The guard is advisory: a write failure must never block a claim.
  }
}

/** Collaborators; every one is replaceable in tests. */
export interface ExecutorStartDeps {
  identity: IdentityDeps;
  repoGit?: GitRunner;
  /** Replaces the claim (tests). */
  claim?: typeof claimWithWait;
  /** Replaces the heartbeat write (tests). */
  heartbeat?: typeof writeHeartbeat;
  /** Replaces the lease-push preflight (tests). */
  preflight?: typeof claimPreflight;
  /** The session env the hook would see (default process.env). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** What {@link executorStart} found. */
export interface ExecutorStartResult {
  name: string;
  project: string;
  /** The dispatch session's roster name, or '' when there is none. */
  dispatch: string;
  /** The claimed task, or null when nothing is eligible or the board is held. */
  taskId: string | null;
  /** The hold reason when the board is held (AISDLC-899); nothing was claimed. */
  held?: string;
  /** True when this idle session called again within a minute with no new enqueue (AISDLC-1065). */
  repeat?: boolean;
  manifest?: DispatchManifest;
  /** The lease-push preflight of the claim; absent when nothing was claimed. */
  leasePreflight?: LeasePreflight;
}

/**
 * @throws when this session is not a running executor of the roster, the roster
 *   is unusable, or the working directory is not the project's repository.
 */
export async function executorStart(
  opts: ExecutorStartOptions,
  deps: ExecutorStartDeps,
): Promise<ExecutorStartResult> {
  const self = resolveCaller(deps.identity);
  if (!self || self.role !== 'executor') {
    throw new Error('this session is not a running executor in the roster');
  }
  if (opts.waitSec !== undefined && opts.waitSec > 0) {
    const health = readModuleHealth(opts.boardDir, { name: self.name, role: self.role }, now());
    if (health.state !== 'loaded') {
      throw new Error(
        `--wait ${opts.waitSec} refused: this session has no hooks-module heartbeat, and waiting in a model turn is pure cost; end the turn with '[executor] idle' (AISDLC-1065)`,
      );
    }
  }
  const { roster } = readRosterChecked(opts.boardDir);
  const dispatch =
    roster.sessions.find((s) => s.role === 'operator-dispatch' && s.status === 'running')?.name ??
    '';
  const project = rosterProject(roster.sessions);
  if (!project.ok) throw new Error(project.reason);
  const repo = checkRepoMatch({
    cwd: opts.cwd,
    boardDir: opts.boardDir,
    project: project.project,
    ...(deps.repoGit ? { git: deps.repoGit } : {}),
  });
  if (!repo.ok) throw new Error(repo.reason);
  // The identity line is how `cli-hierarchy clear` sees an executor report back.
  deps.log?.(
    `[executor] I am '${self.name}' (project '${project.project}'); dispatch session is '${dispatch || 'none'}'`,
  );
  const queue = queueSignature(opts.boardDir);
  const last = lastIdleStart(opts.boardDir, self.name);
  if (last && now().getTime() - last.at < REPEAT_WINDOW_MS && last.queue === queue) {
    deps.log?.('[executor] already idle; stop the turn');
    return { name: self.name, project: project.project, dispatch, taskId: null, repeat: true };
  }
  const hold = readHold(opts.boardDir);
  if (hold) {
    recordStart(opts.boardDir, self.name, true, queue);
    deps.log?.(`[executor] BOARD HELD: ${hold.reason} (since ${hold.since}); not claiming.`);
    return { name: self.name, project: project.project, dispatch, taskId: null, held: hold.reason };
  }
  const result = await (deps.claim ?? claimWithWait)(opts.boardDir, 'in-session-agent', {
    waitSec: 0,
    workerId: self.name,
  });
  // A resumed task (AISDLC-738) carries a feedback note: surface it before the
  // executor runs the task, ahead of the final JSON line.
  if (result.claimed && result.manifest?.resume) {
    deps.log?.(
      `[executor] RESUMED TASK ${result.manifest.taskId} - feedback to address:\n${formatResumeFeedback(result.manifest.resume)}`,
    );
  }
  if (result.claimed && result.manifest) {
    const stamp = now().toISOString();
    try {
      (deps.heartbeat ?? writeHeartbeat)(opts.boardDir, {
        taskId: result.manifest.taskId,
        workerId: self.name,
        workerKind: 'in-session-agent',
        currentStep: 'claimed',
        startedAt: stamp,
        lastHeartbeat: stamp,
      });
    } catch (err) {
      throw new Error(
        `claimed ${result.manifest.taskId} but could not write its inflight heartbeat (the lease-push hook binds this session to the task by it): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  recordStart(opts.boardDir, self.name, !(result.claimed && result.manifest), queue);
  let leasePreflight: LeasePreflight | undefined;
  if (result.claimed && result.manifest) {
    leasePreflight = (deps.preflight ?? claimPreflight)(
      opts.boardDir,
      result.manifest.taskId,
      deps.env ?? process.env,
      [opts.cwd],
    );
    deps.log?.(`[executor] ${leasePreflight.message}`);
  }
  return {
    name: self.name,
    project: project.project,
    dispatch,
    taskId: result.claimed && result.manifest ? result.manifest.taskId : null,
    ...(result.claimed && result.manifest ? { manifest: result.manifest } : {}),
    ...(leasePreflight ? { leasePreflight } : {}),
  };
}
