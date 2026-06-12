/**
 * Reconcile sub-tick (AISDLC-418).
 *
 * ## Problem
 *
 * After AISDLC-396 (Pattern X v2) the dev subagent honors its standard
 * Definition-of-Done contract (commit → rebase → push → open DRAFT PR). The
 * Conductor's role is the **after-the-fact reconcile**: fan out 3 reviewers,
 * sign attestation, force-push the chore commit, flip draft → ready, arm
 * auto-merge.
 *
 * Pre-AISDLC-418 the reconcile flow was 6+ separate Bash commands the
 * slash command body prose walked the LLM through. Every tick burned ~5K
 * context tokens on mechanical glue (`cli-attestation emit-leaf` per
 * reviewer, `sign-attestation.mjs`, `git fetch && rebase`, `git push
 * --force-with-lease`, `gh pr ready`, `gh pr merge --auto`,
 * `cli-dispatch remove-verdict`). This module collapses that into a
 * single function — invocable from the slash body as one bash call:
 *
 *   ai-sdlc-pipeline reconcile <task-id> --verdicts-dir <path>
 *
 * The reviewer fan-out itself (AC #2) STILL runs in the slash command
 * body — `Agent` is only available there, and reconciling 3 reviewer
 * calls via filesystem coordination would re-create the very dispatch
 * dance Pattern X eliminates. The slash body's only remaining
 * orchestration step is to fire 3 parallel `Agent(...)` calls (one
 * operation, not 3 separate ones — AC #2) and then call this reconcile
 * function with the verdict paths.
 *
 * ## Steps wrapped (formerly Steps 3.3-3.8 of orchestrator-tick.md)
 *
 *   1. Resolve worktree + verify dev verdict present
 *   2. Salvage reviewer transcripts from /private/tmp if missing in
 *      `<worktree>/.ai-sdlc/transcripts/` (AC #3)
 *   3. Emit one transcript leaf per reviewer (v6 prereq)
 *   4. Sign attestation via `ai-sdlc-plugin/scripts/sign-attestation.mjs`
 *   5. Force-push the chore commit on top of the dev's branch
 *   6. Flip draft → ready-for-review (`gh pr ready`)
 *   7. Arm auto-merge (`gh pr merge --auto --squash`)
 *   8. Remove the consumed verdict from `done/`
 *   9. Optionally update reviewer-pass cache (AISDLC-418 AC #4)
 *
 * Each step is captured into a `ReconcileResult.steps` array with
 * `{name, status, output}` so the caller (slash command body) can render
 * one progress line per step.
 *
 * ## Failure semantics
 *
 * Reconcile is best-effort with explicit per-step error capture: a sign
 * failure must not strand a leaf-emit, a `gh pr ready` failure must not
 * strand a push. The first hard failure stops further steps but the
 * `steps` array shows EVERY attempt's outcome so the operator can
 * resume manually with full context. `outcome: 'partial'` indicates at
 * least one step succeeded and at least one failed; `'success'` only
 * when every required step landed; `'failed'` when an early-precondition
 * step failed (no verdict, no worktree, etc.).
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  patchDoneVerdict,
  removeVerdict,
} from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { writeEvent, type WriteEventOpts } from './events.js';

/** A reviewer the reconcile sub-tick emits + signs for. */
export type ReviewerName = 'code-reviewer' | 'test-reviewer' | 'security-reviewer';

/** All reviewers the reconcile flow expects, in fixed order (matches Step 3 fan-out). */
export const RECONCILE_REVIEWERS: readonly ReviewerName[] = [
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
] as const;

/** Per-step outcome inside a reconcile run. */
export interface ReconcileStep {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  /** Trimmed stdout/stderr OR short human-readable explanation. */
  output: string;
}

