/**
 * `cli-hierarchy clear <executor-name>`: empty an executor's context between
 * tasks.
 *
 * The dispatch session sends `/clear` to the executor's tmux pane, polls until the
 * cleared prompt is idle, then types `/ai-sdlc executor` and polls until the executor
 * prints its identity line, each wait bounded by one ceiling (AISDLC-1000). `/clear` keeps the session's name and permission mode and fires the
 * plugin's SessionStart hook, which re-injects the role from the roster.
 *
 * Safety:
 *  - The executor must be a running roster entry with the executor role; its
 *    name, window and pane id are validated before any tmux call.
 *  - An executor that holds an inflight manifest is never cleared: that would
 *    destroy the context of work in progress.
 *  - Keys go only to the pane the roster names, and only when tmux confirms the
 *    pane still belongs to the executor's window.
 *
 * After the resume command is typed the pane is read: while the input line still holds
 * it, `Enter` is sent again (at most twice, 2 s apart); if it still holds it, `Escape` and
 * one retype follow (AISDLC-1029). A clear is then either confirmed (identity line seen) or
 * fails with `ok: false` and reason `resume command not submitted`, plus the last pane line.
 *
 * The `hierarchy.clear` capability is `live` when the executor reported back within the
 * ceiling; otherwise the failure reason is recorded against it.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { reportCapabilityOutcome } from '@ai-sdlc/reference';

import { now } from '../clock.js';
import { readInflightManifest } from '../dispatch/board.js';
import type { EventEmitter } from './emit.js';
import { listInflight } from './inflight.js';
import { writeStartToken } from './start-token.js';
import { readRosterChecked, unsafeEntryReason } from './roster.js';
import { listWindows, ownershipRefusal, resolveSendTarget } from './tmux.js';
import type { CommandRunner, RosterEntry } from './types.js';

/** Capability id for the executor context clear. */
export const HIERARCHY_CLEAR_CAPABILITY = 'hierarchy.clear';

/**
 * Default ceiling, in milliseconds, for each of the two waits (cleared prompt, then identity
 * line). Overridable in `.ai-sdlc/pr-lifecycle.yaml` (`clear.handshakeCeilingMs`) or `--settle-ms`.
 */
export const DEFAULT_SETTLE_MS = 30_000;
/** Default spacing of the "did the executor report back" polls. */
export const DEFAULT_POLL_INTERVAL_MS = 500;
/** Spacing of the re-sent `Enter` presses while the input line still holds the resume command. */
export const SUBMIT_RETRY_SPACING_MS = 2000;
/** Failure reason of a clear whose resume command never started the session. */
export const RESUME_NOT_SUBMITTED = 'resume command not submitted';

const EXECUTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_ID_RE = /^%[0-9]+$/;

/** Collaborators of {@link clearExecutor}; every one is injected in tests. */
export interface ClearDeps {
  run: CommandRunner;
  boardDir: string;
  sleep: (ms: number) => Promise<void>;
  /** Records the `ExecutorContextCleared` event. */
  emit?: EventEmitter;
  /** Where capability state is written; default is `$ARTIFACTS_DIR`, else beside the board. */
  artifactsDir?: string;
  log?: (line: string) => void;
}

/** Inputs of {@link clearExecutor}. */
export interface ClearOptions {
  /** Roster name of the executor. */
  executor: string;
  /** Ceiling for each of the two waits (cleared prompt, identity line); default {@link DEFAULT_SETTLE_MS}. */
  settleMs?: number;
  pollIntervalMs?: number;
  /** Task whose verdict triggered the clear; recorded on the event. */
  taskId?: string;
  /** Roster name of the dispatch session doing the clear; recorded as the event's worker. */
  workerId?: string;
}

/** What a clear did. */
export interface ClearResult {
  executor: string;
  paneId: string;
  /** The clear restarted the session; false means it failed, and `reason` says why. */
  ok: boolean;
  /** The executor reported back within the ceiling (same as `ok`). */
  resumed: boolean;
  settleMs: number;
  /** Set when `ok` is false: {@link RESUME_NOT_SUBMITTED}. */
  reason?: string;
  /** Last non-empty pane line seen while waiting; set when the clear failed. */
  lastLine?: string;
}

function artifactsDirFor(boardDir: string, override?: string): string {
  if (override !== undefined) return override;
  return process.env.ARTIFACTS_DIR ?? path.join(path.dirname(path.resolve(boardDir)), 'artifacts');
}

