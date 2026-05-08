/**
 * Filter — Already-in-flight detection (AISDLC-227).
 *
 * Catches tasks that are already being processed by a concurrent pipeline run
 * so `cli-orchestrator tick` never dispatches a duplicate. Without this filter
 * every tick that races a slow-merging PR or a still-running dev subprocess
 * produces a duplicate dispatch — the witness was AISDLC-202.2 (PR #402 already
 * open, worktree already existed, `git worktree add` failed with "branch already
 * exists" and wasted ~30s of tick + setup overhead per attempt).
 *
 * Three detection signals (evaluated in order, short-circuit on first hit):
 *
 * (a) **Open PR** — `gh pr list --head ai-sdlc/<task-id-lower>-* --state open`
 *     returns ≥1 entry. This is the definitive signal: a PR already landed or
 *     is in review. Always enabled.
 *
 * (b) **Active-worktree sentinel** — `.worktrees/<task-id-lower>/.active-task`
 *     exists on disk. The pipeline writes this file in Step 4 (flip-status);
 *     its presence means a pipeline run is active right now. Always enabled.
 *
 * (c) **Live subprocess** — a `claude --print` or `claude -p` process with the
 *     task ID in its argv is running. Best-effort: uses `ps -ax -o pid,command`
 *     (Darwin + Linux portable). Enabled when
 *     `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS` is truthy or when the `opts`
 *     caller sets `detectSubprocess: true`. Silently skipped on parse errors.
 *
 * This filter runs AFTER OrphanParent (cheapest, most decisive) and BEFORE
 * DependencyReadiness (which is the next cheapest in-memory check). Signals (a)
 * and (b) are both O(1) local checks; signal (c) is a subprocess-table scan
 * that costs one `ps -ax` invocation shared across the tick loop.
 *
 * Chain order: OrphanParent → AlreadyInFlight → DependencyReadiness →
 * DorReadiness → ExternalDependencies → Blocked.
 *
 * @module orchestrator/filters/already-in-flight
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterResult } from './types.js';

/** Structured detail carried in the `OrchestratorTaskAlreadyInFlight` event. */
export interface AlreadyInFlightDetail {
  kind: 'already-in-flight';
  /** Which signal triggered the rejection. */
  signal: 'open-pr' | 'active-worktree' | 'live-subprocess';
  /** Human-readable description of the found signal (e.g. `PR #402`). */
  description: string;
  /** PR number when signal === 'open-pr'. */
  prNumber?: number;
  /** Worktree path when signal === 'active-worktree'. */
  worktreePath?: string;
  /** PID of the detected subprocess when signal === 'live-subprocess'. */
  subprocessPid?: number;
}

export interface CheckAlreadyInFlightOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Absolute path to the repo root. Used to resolve `.worktrees/` path for
   * signal (b). Defaults to `process.cwd()` when unset.
   */
  repoRoot?: string;
  /**
   * Whether to run the subprocess probe (signal c). When undefined the filter
   * reads `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS` — truthy values (`1`,
   * `true`, `yes`, `on`) enable it, falsy (or unset) skips it. Tests pass
   * `false` explicitly to stay hermetic. Tick + start modes pass `true` or
   * rely on the env var default (which is effectively ON when the env var is
   * not suppressed).
   */
  detectSubprocess?: boolean;
  /**
   * Injectable `gh pr list` runner — replaces the real `gh` call in tests.
   * Receives the branch head pattern; returns an array of `{number}` objects
   * (matching the `--json number` shape) or throws on error. When undefined
   * the filter invokes `gh pr list --head <pattern> --state open --json number`.
   */
  listOpenPRs?: (headPattern: string) => { number: number }[];
  /**
   * Injectable process-table scanner — replaces `ps -ax` in tests.
   * Returns the raw stdout string of `ps -ax -o pid,command` or throws.
   * When undefined the filter runs the real `ps` command.
   */
  readProcessTable?: () => string;
}

/**
 * Check whether the candidate task is already being processed by another run.
 *
 * Returns `{ filter: 'AlreadyInFlight', passed: false, reason, detail }` on
 * the first in-flight signal found; returns `{ ..., passed: true }` when no
 * signals fire.
 *
 * Async-free: all three probes are synchronous (gh via `execSync`, fs via
 * `existsSync`, ps via `execSync`). The orchestrator loop calls this inside a
 * synchronous filter chain — keeping it sync avoids wrapping the whole chain
 * in async.
 */