/** Aggregate reconcile outcome. */
export interface ReconcileResult {
  taskId: string;
  outcome: 'success' | 'partial' | 'failed';
  prUrl?: string;
  prNumber?: string;
  pushedBranch?: string;
  commitSha?: string;
  steps: ReconcileStep[];
  /**
   * AISDLC-493 — ISO-8601 timestamp when the reviewer leaf-emit loop started
   * (start of reconcile Step 1). Undefined when the step was skipped.
   */
  reviewerStartedAt?: string;
  /**
   * AISDLC-493 — ISO-8601 timestamp when the reviewer leaf-emit loop completed
   * (end of reconcile Step 1). Undefined when the step was skipped.
   */
  reviewerCompletedAt?: string;
  /**
   * AISDLC-493 — ISO-8601 timestamp when the attestation was signed
   * (reconcile Step 2). Undefined when sign was skipped or failed.
   */
  signedAt?: string;
  /**
   * AISDLC-493 — ISO-8601 timestamp when the PR was flipped ready-for-review
   * (reconcile Step 4). Undefined when gh-pr-ready was skipped or failed.
   */
  prOpenedAt?: string;
}

/** Options for {@link runReconcile}. */
export interface RunReconcileOptions {
  /** Workdir (the parent repo root — `.worktrees/<task>` lives under here). */
  workDir: string;
  /** Task ID (e.g. `AISDLC-418`). */
  taskId: string;
  /** Override board dir (defaults to `<workDir>/.ai-sdlc/dispatch`). */
  boardDir?: string;
  /** Override worktree path (defaults to `<workDir>/.worktrees/<task-id-lower>`). */
  worktreePath?: string;
  /**
   * Map of reviewer → verdict JSON file path inside `<worktree>/.ai-sdlc/verdicts/`.
   * When omitted, reconcile probes `<worktree>/.ai-sdlc/verdicts/<reviewer>-<task-id-lower>.json`
   * for each reviewer.
   */
  reviewerVerdicts?: Partial<Record<ReviewerName | string, string>>;
  /**
   * Map of reviewer → transcript JSONL path inside `<worktree>/.ai-sdlc/transcripts/`.
   * When omitted, reconcile probes
   * `<worktree>/.ai-sdlc/transcripts/<task-id-lower>/<reviewer>.jsonl`.
   * Missing transcripts trigger the /private/tmp salvage path (AC #3).
   */
  reviewerTranscripts?: Partial<Record<ReviewerName | string, string>>;
  /**
   * Map of reviewer → /private/tmp Agent ID (e.g. `b0d3ltjxv`). When present
   * and the worktree transcript is absent, reconcile copies the file from
   * the matching /private/tmp Claude session into the worktree transcripts
   * dir before emitting a leaf.
   */
  reviewerAgentIds?: Partial<Record<ReviewerName | string, string>>;
  /**
   * Skip the `git fetch && rebase && push` step. Useful when the caller has
   * already pushed (e.g. operator manual rerun after fixing a conflict) and
   * just wants reconcile to flip ready + arm auto-merge.
   */
  skipPush?: boolean;
  /** Skip `gh pr ready` (and the auto-merge arm). */
  skipFlipReady?: boolean;
  /** Skip `gh pr merge --auto`. The flip ready step still runs. */
  skipArmAutoMerge?: boolean;
  /**
   * Schema version for sign-attestation. Defaults to v6 (current default).
   * Pass 'v5' to opt back into the legacy schema.
   */
  schemaVersion?: 'v5' | 'v6';
  /**
   * Override the model passed to `cli-attestation emit-leaf`. Defaults to
   * `claude-sonnet-4-6`.
   */
  reviewerModel?: string;
  /**
   * Override the harness passed to `cli-attestation emit-leaf`. Defaults
   * to `claude-code`.
   */
  harness?: string;
  /**
   * Override sign-attestation script path. Defaults to
   * `ai-sdlc-plugin/scripts/sign-attestation.mjs` relative to workDir.
   */
  signScriptPath?: string;
  /**
   * Override cli-attestation bin path. Defaults to
   * `pipeline-cli/bin/cli-attestation.mjs` relative to workDir.
   */
  cliAttestationBin?: string;
  /**
   * Optional shim — overrides `spawnSync` for hermetic tests. The shim
   * mirrors the spawnSync signature but only the fields reconcile
   * actually reads (`{status, stdout, stderr}`).
   */
  spawn?: (
    file: string,
    args: readonly string[],
    options: { cwd?: string },
  ) => { status: number | null; stdout: string; stderr: string };
  /**
   * AISDLC-493 — artifacts directory for the orchestrator events stream.
   * When set, a `ReconcileCompleted` event is appended to
   * `<artifactsDir>/_orchestrator/events-YYYY-MM-DD.jsonl` at reconcile end.
   * Falls back to `ARTIFACTS_DIR` env then `./artifacts` when omitted.
   */
  artifactsDir?: string;
  /**
   * AISDLC-493 — override clock for the events writer (tests inject a
   * frozen clock). Falls back to `new Date()` when omitted.
   */
  now?: () => Date;
  /**
   * AISDLC-493 — override the orchestrator flag predicate for hermetic
   * tests (bypasses the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` env check).
   */
  isEnabled?: WriteEventOpts['isEnabled'];
  /**
   * AISDLC-493 — start timestamp for the reconcile pass (used to compute
   * `reconcileDurationMs`). When omitted the writer derives it from the
   * time `runReconcile` is called.
   */
  reconcileStartedAt?: string;
}

