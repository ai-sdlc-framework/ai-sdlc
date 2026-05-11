/**
 * Core types for the @ai-sdlc/pipeline-cli library.
 *
 * RFC-0012 Phase 1. These types are stable contracts shared across:
 *  - Tier 1 (slash command body) — invokes step functions via CLI subcommands
 *  - Tier 2 (TypeScript service `executePipeline`) — imports the step functions directly
 *  - MCP tool wrappers (Phase 3) — re-export the step signatures as MCP tools
 *
 * Keep this file dependency-free so it can be imported anywhere without
 * pulling in node-only or test-only modules.
 */

// ── Pipeline orchestration shapes ────────────────────────────────────

/**
 * Top-level options for `executePipeline()` (Tier 2 composite entry point).
 */
export interface PipelineOptions {
  /** Backlog task ID (e.g. "AISDLC-100.1"). Case-insensitive — internally normalised to lowercase. */
  taskId: string;
  /** Project root (where `backlog/`, `.ai-sdlc/`, `.worktrees/` live). Defaults to `process.cwd()`. */
  workDir: string;
  /** Subagent dispatch implementation. Required for Tier 2; Tier 1 uses Agent tool calls instead. */
  spawner?: SubagentSpawner;
  /**
   * Cap on TOTAL review iterations including the initial Step 5b/7b run.
   * Defaults to 2 (matches AISDLC-82) — i.e. one retry after a CHANGES_REQUESTED
   * verdict before flagging `needs-human-attention`.
   */
  maxReviewIterations?: number;
  /** Optional progress callback fired per iteration of the review loop. */
  onProgress?: (iteration: number, verdict: AggregatedVerdict) => Promise<void> | void;
  /** Optional logger; defaults to console. */
  logger?: PipelineLogger;
  /**
   * Optional command runner used by the deterministic steps (git/gh/etc.).
   * Defaults to `defaultRunner` (live `child_process.execFile`). Tests inject
   * a `FakeRunner` to assert + script the side-effect surface.
   */
  runner?: import('./runtime/exec.js').Runner;
  /**
   * Optional flag to skip the chore commit at finalize-task. Useful when running
   * the pipeline against a project root that isn't a real git repo (tests).
   */
  skipFinalizeCommit?: boolean;
  /**
   * AISDLC-176 — fired when the Step 6 retry helper recovered a
   * developer dispatch by re-prompting for the JSON envelope. The
   * orchestrator wires this to the `DeveloperContractRetry`
   * `events.jsonl` emission so operators can grep recovery frequency
   * (high frequency → time to strengthen the system prompt; rare → the
   * retry is doing its job).
   *
   * Tier 1 (slash command body) ignores this; only Tier 2 / orchestrator
   * dispatch consumers fire the events bus.
   */
  onDeveloperContractRetry?: (info: DeveloperContractRetryInfo) => void;
  /**
   * AISDLC-224 — when true, Step 3 (`setupWorktree`) will attempt
   * auto-cleanup when it detects a stale branch blocking worktree creation
   * (provided `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` is also set). The
   * orchestrator loop sets this to true; the manual `/ai-sdlc execute` path
   * leaves it false (default OFF — no behavior change for the manual path).
   */
  autonomousMode?: boolean;
  /**
   * AISDLC-224 — orchestrator-side hook fired when Step 3's auto-cleanup
   * actually runs (cleanup-then-retry succeeded). Carries the
   * `WorktreeAutoCleaned` event payload so the orchestrator loop can
   * forward it to its events bus (events.jsonl).
   *
   * Set by `cli-orchestrator`'s default dispatcher; left undefined by the
   * manual `/ai-sdlc execute` path (no events bus to forward to).
   *
   * Note: emit happens inside `setupWorktree()` AFTER the retry succeeds
   * (so a partial-failure cleanup doesn't fire a misleading "cleaned"
   * event — code-reviewer #377 minor finding 4).
   */
  onWorktreeAutoCleaned?: (event: {
    type: 'WorktreeAutoCleaned';
    taskId: string;
    branch: string;
    reason: string;
    hadOpenPR: boolean;
    hadUncommittedChanges: boolean;
  }) => void;
  /**
   * AISDLC-241 — options forwarded to `withWorktreeMutex()` inside Step 3
   * (`setupWorktree`). When provided, `git worktree add` (and any sibling
   * cleanup ops) are serialized via the in-process mutex so concurrent
   * orchestrator ticks in the same process cannot race on `.git/config.lock`.
   *
   * The orchestrator's `buildDefaultDispatch` injects `{ workDir }` so all
   * concurrent ticks share the singleton in-process queue AND the cross-process
   * file lock. Manual `/ai-sdlc execute` leaves this undefined (default OFF —
   * no behaviour change for the single-dispatch path).
   */
  mutexOpts?: import('./runtime/worktree-mutex.js').WithWorktreeMutexOptions;
}

