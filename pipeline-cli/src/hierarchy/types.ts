/**
 * Types shared by the session-hierarchy bootstrap (`cli-hierarchy`).
 *
 * Roster schema: spec/schemas/hierarchy-roster.v1.schema.json
 */

import type { EventEmitter } from './emit.js';

/** Tier a session belongs to. */
export type HierarchyRole = 'planner' | 'operator-dispatch' | 'executor';

/** Lifecycle of a roster entry. */
export type RosterStatus = 'starting' | 'running';

/** One started session. Matches the roster schema's `session` definition. */
export interface RosterEntry {
  role: HierarchyRole;
  /**
   * Project the session belongs to (the repository basename unless `--project` was
   * given). Absent only in rosters written before project scoping; the reader fills
   * it in with the repository basename.
   */
  project?: string;
  name: string;
  tmuxSession: string;
  tmuxWindow: string;
  paneId: string;
  pid: number;
  model: string;
  permissionMode: string;
  startedAt: string;
  status: RosterStatus;
}

/** Contents of `.ai-sdlc/dispatch/hierarchy.json`. */
export interface Roster {
  schemaVersion: 'v1';
  sessions: RosterEntry[];
}

/** Result of one external command. */
export interface CommandResult {
  /** Exit status, or null when the process could not be spawned or was signalled. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Injectable command runner. Every tmux and `claude` invocation goes through
 * one, so tests never touch a real tmux server or start a real session.
 * Arguments are passed as an argv array and are never interpreted by a shell.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => CommandResult;

/**
 * A command runner that waits for the process asynchronously. Used for commands
 * that can run for a long time and must be killed as a whole process group.
 */
export type AsyncCommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

/** Entry of the harness session registry (one JSON file per live session). */
export interface RegistrySession {
  pid: number;
  name: string;
  /** Epoch milliseconds the session started. */
  startedAt: number;
  /** Harness-reported state, typically `busy` or `idle`. */
  status: string;
  cwd?: string;
}

/** A point-in-time view of machine headroom used by the resource gate. */
export interface ResourceSnapshot {
  /** Available memory in bytes, or null when it cannot be measured. */
  availableBytes: number | null;
  loadAvg1: number;
  cpus: number;
}

/** Everything the bootstrap needs from the outside world, injected for tests. */
export interface HierarchyDeps {
  /** Runs tmux and the `claude` command line. */
  run: CommandRunner;
  /** Directory of the dispatch board (holds the roster and `inflight/`). */
  boardDir: string;
  /** Working directory the sessions start in (the repository root). */
  cwd: string;
  /** Directory of the harness session registry. */
  registryDir: string;
  /** Settings files in precedence order, lowest first. */
  settingsFiles: readonly string[];
  /** Settings file named in the instructions when the inbound setting is missing. */
  userSettingsFile: string;
  /** Machine headroom probe for the resource gate. */
  resources: () => ResourceSnapshot;
  /** Environment (for the resource gate override). */
  env: NodeJS.ProcessEnv;
  /** Clock. */
  now: () => Date;
  /** Delay between registry polls. */
  sleep: (ms: number) => Promise<void>;
  /** Writes one line of user-facing output. */
  log: (line: string) => void;
  /**
   * Runs one interactive tmux command with the terminal's stdio inherited
   * (`attach-session` or `switch-client`); `args` is the tmux argv, for example
   * `['attach-session', '-t', '=planner']`. Returns the exit code.
   */
  attach: (args: readonly string[]) => number;
  /** Name of the `claude` executable. */
  claudeBin: string;
  /** Poll attempts and spacing when waiting for the registry or for a window to close. */
  pollAttempts: number;
  pollIntervalMs: number;
  /** Liveness probe for a pid, used by the cross-project collision check. Absent: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Records orchestrator events (session started, context cleared). Absent: nothing is recorded. */
  emit?: EventEmitter;
}

/**
 * Name of the single tmux session that hosted every hierarchy window in the old
 * layout. New rosters use one session per agent; this name is kept only so rosters
 * written by the old layout can still be stopped, inspected and attached.
 */
export const HIERARCHY_TMUX_SESSION = 'ai-sdlc-hierarchy';