/** Result of the /private/tmp transcript salvage probe. */
export interface SalvageResult {
  status: 'salvaged' | 'already-present' | 'not-found';
  /** Path the file was placed at (or already lived at). */
  destination: string;
  /** Path the file was copied from (only on 'salvaged'). */
  source?: string;
}

/**
 * Salvage a reviewer transcript from `/private/tmp/claude-*` when it isn't
 * already in the worktree's `.ai-sdlc/transcripts/<task>/` dir (AC #3).
 *
 * Claude Code writes transcripts to
 * `/private/tmp/claude-<uid>/<encoded-cwd>/<session-uuid>/tasks/<agentId>.output`.
 * Each reviewer Agent call has its own `agentId`; the slash command body's
 * caller knows the `agentId` because the `Agent` tool returns it.
 *
 * This function:
 *   1. Checks if `<destDir>/<reviewer>.jsonl` already exists — returns
 *      `already-present` if so.
 *   2. Searches `/private/tmp/claude-<uid>/` directories whose encoded
 *      cwd path matches `worktreePath` for a `tasks/<agentId>.output` file.
 *   3. Copies the first match into `<destDir>/<reviewer>.jsonl`.
 *
 * Returns `not-found` if no match is located — the caller decides whether
 * that's a hard failure (v6 mode rejects missing leaves) or soft (v5
 * mode tolerates it).
 */
/**
 * Validator for Claude Code `agentId` strings — defense-in-depth against a
 * malicious caller-supplied agentId that path-traverses out of the tasks/
 * directory (iter-2 MAJOR #5). Claude Code IDs are short lowercase
 * alphanumerics (observed: 6-10 chars in the wild, e.g. `b0d3ltjxv`); we
 * accept up to 32 to leave headroom without admitting `/`, `.`, etc.
 */
export const AGENT_ID_PATTERN = /^[a-z0-9]{6,32}$/;

export function salvageReviewerTranscript(
  worktreePath: string,
  taskId: string,
  reviewerName: string,
  agentId: string,
  options: {
    tmpRoot?: string;
    uidPrefix?: string;
  } = {},
): SalvageResult {
  const destDir = path.join(worktreePath, '.ai-sdlc', 'transcripts', taskId.toLowerCase());
  const destination = path.join(destDir, `${reviewerName}.jsonl`);
  // Reject obviously-bad agentIds before they reach `path.join` — defense-
  // in-depth against caller-supplied path traversal (iter-2 MAJOR #5).
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return { status: 'not-found', destination };
  }
  if (existsSync(destination)) {
    return { status: 'already-present', destination };
  }
  const tmpRoot = options.tmpRoot ?? '/private/tmp';
  // Encode the worktree path the way Claude Code does: replace `/` with `-`
  // and prepend a `-`. e.g. `/Users/foo/repo/.worktrees/aisdlc-418` →
  // `-Users-foo-repo--worktrees-aisdlc-418`. Empty path components (`//`
  // after replacing `.` in `.worktrees`) become `--` so we don't
  // over-normalize.
  const encoded = encodeWorktreePathForClaudeTmp(worktreePath);
  let candidates: string[] = [];
  try {
    candidates = readdirSync(tmpRoot).filter((d) => d.startsWith('claude-'));
  } catch {
    return { status: 'not-found', destination };
  }
  for (const claudeDir of candidates) {
    const cwdDir = path.join(tmpRoot, claudeDir, encoded);
    if (!existsSync(cwdDir)) continue;
    let sessions: string[];
    try {
      sessions = readdirSync(cwdDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const candidatePath = path.join(cwdDir, session, 'tasks', `${agentId}.output`);
      if (existsSync(candidatePath)) {
        try {
          mkdirSync(destDir, { recursive: true });
          copyFileSync(candidatePath, destination);
          return { status: 'salvaged', destination, source: candidatePath };
        } catch {
          // copy failed — keep scanning for another candidate.
          continue;
        }
      }
    }
  }
  return { status: 'not-found', destination };
}