/**
 * AISDLC-176 — payload fired from `executePipeline()`'s Step 6 to the
 * orchestrator's events bus when the retry helper recovered a JSON
 * envelope after one prose-then-JSON retry.
 *
 * AISDLC-196 — adds `phase` + optional `iteration` so operators grepping
 * `events.jsonl` can attribute recovery events to the initial-dispatch
 * path (Step 5b/6) versus the iteration-loop path (Step 9, iterations
 * N>1). Without these the recovery-frequency story is muddled — a
 * persistent drift in the developer system prompt looks the same as
 * one rough iteration after a CHANGES_REQUESTED round.
 */
export interface DeveloperContractRetryInfo {
  taskId: string;
  /** Truncated raw output the dev returned on the FIRST (failing) turn. */
  initialOutputPreview: string;
  /** Truncated raw output the dev returned on the (successful) retry turn. */
  retryOutputPreview: string;
  /** Wall-clock duration of the retry spawn in ms. */
  durationMs: number;
  /**
   * AISDLC-196 — discriminator identifying which dispatch path emitted
   * the event. `'initial'` = Step 5b/6 first-call dispatch (iteration 1).
   * `'iteration'` = Step 9 iteration loop, iterations N>1 (after a
   * CHANGES_REQUESTED round).
   */
  phase: 'initial' | 'iteration';
  /**
   * AISDLC-196 — present when `phase === 'iteration'`. The iteration
   * counter the loop was on when the retry recovered (always >=2;
   * iteration 1 is the initial dispatch which uses `phase: 'initial'`).
   */
  iteration?: number;
}

/**
 * Final result returned by `executePipeline()`.
 */
export interface PipelineResult {
  taskId: string;
  branch: string;
  worktreePath: string;
  outcome: PipelineOutcome;
  prUrl: string | null;
  siblingPrUrls: string[];
  iterations: number;
  finalVerdict: AggregatedVerdict | null;
  notes?: string;
}

export type PipelineOutcome =
  | 'approved'
  | 'needs-human-attention'
  | 'developer-failed'
  | 'developer-json-contract-violated'
  | 'aborted'
  /**
   * AISDLC-232 — Step 11 late-rebase hit semantic conflicts it could not
   * auto-resolve (CHANGELOG / test / prettier rules exhausted). The rebase
   * was aborted; the worktree is left clean (pre-rebase state). The
   * orchestrator tick records this outcome and continues to the next task —
   * it does NOT rollback (the dev's commits are safe on the branch) and does
   * NOT escalate via `EscalateFn`. The operator sees the conflict files in
   * `outcomes[i].failure.message` and resolves manually via
   * `/ai-sdlc rebase <pr>` or by rebasing the branch themselves.
   */
  | 'rebase-conflict';

// ── Step contracts ───────────────────────────────────────────────────

/**
 * Generic shape for a step function's structured return value.
 * Steps either resolve with a `StepResult<T>` or throw a `StepError`.
 */
export interface StepResult<T = unknown> {
  ok: boolean;
  data?: T;
  reason?: string;
}