export function checkAlreadyInFlight(opts: CheckAlreadyInFlightOpts): FilterResult {
  const taskIdLower = opts.taskId.toLowerCase();
  const repoRoot = opts.repoRoot ?? process.cwd();

  // (a) Open PR check — `ai-sdlc/<task-id-lower>-*` head ref pattern.
  const headPattern = `ai-sdlc/${taskIdLower}-*`;
  try {
    const openPRs = opts.listOpenPRs ? opts.listOpenPRs(headPattern) : runGhPRList(headPattern);
    if (openPRs.length > 0) {
      const prNumber = openPRs[0].number;
      const detail: AlreadyInFlightDetail = {
        kind: 'already-in-flight',
        signal: 'open-pr',
        description: `PR #${prNumber} already open`,
        prNumber,
      };
      return {
        filter: 'AlreadyInFlight',
        passed: false,
        reason: `Already-in-flight check: failed (PR #${prNumber} open)`,
        detail,
      };
    }
  } catch {
    // gh not available or network error — skip this signal rather than
    // blocking dispatch on a transient infrastructure failure.
  }

  // (b) Active-worktree sentinel check.
  const worktreePath = join(repoRoot, '.worktrees', taskIdLower);
  const sentinelPath = join(worktreePath, '.active-task');
  if (existsSync(sentinelPath)) {
    const detail: AlreadyInFlightDetail = {
      kind: 'already-in-flight',
      signal: 'active-worktree',
      description: `active worktree sentinel at ${sentinelPath}`,
      worktreePath,
    };
    return {
      filter: 'AlreadyInFlight',
      passed: false,
      reason: `Already-in-flight check: failed (active worktree)`,
      detail,
    };
  }

  // (c) Live-subprocess probe (best-effort, portable, behind env flag).
  const shouldDetect = opts.detectSubprocess ?? isDetectSubprocessEnabled();
  if (shouldDetect) {
    try {
      const psOutput = opts.readProcessTable ? opts.readProcessTable() : runPsAx();
      const pid = findClaudeSubprocess(psOutput, opts.taskId);
      if (pid !== null) {
        const detail: AlreadyInFlightDetail = {
          kind: 'already-in-flight',
          signal: 'live-subprocess',
          description: `live claude --print subprocess for ${opts.taskId} (PID ${pid})`,
          subprocessPid: pid,
        };
        return {
          filter: 'AlreadyInFlight',
          passed: false,
          reason: `Already-in-flight check: failed (live subprocess PID ${pid})`,
          detail,
        };
      }
    } catch {
      // ps not available (unusual) or parse error — skip rather than block.
    }
  }

  return { filter: 'AlreadyInFlight', passed: true };
}

/**
 * Run `gh pr list` and return the matching open PRs.
 * Throws on non-zero exit (caller catches and skips).
 */
function runGhPRList(headPattern: string): { number: number }[] {
  const stdout = execSync(
    `gh pr list --head ${JSON.stringify(headPattern)} --state open --json number`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  if (stdout === '' || stdout === '[]') return [];
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is { number: number } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { number?: unknown }).number === 'number',
  );
}

/**
 * Run `ps -ax -o pid,command` — portable on both Darwin and Linux.
 * Throws on non-zero exit (caller catches and skips).
 */
function runPsAx(): string {
  return execSync('ps -ax -o pid,command', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Scan ps output for a line matching a claude `--print` (or `-p`) subprocess
 * that contains the task ID. Returns the PID if found, null otherwise.
 *
 * Pattern: `claude` in the command, `--print` or `-p` flag, and the task ID
 * string somewhere in the argv.
 *
 * We accept both uppercase and lowercase forms of the task ID in the process
 * table (the task ID is in the developer agent prompt which the spawner passes
 * via argv).
 */
function findClaudeSubprocess(psOutput: string, taskId: string): number | null {
  const taskIdLower = taskId.toLowerCase();
  const taskIdUpper = taskId.toUpperCase();

  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Extract PID (first token) and rest of command.
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx).trim();
    const command = trimmed.slice(spaceIdx + 1).trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue;

    // Must contain `claude` (the binary name) and a --print or -p flag.
    if (!command.includes('claude')) continue;
    if (!command.includes('--print') && !/ -p(\s|$)/.test(command)) continue;

    // Must reference the task ID.
    if (command.includes(taskIdLower) || command.includes(taskIdUpper)) {
      return pid;
    }
  }
  return null;
}

/**
 * Read `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS` env var.
 * Canonical truthy values: `1`, `true`, `yes`, `on` (case-insensitive).
 * Default when unset: treated as truthy (the feature is ON by default for
 * tick and start modes — operators opt OUT by setting it to `0` or `false`).
 */
function isDetectSubprocessEnabled(): boolean {
  const raw = process.env.AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS;
  if (raw === undefined) return true; // default ON
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