/** The line the executor prints when its loop (re)starts; the report-back signal. */
function reportBackMarker(name: string): string {
  return `[executor] I am '${name}'`;
}

// The real invocation carries `--wait`; a bare mention of the command does not count.
const EXECUTOR_START_MARKER = /cli-hierarchy\.mjs"?\s+executor-start\b[^\n]*--wait\b/g;

/** How many times the marker is visible in the pane right now (0 when the pane cannot be read). */
function countMarker(run: CommandRunner, target: string, name: string): number {
  const r = run('tmux', ['capture-pane', '-p', '-t', target]);
  if (r.status !== 0) return 0;
  // A restarted executor shows its identity line, or the `executor-start` call it is
  // blocked in (that call prints nothing until it returns).
  return (
    r.stdout.split(reportBackMarker(name)).length -
    1 +
    (r.stdout.match(EXECUTOR_START_MARKER)?.length ?? 0)
  );
}

/** Text of the pane, or undefined when it cannot be read. */
function readPane(run: CommandRunner, target: string): string | undefined {
  const r = run('tmux', ['capture-pane', '-p', '-t', target]);
  return r.status === 0 ? r.stdout : undefined;
}

function lastLineOf(text: string | undefined): string {
  const lines = (text ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines.length ? lines[lines.length - 1].trim() : '';
}

const PROMPT_LINE_RE = /^(?:\s|\||│)*(?:>|❯)\s?(.*?)(?:\s|\||│)*$/;

/**
 * True when the pane's input line still holds `command`: the lowest prompt line among the
 * last ten non-empty lines decides; with no prompt line there, the last non-empty line does.
 */
export function inputLineHolds(pane: string | undefined, command: string): boolean {
  const tail = (pane ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-10);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = PROMPT_LINE_RE.exec(tail[i]);
    if (m) return m[1].trim() === command;
  }
  const last = tail[tail.length - 1];
  return last !== undefined && last.replace(/^(?:\s|\||│)+|(?:\s|\||│)+$/g, '') === command;
}

/** The task the named session holds inflight, or undefined. */
export function holdsInflight(boardDir: string, name: string): string | undefined {
  for (const item of listInflight(boardDir)) {
    if (item.workerId === name || readInflightManifest(boardDir, item.taskId)?.workerId === name) {
      return item.taskId;
    }
  }
  return undefined;
}

function type(run: CommandRunner, target: string, text: string): string | undefined {
  const typed = run('tmux', ['send-keys', '-t', target, '-l', '--', text]);
  if (typed.status !== 0) return typed.stderr.trim() || 'tmux send-keys failed';
  const sent = run('tmux', ['send-keys', '-t', target, 'Enter']);
  if (sent.status !== 0) return sent.stderr.trim() || 'tmux send-keys failed';
  return undefined;
}

/**
 * Type `command` and make sure the session took it: while the input line still holds it,
 * send `Enter` again (at most twice, 2 s apart), then `Escape` and one retype. Returns an
 * error text only when a keystroke could not be sent.
 */
async function typeAndSubmit(
  deps: ClearDeps,
  target: string,
  command: string,
  firstCheckMs: number,
): Promise<string | undefined> {
  const failure = type(deps.run, target, command);
  if (failure) return failure;
  const holds = () => inputLineHolds(readPane(deps.run, target), command);
  await deps.sleep(firstCheckMs);
  if (!holds()) return undefined;
  for (let i = 0; i < 2; i++) {
    const sent = deps.run('tmux', ['send-keys', '-t', target, 'Enter']);
    if (sent.status !== 0) return sent.stderr.trim() || 'tmux send-keys failed';
    await deps.sleep(SUBMIT_RETRY_SPACING_MS);
    if (!holds()) return undefined;
  }
  deps.run('tmux', ['send-keys', '-t', target, 'Escape']);
  deps.run('tmux', ['send-keys', '-t', target, 'C-u']);
  const retried = type(deps.run, target, command);
  if (retried) return retried;
  await deps.sleep(SUBMIT_RETRY_SPACING_MS);
  return undefined;
}

function reportClear(deps: ClearDeps, outcome: 'live' | 'degraded', reason?: string): void {
  reportCapabilityOutcome(HIERARCHY_CLEAR_CAPABILITY, outcome, {
    artifactsDir: artifactsDirFor(deps.boardDir, deps.artifactsDir),
    ...(reason !== undefined ? { reason } : {}),
  });
}