export class StepError extends Error {
  constructor(
    message: string,
    public readonly step: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

// ── Step 0 — Sweep ───────────────────────────────────────────────────

export interface SweepResult {
  swept: Array<{ worktreePath: string; branch: string; mergedAt: string }>;
}

// ── Step 1 — Validate task ───────────────────────────────────────────

/**
 * Subset of backlog task frontmatter the pipeline consumes.
 * Unknown keys are ignored at parse time.
 */
export interface TaskSpec {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria: string[];
  acceptanceCriteriaChecked: boolean[];
  permittedExternalPaths?: string[];
  description: string;
  references?: string[];
  /** Raw markdown body of the task (for the developer prompt). */
  rawBody: string;
  /** Path to the on-disk task file. */
  filePath: string;
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
  task?: TaskSpec;
}

// ── Step 2 — Compute branch name ─────────────────────────────────────

export interface ComputeBranchResult {
  branch: string;
  worktreePath: string;
  slug: string;
  taskIdLower: string;
}

// ── Step 3 — Setup worktree ──────────────────────────────────────────

export interface SetupWorktreeResult {
  branch: string;
  worktreePath: string;
  baseSha: string;
}

// ── Step 4 — Begin task ──────────────────────────────────────────────

export interface BeginTaskResult {
  taskId: string;
  worktreePath: string;
  sentinelPath: string;
}

// ── Step 5 — Build developer prompt ──────────────────────────────────

export interface DeveloperPromptResult {
  prompt: string;
  /** The task spec that was rendered (echo for caller convenience). */
  task: TaskSpec;
}

// ── Step 6 — Parse developer return ──────────────────────────────────

/**
 * The structured return value the developer subagent emits.
 * Mirrors the JSON contract documented in `ai-sdlc-plugin/agents/developer.md`.
 */
export interface DeveloperReturn {
  summary: string;
  filesChanged: string[];
  filesChangedExternal?: Array<{ repo: string; files: string[] }>;
  commitSha: string | null;
  verifications: {
    build: VerificationStatus;
    test: VerificationStatus;
    lint: VerificationStatus;
    format: VerificationStatus;
  };
  acceptanceCriteriaMet: number[];
  notes?: string;
}

export type VerificationStatus = 'passed' | 'failed' | 'skipped';

export interface ParseDeveloperReturnResult {
  ok: boolean;
  reason?: string;
  developer?: DeveloperReturn;
  /**
   * AISDLC-176 — distinguishes "the dev returned valid JSON but the work
   * failed" (e.g. `commitSha: null`) from "the dev returned non-JSON prose
   * and we cannot even structurally evaluate the work". The retry helper
   * `parseDeveloperReturnWithRetry()` keys off this flag to decide whether
   * to issue the one-shot re-emission follow-up. Set when the input could
   * not be parsed as JSON OR was not an object.
   */
  contractViolation?: boolean;
}

// ── Step 7 — Build review prompts ────────────────────────────────────

export type ReviewerType = 'code-reviewer' | 'test-reviewer' | 'security-reviewer';

export interface ReviewPrompt {
  reviewer: ReviewerType;
  prompt: string;
}

export interface BuildReviewPromptsResult {
  prompts: ReviewPrompt[];
  diff: string;
  changedFiles: string[];
  harnessNote: string;
}

// ── Step 8 — Aggregate verdicts ──────────────────────────────────────

export type Severity = 'critical' | 'major' | 'minor' | 'suggestion';

export interface ReviewerFinding {
  severity: Severity;
  file?: string;
  line?: number;
  message: string;
}

export interface ReviewerVerdict {
  agentId: ReviewerType | string;
  harness: 'claude-code' | 'codex' | string;
  approved: boolean;
  findings: ReviewerFinding[];
  summary?: string;
}

export interface AggregatedVerdict {
  approved: boolean;
  /** Stable counts by severity (sum across all reviewers). */
  counts: Record<Severity, number>;
  /** Verdict gate decision. APPROVED iff all reviewers approved AND no critical/major findings. */
  decision: 'APPROVED' | 'CHANGES_REQUESTED';
  verdicts: ReviewerVerdict[];
  harnessNote: string;
  summary: string;
}

// ── Step 9 — Iteration loop ──────────────────────────────────────────

export interface IterateReviewLoopOptions {
  taskId: string;
  /**
   * Path to the per-task git worktree. Steps 5/7 inside the loop need to read
   * the diff against the worktree HEAD, so this is the worktree path, NOT the
   * project root. (The composite `executePipeline()` passes `branch.worktreePath`.)
   */
  worktreePath: string;
  task: TaskSpec;
  branch: string;
  /** First-round developer return — produced by Step 5/6 by the caller. */
  initialDeveloperReturn: DeveloperReturn;
  /** First-round aggregated verdict — produced by Step 7/8 by the caller. */
  initialVerdict: AggregatedVerdict;
  /**
   * Cap on TOTAL iterations (including the initial Step 5b/7b run that the caller
   * already performed before invoking the loop). With the default of 2 the loop
   * body runs at most ONCE — i.e. one retry after a CHANGES_REQUESTED verdict.
   */
  maxIterations?: number;
  spawner?: SubagentSpawner;
  onIteration?: (iteration: number, verdict: AggregatedVerdict) => Promise<void> | void;
  /**
   * AISDLC-184 — fired when the iteration-path Step 6 retry helper recovered
   * a developer dispatch by re-prompting for the JSON envelope. Mirrors the
   * `PipelineOptions.onDeveloperContractRetry` hook (which only covers the
   * initial Step 5b/6 dispatch). Without this wire-up, retries that happen
   * on iteration N>1 fire `parseDeveloperReturnWithRetry` but never emit a
   * `DeveloperContractRetry` event — operators grepping recovery frequency
   * would undercount drift on the iteration path.
   */
  onDeveloperContractRetry?: (info: DeveloperContractRetryInfo) => void;
}

export interface IterateReviewLoopResult {
  finalDeveloperReturn: DeveloperReturn;
  finalVerdict: AggregatedVerdict;
  iterations: number;
  /** Set when iteration cap was hit and the final verdict still has critical/major. */
  needsHumanAttention: boolean;
}

// ── Step 10 — Finalize ───────────────────────────────────────────────

export interface FinalizeTaskOptions {
  taskId: string;
  workDir: string;
  worktreePath: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  verdict: AggregatedVerdict;
  iterations: number;
}

export interface FinalizeTaskResult {
  finalSummary: string;
  acceptanceCriteriaCheck: number[];
  /** Path to the chore commit's attestation envelope (if produced). */
  attestationPath: string | null;
  /** SHA of the chore commit, if one was created. */
  choreCommitSha: string | null;
  /** Set when finalization was skipped because the PR is `[needs-human-attention]`. */
  skipped: boolean;
}

// ── Step 11 — Push and PR ────────────────────────────────────────────

export interface PushAndPrOptions {
  taskId: string;
  workDir: string;
  worktreePath: string;
  branch: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  verdict: AggregatedVerdict;
  needsHumanAttention?: boolean;
  /** Optional logger; defaults to console. AISDLC-245.5 — used to surface deprecation warnings. */
  logger?: PipelineLogger;
}

export interface PushAndPrResult {
  pushed: boolean;
  prUrl: string | null;
  /** When push fails non-fast-forward we abort cleanly with a reason. */
  reason?: string;
  /**
   * AISDLC-232 — set when the late-rebase before push hit semantic conflicts
   * that could not be auto-resolved. The push was NOT attempted. The worktree
   * is left in its pre-rebase state (clean, rebased to the last clean commit).
   * Orchestrator tick maps this to `outcome: 'rebase-conflict'` and continues.
   */
  rebaseConflict?: {
    /** Files that had unresolvable conflicts. */
    files: string[];
    /** Human-readable reason (includes file list + cap-exceeded note). */
    reason: string;
  };
}

// ── Step 12 — Sibling PRs ────────────────────────────────────────────

export interface SiblingPrOptions {
  taskId: string;
  workDir: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  mainPrUrl: string;
}

export interface SiblingPrResult {
  prs: Array<{ repo: string; branch: string; prUrl: string | null; reason?: string }>;
}

// ── Step 13 — Cleanup ────────────────────────────────────────────────

export interface CleanupOptions {
  taskId: string;
  worktreePath: string;
}

export interface CleanupResult {
  sentinelRemoved: boolean;
}

// ── SubagentSpawner abstraction (RFC-0012 §8) ────────────────────────

export type SubagentType =
  | 'developer'
  | 'code-reviewer'
  | 'test-reviewer'
  | 'security-reviewer'
  | 'refinement-reviewer';

export interface SpawnOpts {
  type: SubagentType;
  prompt: string;
  cwd: string;
  /** Per-spawn timeout in ms. Defaults to 30 minutes if the spawner respects it. */
  timeout?: number;
}

/**
 * AISDLC-239 — structured subprocess diagnostics captured by ShellClaudePSpawner.
 *
 * Populated on every `ShellClaudePSpawner` invocation (success or failure).
 * Other spawner implementations (ClaudeCodeSDKSpawner, MockSpawner) leave
 * this field undefined — callers must treat it as optional.
 *
 * Fields:
 *  - `exitCode`    — process exit code (null when killed by signal before exit).
 *  - `signal`      — signal that killed the subprocess (null when normal exit).
 *  - `stderrTail`  — last 2 KB of stderr output (empty string when stderr was clean).
 *  - `wallClockMs` — wall-clock duration from spawn() to close event (mirrors `durationMs`
 *                    for shell-based spawners; separate field so other spawner types can
 *                    leave it undefined without changing `durationMs` semantics).
 *  - `argv`        — full argv array passed to the subprocess (binary NOT included; these
 *                    are the arguments after the binary name, matching `child_process.spawn`
 *                    argv shape).
 *  - `failureType` — machine-readable tag classifying why the spawn failed:
 *                    - `'claude-cli-api-error'`: exit != 0 AND stderr matches Anthropic API error patterns.
 *                    - `'claude-cli-empty-output-fast'`: exit 0, stdout empty, wall-clock < 5 s
 *                      (auth/config issue — subagent never ran).
 *                    - `'claude-cli-killed'`: process was killed by a signal (SIGTERM/SIGKILL).
 *                    - `'claude-cli-nonzero-exit'`: non-zero exit without a recognised API error pattern.
 *                    - `'claude-cli-spawn-error'`: the spawn() call itself threw (e.g. ENOENT).
 *                    - `'claude-cli-watch-error'`: the child emitted an 'error' event.
 *                    - Absent (`undefined`) on success paths.
 *  - `watchdogFired` — true when the spawner's own timeout watchdog sent the kill signal;
 *                      false when the process was killed externally (only set when `failureType`
 *                      is `'claude-cli-killed'`).
 */
export interface SubprocessDiagnostics {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  wallClockMs: number;
  argv: readonly string[];
  failureType?:
    | 'claude-cli-api-error'
    | 'claude-cli-empty-output-fast'
    | 'claude-cli-killed'
    | 'claude-cli-nonzero-exit'
    | 'claude-cli-spawn-error'
    | 'claude-cli-watch-error';
  /** Only set when `failureType === 'claude-cli-killed'`. */
  watchdogFired?: boolean;
}

/** Anthropic API error patterns used to classify non-zero exit failures. */
export const ANTHROPIC_API_ERROR_PATTERNS: readonly RegExp[] = [
  /api_error_status/i,
  /invalid_request_error/i,
  /rate_limit/i,
  /authentication_error/i,
  /overloaded_error/i,
];

/** Tail the last `maxBytes` bytes of `text` (preserves whole UTF-8 chars). */
export function tailBytes(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return text.slice(-maxBytes);
}

export interface SubagentResult {
  type: SubagentType;
  /** Raw stdout/output from the subagent (may be empty on error). */
  output: string;
  /** Parsed structured payload if the subagent returned JSON. */
  parsed?: unknown;
  /**
   * Outcome of the spawn call:
   *   - `'success'` — the subagent ran and returned output.
   *   - `'timeout'` — the subagent exceeded its timeout.
   *   - `'error'` — the subagent failed (subprocess error, non-zero exit, etc.).
   *   - `'manifest-emitted'` — inline-mode only (ClaudeCliInlineSpawner,
   *     AISDLC-198). The spawner wrote a dispatch manifest to disk instead of
   *     invoking a subprocess. The calling slash command body must invoke the
   *     Agent tool using the manifest parameters before continuing the pipeline.
   */
  status: 'success' | 'timeout' | 'error' | 'manifest-emitted';
  error?: string;
  durationMs: number;
  /**
   * AISDLC-239 — structured subprocess diagnostics. Only populated by
   * `ShellClaudePSpawner`; other spawner implementations leave this undefined.
   * Contains exitCode, signal, stderrTail (last 2 KB), wallClockMs, argv,
   * and a `failureType` tag when the invocation failed.
   */
  subprocessDiagnostics?: SubprocessDiagnostics;
}

/**
 * Tier 2 abstraction over "how do I dispatch a subagent" — the only piece of
 * the pipeline that varies between subscription billing (`claude -p`), API-key
 * billing (Claude Code SDK), and tests (MockSpawner).
 *
 * The concrete implementations land in Phase 2 (AISDLC-100.2). Phase 1 ships
 * the interface and a `MockSpawner` for unit/integration tests.
 */
export interface SubagentSpawner {
  spawn(opts: SpawnOpts): Promise<SubagentResult>;
  spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]>;
}

// ── Logger ────────────────────────────────────────────────────────────

export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Emit a `[ai-sdlc-progress] <stage>: <status>` line for orchestrator surfacing. */
  progress(stage: string, status: string): void;
}

export const DEFAULT_LOGGER: PipelineLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  progress: (stage, status) => console.log(`[ai-sdlc-progress] ${stage}: ${status}`),
};