/**
 * Encode an absolute worktree path the way Claude Code's tmp transcript
 * dir naming convention expects:
 *   - each `/` becomes `-`
 *   - each `.` ALSO becomes `-` (dotfile path components like `.worktrees`
 *     contribute an extra `-`, producing the observed `--worktrees-`
 *     double-dash pattern)
 *
 * Examples:
 *   `/Users/foo/repo`                 → `-Users-foo-repo`
 *   `/Users/foo/repo/.worktrees/x`   → `-Users-foo-repo--worktrees-x`
 *
 * Real-world entry observed on disk during the AISDLC-344 reconcile:
 *   `-Users-dominique-Documents-dev-ai-sdlc-ai-sdlc--worktrees-aisdlc-284`
 */
export function encodeWorktreePathForClaudeTmp(worktreePath: string): string {
  const normalized = path.resolve(worktreePath);
  return normalized.replace(/[/.]/g, '-');
}

/**
 * Locate the most-recently-modified PR number for the worktree's branch via
 * `gh pr view`. Used as a last-resort fallback when the verdict's `prUrl`
 * field is empty. Returns `''` on any failure.
 */
function probePrNumberFromBranch(
  worktreePath: string,
  spawn: NonNullable<RunReconcileOptions['spawn']>,
): string {
  const out = spawn('gh', ['pr', 'view', '--json', 'number', '-q', '.number'], {
    cwd: worktreePath,
  });
  if (out.status !== 0) return '';
  return (out.stdout || '').trim();
}

/**
 * Extract the PR number from a GitHub URL. Returns '' for malformed input
 * — the caller falls back to {@link probePrNumberFromBranch}.
 */
export function extractPrNumberFromUrl(url: string | undefined | null): string {
  if (!url) return '';
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? (m[1] as string) : '';
}

/**
 * Run the reconcile sub-tick for a single task. See module docstring for
 * the full step list.
 *
 * AISDLC-493: emits a `ReconcileCompleted` event on every pass (success,
 * partial, or failed) so the profiling aggregator can count N-cycle
 * reconcile overhead and compute per-reconcile wall-clock. Best-effort —
 * event-write failures are swallowed per the `writeEvent` contract.
 */
export function runReconcile(options: RunReconcileOptions): ReconcileResult {
  const spawn = options.spawn ?? defaultSpawn;
  const now = options.now ?? ((): Date => new Date());
  const reconcileStartedAt = options.reconcileStartedAt ?? now().toISOString();
  const result = runReconcileInner(options, spawn, now, reconcileStartedAt);

  // AISDLC-493 — emit ReconcileCompleted on every pass.
  const reconcileEndedAt = now().toISOString();
  // Minor #4 fix: omit reconcileDurationMs on unparseable or inverted timestamps
  // so the aggregator gets no sample rather than a zero that drags p50 toward zero.
  const reconcileDurationMs = (() => {
    const start = Date.parse(reconcileStartedAt);
    const end = Date.parse(reconcileEndedAt);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
    return end - start;
  })();
  // Count steps that indicate a rebase was performed.
  const rebased = result.steps.some((s) => s.name === 'git-rebase' && s.status === 'success');
  // Count steps that indicate a re-sign was performed.
  const reSignCount = result.steps.filter(
    (s) => s.name === 'sign-attestation' && s.status === 'success',
  ).length;
  const reconcileEventPayload: Parameters<typeof writeEvent>[0] = {
    ts: '',
    type: 'ReconcileCompleted',
    taskId: options.taskId,
    prUrl: result.prUrl ?? null,
    rebased,
    reSignCount,
  };
  if (reconcileDurationMs !== undefined) {
    reconcileEventPayload.reconcileDurationMs = reconcileDurationMs;
  }
  writeEvent(reconcileEventPayload, {
    ...(options.artifactsDir !== undefined ? { artifactsDir: options.artifactsDir } : {}),
    now,
    ...(options.isEnabled !== undefined ? { isEnabled: options.isEnabled } : {}),
  });

  return result;
}