/**
 * Clear an executor's context and restart its loop.
 * @throws, sending nothing, when the name or pane id is invalid, the executor is
 *   not a running roster executor, its window is not open, or it holds an
 *   inflight manifest. Throws after the first keystroke when a send fails.
 */
export async function clearExecutor(opts: ClearOptions, deps: ClearDeps): Promise<ClearResult> {
  const name = opts.executor;
  if (typeof name !== 'string' || !EXECUTOR_NAME_RE.test(name)) {
    throw new Error(`'${String(name)}' is not a valid executor name`);
  }
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(settleMs) || settleMs < 0) {
    throw new Error('the settle time must be a whole number of milliseconds');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('the poll interval must be a positive whole number of milliseconds');
  }

  const { roster } = readRosterChecked(deps.boardDir);
  const entry: RosterEntry | undefined = roster.sessions.find(
    (e) => e.name === name && e.role === 'executor',
  );
  if (!entry) throw new Error(`'${name}' is not an executor in the roster`);
  if (entry.status !== 'running') {
    throw new Error(`executor '${name}' is not running (status ${entry.status})`);
  }
  const unsafe = unsafeEntryReason(entry);
  if (unsafe) throw new Error(`refusing to clear '${name}': it ${unsafe}`);
  if (!PANE_ID_RE.test(entry.paneId)) {
    throw new Error(`refusing to clear '${name}': the roster has no valid pane id`);
  }
  const held = holdsInflight(deps.boardDir, name);
  if (held) {
    throw new Error(`refusing to clear '${name}': it holds ${held}, which is still inflight`);
  }
  // A session of the one-session-per-agent layout is typed into only when
  // `cli-hierarchy up` marked it as its own; a personal session that happens to
  // share the name is never touched.
  const unowned = ownershipRefusal(deps.run, entry);
  if (unowned) throw new Error(`refusing to clear '${name}': ${unowned}`);
  if (!listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow)) {
    throw new Error(`the window for '${name}' is not open; start it with cli-hierarchy up`);
  }

  const target = resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);
  const before = countMarker(deps.run, target, name);

  const clearFailure = type(deps.run, target, '/clear');
  if (clearFailure) {
    reportClear(deps, 'degraded', `could not send /clear to '${name}': ${clearFailure}`);
    throw new Error(`could not send /clear to '${name}': ${clearFailure}`);
  }
  // Wait for the cleared prompt: the pane shows no running turn and is unchanged across two
  // polls. A pane that never settles within the ceiling does not stop the restart command.
  const polls = Math.max(1, Math.ceil(settleMs / pollIntervalMs));
  let prev = readPane(deps.run, target);
  for (let i = 0; i < polls; i++) {
    await deps.sleep(pollIntervalMs);
    const cur = readPane(deps.run, target);
    const settled = cur !== undefined && cur === prev && !cur.includes('esc to interrupt');
    prev = cur;
    if (settled) break;
  }
  // A typed start has no harness envelope: leave the token executor-start consumes (AISDLC-1028).
  const issuer = roster.sessions.find(
    (e) => e.name === opts.workerId && e.role === 'operator-dispatch' && e.status === 'running',
  );
  if (issuer) {
    writeStartToken(deps.boardDir, name, {
      issuerPid: issuer.pid,
      issuerName: issuer.name,
      issuedAt: now().toISOString(),
    });
  }
  const restartFailure = await typeAndSubmit(deps, target, '/ai-sdlc executor', pollIntervalMs);
  if (restartFailure) {
    reportClear(deps, 'degraded', `could not restart '${name}': ${restartFailure}`);
    throw new Error(`could not send /ai-sdlc executor to '${name}': ${restartFailure}`);
  }

  // The executor reports back by printing its identity line again.
  let resumed = false;
  let lastLine = lastLineOf(prev);
  for (let i = 0; i < polls && !resumed; i++) {
    await deps.sleep(pollIntervalMs);
    resumed = countMarker(deps.run, target, name) > before;
    if (!resumed) lastLine = lastLineOf(readPane(deps.run, target)) || lastLine;
  }

  const reason = `${RESUME_NOT_SUBMITTED}: '${name}' did not report back within the ${settleMs} ms ceiling; last pane line: ${lastLine || '(none)'}`;
  if (resumed) reportClear(deps, 'live');
  else reportClear(deps, 'degraded', reason);
  deps.emit?.({
    type: 'ExecutorContextCleared',
    executor: name,
    paneId: entry.paneId,
    resumed,
    settleMs,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
  });
  deps.log?.(resumed ? `cleared '${name}'` : `clear of '${name}' failed: ${reason}`);
  return {
    executor: name,
    paneId: entry.paneId,
    ok: resumed,
    resumed,
    settleMs,
    ...(resumed ? {} : { reason: RESUME_NOT_SUBMITTED, lastLine }),
  };
}

