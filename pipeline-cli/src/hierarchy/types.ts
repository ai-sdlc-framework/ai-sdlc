/**
 * Types shared by the session-hierarchy bootstrap (`cli-hierarchy`).
 *
 * Roster schema: spec/schemas/hierarchy-roster.v1.schema.json
 */

/** Tier a session belongs to. */
export type HierarchyRole = 'planner' | 'operator-dispatch' | 'executor';

/** Lifecycle of a roster entry. */
export type RosterStatus = 'starting' | 'running';

/** One started session. Matches the roster schema's `session` definition. */
export interface RosterEntry {
  role: HierarchyRole;
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
  /** Attaches the terminal to a tmux session; returns the exit code. */
  attach: (tmuxSession: string) => number;
  /** Name of the `claude` executable. */
  claudeBin: string;
  /** Poll attempts and spacing when waiting for the registry or for a window to close. */
  pollAttempts: number;
  pollIntervalMs: number;
}

/** Name of the tmux session that hosts every hierarchy window. */
export const HIERARCHY_TMUX_SESSION = 'ai-sdlc-hierarchy';