/** Inner implementation without event emission (called by the public wrapper). */
function runReconcileInner(
  options: RunReconcileOptions,
  spawn: NonNullable<RunReconcileOptions['spawn']>,
  now: () => Date,
  reconcileStartedAt: string,
): ReconcileResult {
  void reconcileStartedAt; // captured for outer timing
  const workDir = path.resolve(options.workDir);
  const taskId = options.taskId;
  const taskIdLower = taskId.toLowerCase();
  const worktreePath = options.worktreePath
    ? path.resolve(options.worktreePath)
    : path.join(workDir, '.worktrees', taskIdLower);
  const boardDir = options.boardDir ?? path.join(workDir, DEFAULT_BOARD_DIR);
  const steps: ReconcileStep[] = [];

  // -------------------------------------------------------------------------
  // Step 0: load the dev verdict from done/.
  // -------------------------------------------------------------------------
  const verdicts = collectVerdicts(boardDir, { includeFailed: false });
  const devVerdict: DispatchVerdict | undefined = verdicts.find(
    (v) => v.taskId.toLowerCase() === taskIdLower,
  );
  if (!devVerdict) {
    steps.push({
      name: 'load-dev-verdict',
      status: 'failed',
      output: `no verdict for ${taskId} in ${boardDir}/done/`,
    });
    return { taskId, outcome: 'failed', steps };
  }
  if (devVerdict.outcome !== 'success') {
    steps.push({
      name: 'load-dev-verdict',
      status: 'failed',
      output: `verdict outcome is '${devVerdict.outcome}', expected 'success'`,
    });
    return { taskId, outcome: 'failed', steps };
  }
  steps.push({
    name: 'load-dev-verdict',
    status: 'success',
    output: `commitSha=${devVerdict.commitSha ?? '<none>'} prUrl=${devVerdict.prUrl ?? '<none>'}`,
  });

  if (!existsSync(worktreePath)) {
    steps.push({
      name: 'verify-worktree',
      status: 'failed',
      output: `worktree not found at ${worktreePath}`,
    });
    return {
      taskId,
      outcome: 'failed',
      steps,
      ...(devVerdict.prUrl ? { prUrl: devVerdict.prUrl } : {}),
      ...(devVerdict.commitSha ? { commitSha: devVerdict.commitSha } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Step 1: salvage reviewer transcripts + emit leaves.
  //
  // For each reviewer:
  //   - Locate the transcript (worktree → /private/tmp salvage)
  //   - Locate the verdict (worktree path or caller-provided override)
  //   - Invoke `cli-attestation emit-leaf` so the v6 signer sees the leaf
  //
  // Leaf emit is non-fatal in v5 mode (the signer doesn't read leaves);
  // in v6 mode a missing leaf will fail the subsequent sign step which
  // re-surfaces here.
  // -------------------------------------------------------------------------
  const headSha = devVerdict.commitSha ?? '';
  if (!headSha) {
    steps.push({
      name: 'verify-head-sha',
      status: 'failed',
      output: 'devVerdict.commitSha is empty — cannot generate transcript leaf nonces',
    });
    return {
      taskId,
      outcome: 'failed',
      steps,
      ...(devVerdict.prUrl ? { prUrl: devVerdict.prUrl } : {}),
    };
  }

  const cliAttestationBin =
    options.cliAttestationBin ?? path.join(workDir, 'pipeline-cli', 'bin', 'cli-attestation.mjs');
  const reviewerModel = options.reviewerModel ?? 'claude-sonnet-4-6';
  const harness = options.harness ?? 'claude-code';

  // AISDLC-493 — capture reviewer fan-out start/end timestamps for verdict patching.
  const reviewerStartedAt = now().toISOString();

  for (const reviewer of RECONCILE_REVIEWERS) {
    const transcriptPath =
      options.reviewerTranscripts?.[reviewer] ??
      path.join(worktreePath, '.ai-sdlc', 'transcripts', taskIdLower, `${reviewer}.jsonl`);
    const verdictPath =
      options.reviewerVerdicts?.[reviewer] ??
      path.join(worktreePath, '.ai-sdlc', 'verdicts', `${reviewer}-${taskIdLower}.json`);

    // Salvage if missing.
    let transcriptStatus: SalvageResult['status'] = existsSync(transcriptPath)
      ? 'already-present'
      : 'not-found';
    if (transcriptStatus === 'not-found') {
      const agentId = options.reviewerAgentIds?.[reviewer];
      if (agentId) {
        const salvage = salvageReviewerTranscript(worktreePath, taskId, reviewer, agentId);
        transcriptStatus = salvage.status;
      }
    }

    if (transcriptStatus === 'not-found') {
      steps.push({
        name: `salvage-transcript:${reviewer}`,
        status: 'skipped',
        output:
          `no transcript at ${transcriptPath} and no /private/tmp match` +
          (options.reviewerAgentIds?.[reviewer]
            ? ` for agentId=${options.reviewerAgentIds[reviewer]}`
            : ' (no agentId provided)'),
      });
      continue;
    }
    steps.push({
      name: `salvage-transcript:${reviewer}`,
      status: 'success',
      output: `transcript at ${transcriptPath} (${transcriptStatus})`,
    });

    if (!existsSync(verdictPath)) {
      steps.push({
        name: `emit-leaf:${reviewer}`,
        status: 'skipped',
        output: `verdict file missing at ${verdictPath}`,
      });
      continue;
    }

    const emit = spawn(
      'node',
      [
        cliAttestationBin,
        'emit-leaf',
        '--repo-root',
        worktreePath,
        '--task-id',
        taskId,
        '--reviewer',
        reviewer,
        '--transcript-path',
        transcriptPath,
        '--verdict-path',
        verdictPath,
        '--head-sha',
        headSha,
        '--harness',
        harness,
        '--model',
        reviewerModel,
      ],
      { cwd: worktreePath },
    );
    steps.push({
      name: `emit-leaf:${reviewer}`,
      status: emit.status === 0 ? 'success' : 'failed',
      output: trimOutput(emit.stdout + (emit.stderr ? `\n[stderr] ${emit.stderr}` : '')),
    });
  }

  // AISDLC-493 — reviewer fan-out complete timestamp.
  const reviewerCompletedAt = now().toISOString();

  // -------------------------------------------------------------------------
  // Step 2: sign attestation.
  // -------------------------------------------------------------------------
  const aggregatedVerdictPath = path.join(
    worktreePath,
    '.ai-sdlc',
    'verdicts',
    `${taskIdLower}.json`,
  );
  if (!existsSync(aggregatedVerdictPath)) {
    steps.push({
      name: 'sign-attestation',
      status: 'failed',
      output: `aggregated verdict missing at ${aggregatedVerdictPath} — the slash body must write this before reconcile`,
    });
    return finalizeResult(taskId, devVerdict, steps);
  }

  const signScript =
    options.signScriptPath ??
    path.join(workDir, 'ai-sdlc-plugin', 'scripts', 'sign-attestation.mjs');
  const signArgs = [signScript, '--review-verdicts', aggregatedVerdictPath, '--task-id', taskId];
  if (options.schemaVersion) {
    signArgs.push('--schema-version', options.schemaVersion);
  }
  const sign = spawn('node', signArgs, { cwd: worktreePath });
  // AISDLC-493 — capture sign timestamp before recording the step so the
  // timestamp reflects sign completion even if later steps branch off early.
  const signedAt = sign.status === 0 ? now().toISOString() : undefined;
  steps.push({
    name: 'sign-attestation',
    status: sign.status === 0 ? 'success' : 'failed',
    output: trimOutput(sign.stdout + (sign.stderr ? `\n[stderr] ${sign.stderr}` : '')),
  });
  if (sign.status !== 0) {
    return finalizeResult(taskId, devVerdict, steps, undefined, {
      reviewerStartedAt,
      reviewerCompletedAt,
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: force-push the chore commit on top of the dev's branch.
  // -------------------------------------------------------------------------
  if (!options.skipPush) {
    const fetch = spawn('git', ['fetch', 'origin', 'main'], { cwd: worktreePath });
    steps.push({
      name: 'git-fetch',
      status: fetch.status === 0 ? 'success' : 'failed',
      output: trimOutput(fetch.stdout + (fetch.stderr ? `\n[stderr] ${fetch.stderr}` : '')),
    });
    if (fetch.status !== 0) {
      return finalizeResult(taskId, devVerdict, steps, undefined, {
        reviewerStartedAt,
        reviewerCompletedAt,
        signedAt,
      });
    }
    const rebase = spawn('git', ['rebase', 'origin/main'], { cwd: worktreePath });
    steps.push({
      name: 'git-rebase',
      status: rebase.status === 0 ? 'success' : 'failed',
      output: trimOutput(rebase.stdout + (rebase.stderr ? `\n[stderr] ${rebase.stderr}` : '')),
    });
    if (rebase.status !== 0) {
      return finalizeResult(taskId, devVerdict, steps, undefined, {
        reviewerStartedAt,
        reviewerCompletedAt,
        signedAt,
      });
    }
    const push = spawn('git', ['push', '--force-with-lease'], { cwd: worktreePath });
    steps.push({
      name: 'git-push',
      status: push.status === 0 ? 'success' : 'failed',
      output: trimOutput(push.stdout + (push.stderr ? `\n[stderr] ${push.stderr}` : '')),
    });
    if (push.status !== 0) {
      return finalizeResult(taskId, devVerdict, steps, undefined, {
        reviewerStartedAt,
        reviewerCompletedAt,
        signedAt,
      });
    }
  } else {
    steps.push({
      name: 'git-push',
      status: 'skipped',
      output: 'skipPush=true',
    });
  }

  // -------------------------------------------------------------------------
  // Step 4: flip draft → ready-for-review.
  // -------------------------------------------------------------------------
  let prNumber = extractPrNumberFromUrl(devVerdict.prUrl);
  if (!prNumber) {
    prNumber = probePrNumberFromBranch(worktreePath, spawn);
  }
  // AISDLC-493 — prOpenedAt is captured when gh pr ready succeeds.
  let prOpenedAt: string | undefined;
  if (!options.skipFlipReady) {
    if (!prNumber) {
      steps.push({
        name: 'gh-pr-ready',
        status: 'failed',
        output: 'unable to determine PR number from verdict or branch probe',
      });
      return finalizeResult(taskId, devVerdict, steps, prNumber, {
        reviewerStartedAt,
        reviewerCompletedAt,
        signedAt,
      });
    }
    const ready = spawn('gh', ['pr', 'ready', prNumber], { cwd: worktreePath });
    steps.push({
      name: 'gh-pr-ready',
      status: ready.status === 0 ? 'success' : 'failed',
      output: trimOutput(ready.stdout + (ready.stderr ? `\n[stderr] ${ready.stderr}` : '')),
    });
    if (ready.status !== 0) {
      return finalizeResult(taskId, devVerdict, steps, prNumber, {
        reviewerStartedAt,
        reviewerCompletedAt,
        signedAt,
      });
    }
    prOpenedAt = now().toISOString();
  } else {
    steps.push({
      name: 'gh-pr-ready',
      status: 'skipped',
      output: 'skipFlipReady=true',
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: arm auto-merge.
  // -------------------------------------------------------------------------
  if (!options.skipArmAutoMerge && prNumber) {
    const arm = spawn('gh', ['pr', 'merge', '--auto', '--squash', prNumber], {
      cwd: worktreePath,
    });
    steps.push({
      name: 'gh-pr-merge-auto',
      status: arm.status === 0 ? 'success' : 'failed',
      output: trimOutput(arm.stdout + (arm.stderr ? `\n[stderr] ${arm.stderr}` : '')),
    });
  } else {
    steps.push({
      name: 'gh-pr-merge-auto',
      status: 'skipped',
      output: options.skipArmAutoMerge ? 'skipArmAutoMerge=true' : 'no PR number',
    });
  }

  // -------------------------------------------------------------------------
  // Step 6: patch lifecycle timestamps onto the verdict, then remove it.
  //
  // AISDLC-493: stamp reviewerStartedAt/reviewerCompletedAt/signedAt/prOpenedAt
  // onto the done/ verdict so callers that inspect the board record can read
  // phase timings without cross-referencing the events stream. Best-effort —
  // a patch failure does NOT abort the reconcile or change its outcome.
  // The verdict must be patched BEFORE removeVerdict clears it from done/.
  // -------------------------------------------------------------------------
  patchDoneVerdict(boardDir, taskId, {
    ...(reviewerStartedAt !== undefined ? { reviewerStartedAt } : {}),
    ...(reviewerCompletedAt !== undefined ? { reviewerCompletedAt } : {}),
    ...(signedAt !== undefined ? { signedAt } : {}),
    ...(prOpenedAt !== undefined ? { prOpenedAt } : {}),
  });

  try {
    removeVerdict(boardDir, taskId, 'done');
    steps.push({
      name: 'remove-verdict',
      status: 'success',
      output: `removed done/<task>.verdict.json for ${taskId}`,
    });
  } catch (err) {
    steps.push({
      name: 'remove-verdict',
      status: 'failed',
      output: (err as Error).message,
    });
  }

  return finalizeResult(taskId, devVerdict, steps, prNumber, {
    reviewerStartedAt,
    reviewerCompletedAt,
    signedAt,
    prOpenedAt,
  });
}

/**
 * AISDLC-493 — lifecycle timestamps captured during the reconcile pass and
 * threaded through `finalizeResult` for both the `ReconcileResult` return
 * value and the `patchDoneVerdict` call in `runReconcile`.
 */
interface ReconcileTimings {
  reviewerStartedAt?: string;
  reviewerCompletedAt?: string;
  signedAt?: string;
  prOpenedAt?: string;
}

/**
 * Decide the aggregate outcome from per-step statuses and pack the
 * verdict-derived fields onto the result envelope.
 */
function finalizeResult(
  taskId: string,
  devVerdict: DispatchVerdict | undefined,
  steps: ReconcileStep[],
  prNumber?: string,
  timings?: ReconcileTimings,
): ReconcileResult {
  // Failed iff there's at least one failed step that isn't a non-blocking
  // optional (today every step we add is blocking — leaf-emit skips don't
  // mark `failed`, they mark `skipped`). Partial iff some succeeded and
  // some failed. Success iff every non-skipped step succeeded.
  const hasFailed = steps.some((s) => s.status === 'failed');
  const hasSuccess = steps.some((s) => s.status === 'success');
  const outcome: ReconcileResult['outcome'] = hasFailed
    ? hasSuccess
      ? 'partial'
      : 'failed'
    : 'success';
  const result: ReconcileResult = { taskId, outcome, steps };
  if (devVerdict?.prUrl) result.prUrl = devVerdict.prUrl;
  if (prNumber) result.prNumber = prNumber;
  if (devVerdict?.pushedBranch) result.pushedBranch = devVerdict.pushedBranch;
  if (devVerdict?.commitSha) result.commitSha = devVerdict.commitSha;
  // AISDLC-493 — stamp timing fields when available.
  if (timings?.reviewerStartedAt) result.reviewerStartedAt = timings.reviewerStartedAt;
  if (timings?.reviewerCompletedAt) result.reviewerCompletedAt = timings.reviewerCompletedAt;
  if (timings?.signedAt) result.signedAt = timings.signedAt;
  if (timings?.prOpenedAt) result.prOpenedAt = timings.prOpenedAt;
  return result;
}

/** Default shell-out shim — `spawnSync` with stdout/stderr captured as utf-8 strings. */
function defaultSpawn(
  file: string,
  args: readonly string[],
  options: { cwd?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString?.() ?? '',
    stderr: result.stderr?.toString?.() ?? '',
  };
}

/** Trim a captured stdio block to a single readable line for the progress log. */
function trimOutput(text: string, maxLen = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 1) + '…';
}

/** Utility exported for the bash glue: resolve the user's home dir. */
export function defaultHomeDir(): string {
  return homedir();
}

/** Utility exported for tests: existence check that doesn't throw on EACCES. */
export function safeExistsFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Utility exported for the bash glue: read a verdict JSON (best-effort). */
export function readVerdictJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