/** After a clear is scheduled, further turns inside this window do not schedule another. */
export const AUTO_CLEAR_DEBOUNCE_MS = 120_000;

function stampFile(boardDir: string, name: string): string {
  return path.join(boardDir, 'handoff', `.auto-clear-${name}`);
}

/** True when a clear was scheduled for this session within the debounce window. */
export function recentlyScheduled(boardDir: string, name: string, nowMs: number): boolean {
  try {
    const f = stampFile(boardDir, name);
    return existsSync(f) && nowMs - statSync(f).mtimeMs < AUTO_CLEAR_DEBOUNCE_MS;
  } catch {
    return false;
  }
}

/** Record that a clear was scheduled now. */
export function markScheduled(boardDir: string, name: string): void {
  const f = stampFile(boardDir, name);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, '', 'utf-8');
}

/** Default wait before `/clear` is typed, so the calling turn can end first. */
export const SELF_CLEAR_LEAD_SECONDS = 20;
/** Default longest wait for the pane to become idle before each keystroke group. */
export const SELF_CLEAR_IDLE_TIMEOUT_SECONDS = 120;
/** Default longest wait for the session to start a turn after the resume command. */
export const SELF_CLEAR_COMEBACK_TIMEOUT_SECONDS = 60;
/** Default resume hold for the planner: it has no board to wait for, so only a short settle. */
export const PLANNER_RESUME_AFTER_SECONDS = 3;
/** Where a session that did not come back after a clear is recorded, under the board dir. */
export const AUTO_CLEAR_LOG = path.join('handoff', 'auto-clear.log');
/** The command the dispatch session re-issues after its own clear. */
export const DISPATCH_RESUME_COMMAND = '/ai-sdlc operator-dispatch';
/** The command an idle executor re-issues after its own clear. */
export const EXECUTOR_RESUME_COMMAND = '/ai-sdlc executor';
/** The command the planner re-issues after its own clear. */
export const PLANNER_RESUME_COMMAND = '/ai-sdlc:planner';

/** Starts a process that outlives the caller; injectable for tests. */
export type DetachedSpawner = (file: string, args: readonly string[]) => void;

/** Production spawner: argv only, no shell of ours, detached, output discarded. */
export const defaultSpawnDetached: DetachedSpawner = (file, args) => {
  const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
  child.unref();
};

/** Collaborators of {@link clearSelf}. */
export interface ClearSelfDeps {
  run: CommandRunner;
  boardDir: string;
  spawnDetached?: DetachedSpawner;
  log?: (line: string) => void;
}

/** Inputs of {@link clearSelf}. */
export interface ClearSelfOptions {
  /** Roster name of the calling session, already proven to be a session of `role`. */
  self: string;
  /** Role of the calling session (default the dispatch session). */
  role?: 'operator-dispatch' | 'executor' | 'planner';
  /**
   * Optional seconds to hold the resume command after `/clear` (dispatch uses it as a
   * wake-on-board upper bound). Default 0 (the resume command is typed as soon as the
   * pane is idle after `/clear`), except the planner, which defaults to 3.
   */
  resumeAfterSeconds?: number;
  /** Longest wait for an idle pane before typing (default 120). */
  idleTimeoutSeconds?: number;
  /** Longest wait for the session to start a turn after the resume command (default 60). */
  comebackTimeoutSeconds?: number;
  /** Seconds before `/clear` is typed (default 20). */
  leadSeconds?: number;
  /** The `TMUX_PANE` of the calling process; when set it must equal the roster pane. */
  callerPane?: string;
  /**
   * Board directory to watch. When set, the resume command is typed as soon as a file
   * newer than this call appears in `briefs/`, `done/` or `failed/`, instead of after
   * the full resume delay (which then acts as the upper bound).
   */
  wakeOnBoardDir?: string;
}

/** What {@link clearSelf} scheduled. */
export interface ClearSelfResult {
  self: string;
  paneId: string;
  leadSeconds: number;
  resumeAfterSeconds: number;
}

/**
 * Schedule the dispatch session, the planner or an idle executor to clear its own context and resume its loop.
 * Only the pane the calling session's own roster entry names is ever typed into.
 * The keystrokes are delivered by a detached process after a lead delay, because
 * `/clear` typed while this turn runs would only be queued behind it.
 * @throws, scheduling nothing, when the entry is not a running dispatch session,
 *   its pane or window cannot be confirmed, or `TMUX_PANE` names another pane.
 */
export function clearSelf(opts: ClearSelfOptions, deps: ClearSelfDeps): ClearSelfResult {
  const name = opts.self;
  if (typeof name !== 'string' || !EXECUTOR_NAME_RE.test(name)) {
    throw new Error(`'${String(name)}' is not a valid session name`);
  }
  const resumeAfterSeconds =
    opts.resumeAfterSeconds ?? (opts.role === 'planner' ? PLANNER_RESUME_AFTER_SECONDS : 0);
  const idleTimeoutSeconds = opts.idleTimeoutSeconds ?? SELF_CLEAR_IDLE_TIMEOUT_SECONDS;
  const comebackTimeoutSeconds = opts.comebackTimeoutSeconds ?? SELF_CLEAR_COMEBACK_TIMEOUT_SECONDS;
  const leadSeconds = opts.leadSeconds ?? SELF_CLEAR_LEAD_SECONDS;
  for (const [label, v] of [
    ['resume delay', resumeAfterSeconds],
    ['lead delay', leadSeconds],
    ['idle timeout', idleTimeoutSeconds],
    ['comeback timeout', comebackTimeoutSeconds],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 3600) {
      throw new Error(`the ${label} must be a whole number of seconds from 0 to 3600`);
    }
  }
  const { roster } = readRosterChecked(deps.boardDir);
  const role = opts.role ?? 'operator-dispatch';
  const entry = roster.sessions.find((e) => e.name === name && e.role === role);
  if (!entry) {
    throw new Error(
      `'${name}' is not ${role === 'executor' ? 'an executor' : role === 'planner' ? 'the planner' : 'the dispatch session'} in the roster`,
    );
  }
  if (entry.status !== 'running') {
    throw new Error(`'${name}' is not running (status ${entry.status})`);
  }
  const unsafe = unsafeEntryReason(entry);
  if (unsafe) throw new Error(`refusing to clear '${name}': it ${unsafe}`);
  if (!PANE_ID_RE.test(entry.paneId)) {
    throw new Error(`refusing to clear '${name}': the roster has no valid pane id`);
  }
  if (opts.callerPane !== undefined && opts.callerPane !== '' && opts.callerPane !== entry.paneId) {
    throw new Error(
      `refusing to clear '${name}': TMUX_PANE ${opts.callerPane} is not the roster pane ${entry.paneId}`,
    );
  }
  if (role === 'executor') {
    const held = holdsInflight(deps.boardDir, name);
    if (held) {
      throw new Error(`refusing to clear '${name}': it holds ${held}, which is still inflight`);
    }
  }
  const unowned = ownershipRefusal(deps.run, entry);
  if (unowned) throw new Error(`refusing to clear '${name}': ${unowned}`);
  if (!listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow)) {
    throw new Error(`the window for '${name}' is not open`);
  }
  const target = resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);

  const watchDir = opts.wakeOnBoardDir;
  // Every value is passed as an argument, never interpolated into the script. The marker
  // is made before the lead delay, so a file written while this turn ends still wakes us.
  // Positional arguments: 1 lead, 2 pane, 3 /clear, 4 resume hold, 5 resume command,
  // 6 board to watch ('' for none), 7 log file, 8 session name, 9 idle timeout,
  // 10 comeback timeout. Polls run every 0.5 s.
  const script = [
    // functions see their own $1, so every argument is copied to a named variable first
    'lead=$1; pane=$2; clr=$3; hold=$4; cmd=$5; watch=$6; logf=$7; who=$8; idlet=$9; backt=${10}',
    '[ -n "$watch" ] && { m=$(mktemp) || exit 1; }',
    'log() { mkdir -p "$(dirname "$logf")"; printf "%s %s: %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$who" "$1" >> "$logf"; }',
    // idle: the pane text is unchanged across two polls and shows no running turn
    'idle() { n=0; prev=; st=0; while [ "$n" -lt $(( idlet * 2 )) ]; do ' +
      'cur=$(tmux capture-pane -p -t "$pane" 2>/dev/null) || return 1; ' +
      'if [ "$cur" = "$prev" ] && ! printf "%s" "$cur" | grep -q "esc to interrupt"; ' +
      'then st=$((st+1)); [ "$st" -ge 2 ] && return 0; else st=0; fi; ' +
      'prev=$cur; sleep 0.5; n=$((n+1)); done; return 1; }',
    // type: empty the input line first so nothing is appended to text already there
    'type() { tmux send-keys -t "$pane" C-u; tmux send-keys -t "$pane" -l -- "$1"; tmux send-keys -t "$pane" Enter; }',
    // holds: the input line (lowest prompt line of the last ten non-empty lines) still has the command
    'holds() { tmux capture-pane -p -t "$pane" 2>/dev/null | awk -v cmd="$1" \'NF{l[++n]=$0} END{' +
      'for(i=n;i>0&&i>n-10;i--){s=l[i]; if(s ~ /^( |[|]|│)*(>|❯)/){sub(/^( |[|]|│)*(>|❯) ?/,"",s); sub(/( |[|]|│)*$/,"",s); exit (s==cmd)?0:1}} ' +
      's=l[n]; sub(/^( |[|]|│)*/,"",s); sub(/( |[|]|│)*$/,"",s); exit (s==cmd)?0:1}\'; }',
    // submit: type the command; re-send Enter (twice, 2 s apart) while it sits in the input line, then Escape and one retype
    'submit() { type "$1"; sleep 1; holds "$1" || return 0; k=0; while [ "$k" -lt 2 ]; do ' +
      'tmux send-keys -t "$pane" Enter; sleep 2; holds "$1" || return 0; k=$((k+1)); done; ' +
      'tmux send-keys -t "$pane" Escape; type "$1"; sleep 2; holds "$1" || return 0; return 1; }',
    'sleep "$lead"',
    'idle || { log "pane never became idle; did not send: $clr then $cmd"; exit 0; }',
    'type "$clr"',
    'sleep 1',
    'if [ -n "$watch" ]; then sleep 5; i=0; while [ "$i" -lt "$hold" ]; do ' +
      'if [ -n "$(find "$watch/briefs" "$watch/done" "$watch/failed" -type f -newer "$m" 2>/dev/null | head -n 1)" ]; ' +
      'then break; fi; sleep 2; i=$((i+2)); done; rm -f "$m"; else sleep "$hold"; fi',
    'idle || { log "pane not idle after /clear; did not send: $cmd"; exit 0; }',
    'submit "$cmd" || { log "resume command not submitted; last pane line: $(tmux capture-pane -p -t "$pane" 2>/dev/null | grep . | tail -n 1)"; exit 0; }',
    'n=0; while [ "$n" -lt $(( backt * 2 )) ]; do ' +
      'tmux capture-pane -p -t "$pane" 2>/dev/null | grep -q "esc to interrupt" && exit 0; ' +
      'sleep 0.5; n=$((n+1)); done',
    'log "did not come back; command sent: $cmd"',
  ].join('\n');
  const logFile = path.join(deps.boardDir, AUTO_CLEAR_LOG);
  (deps.spawnDetached ?? defaultSpawnDetached)('sh', [
    '-c',
    script,
    'sh',
    String(leadSeconds),
    target,
    '/clear',
    String(resumeAfterSeconds),
    role === 'executor'
      ? EXECUTOR_RESUME_COMMAND
      : role === 'planner'
        ? PLANNER_RESUME_COMMAND
        : DISPATCH_RESUME_COMMAND,
    watchDir ?? '',
    logFile,
    name,
    String(idleTimeoutSeconds),
    String(comebackTimeoutSeconds),
  ]);
  // Any scheduled clear, manual or automatic, debounces the Stop hook for this session.
  markScheduled(deps.boardDir, name);
  deps.log?.(
    `scheduled '${name}' to clear in ${leadSeconds}s and resume as soon as the pane is idle`,
  );
  return { self: name, paneId: entry.paneId, leadSeconds, resumeAfterSeconds };
}
