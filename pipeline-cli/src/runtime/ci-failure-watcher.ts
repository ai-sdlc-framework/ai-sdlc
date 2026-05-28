/**
 * CI-failure watcher — Phase 1 polling loop that detects open PRs whose
 * CI failed on a stale base AND spawns the `ci-conflict-resolver`
 * subagent (AISDLC-460) to auto-rebase + force-push + re-arm auto-merge.
 *
 * ## Why this exists
 *
 * Auto-merge-armed PRs sit `BLOCKED` whenever `main` moves ahead and
 * CI fails on the stale base. The operator has to (1) notice, (2)
 * classify the failure, (3) invoke `/ai-sdlc rebase <pr>` manually,
 * (4) wait for the push, (5) re-arm auto-merge if it dropped. Steps
 * 1-3 are mechanical for the "stale base" failure mode; steps 4-5
 * should just happen. This watcher collapses 1-5 into one tick.
 *
 * ## Phase 1 scope (what's here)
 *
 * - Poll `gh pr list --state open --json number,...,statusCheckRollup`
 *   every `pollIntervalSec` seconds (default 60s, the AISDLC-460
 *   contract value).
 * - Classify each PR's failure shape via {@link classifyPrFailureShape}.
 * - Spawn the `ci-conflict-resolver` agent for the rebase-fixable
 *   shapes, capped at N=2 concurrent agents per tick.
 * - On `escalated` / `failed` returns, write a 24h cool-down file at
 *   `.ai-sdlc/ci-conflict-resolver/cooldown/<pr-number>.json` and post
 *   a deduplicated one-line comment to the PR.
 * - Cool-down state files store `{prNumber, classification, escalatedAt}`;
 *   the watcher checks `Date.now() - escalatedAt < 86_400_000` (24h).
 *
 * ## Phase 2 (explicitly deferred)
 *
 * - Webhook-based push notification (replaces polling). Requires a
 *   public endpoint, security review, and a new infra surface.
 * - Slack notification fan-out (the watcher just needs to act, not
 *   announce).
 * - Automatic re-arming after merge-queue rejection.
 * - Cross-PR dependency resolution (#A depends on #B's branch).
 *
 * ## Tests
 *
 * Hermetic — all `gh` / agent invocations go through injectable
 * adapters (`Runner` / `AgentSpawnerFn`). See
 * `ci-failure-watcher.test.ts` for fixtures covering every
 * classification shape, the cool-down predicate, the N=2 concurrency
 * cap, and the deduplicated PR-comment behavior.
 *
 * @module runtime/ci-failure-watcher
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { defaultRunner, type Runner } from './exec.js';

// ── Constants ────────────────────────────────────────────────────────────

/** Default polling cadence (seconds) — per AISDLC-460 task body. */
export const DEFAULT_POLL_INTERVAL_SEC = 60;

/**
 * Max number of `ci-conflict-resolver` agents the watcher will spawn
 * per tick. This is the AISDLC-460 cost-cap — the watcher is the
 * subscription-billed surface that fans out subagents, so we cap to
 * prevent a single bad tick from consuming the operator's quota.
 */
export const MAX_CONCURRENT_AGENTS_PER_TICK = 2;

/** Cool-down window after an `escalated` / `failed` outcome (ms). */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Deduplication prefix for PR comments. The watcher refuses to post
 *  a fresh comment when the most-recent comment already starts here. */
export const PR_COMMENT_PREFIX = 'ai-sdlc/ci-conflict-resolver:';

/** Relative path (from repo root) where cool-down state files live. */
export const COOLDOWN_DIR_REL = '.ai-sdlc/ci-conflict-resolver/cooldown';

// ── Failure-shape classification ────────────────────────────────────────

/**
 * Failure-shape labels the watcher classifies against. The set
 * deliberately mirrors {@link FailureShape} values used by the
 * downstream `ci-conflict-resolver` agent so the round-trip is loss-
 * less.
 */
export type FailureShape =
  | 'conflict-detected'
  | 'test-additions-overlap'
  | 'prettier-drift'
  | 'pnpm-lock-regen'
  | 'package-json-bin-concat'
  | 'CHANGELOG-merge'
  | 'unclassified'
  /** PR is BEHIND main but no other diagnostic info yet (most common). */
  | 'behind-only'
  | /** SUCCESS / DRAFT / no-checks → skip silently. */ 'skip';

/** Whether a failure shape is auto-fixable by the agent. */
export function isRebaseFixable(shape: FailureShape): boolean {
  switch (shape) {
    case 'conflict-detected':
    case 'test-additions-overlap':
    case 'prettier-drift':
    case 'pnpm-lock-regen':
    case 'package-json-bin-concat':
    case 'behind-only':
      return true;
    case 'CHANGELOG-merge':
      // Treat as not auto-fixable here — the agent's defensive
      // re-classification handles AISDLC-401 (drop feature edits) for
      // single-side adds but escalates "merge both sides" surfaces.
      // Routing to the agent risks an inappropriate auto-rebase when
      // the operator intentionally edited CHANGELOG.
      return false;
    case 'unclassified':
    case 'skip':
      return false;
  }
}

// ── PR snapshot type ───────────────────────────────────────────────────

/**
 * Slim, watcher-relevant projection of `gh pr list --json`. Tests
 * construct these directly without going through `gh`.
 */
export interface PrSnapshot {
  number: number;
  isDraft: boolean;
  mergeStateStatus: string;
  /**
   * Either an array of check objects (as gh returns) OR a flattened
   * subset. The classifier only reads `name` + `status` + `conclusion`.
   */
  statusCheckRollup: Array<{
    name: string;
    /** "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "" */
    status?: string;
    /** "SUCCESS" | "FAILURE" | "ERROR" | "CANCELLED" | "NEUTRAL" | "" */
    conclusion?: string;
  }>;
  /** Head ref name (branch) — the agent uses it for `git push`. */
  headRefName: string;
  /** Head OID — passed to the agent so it can detect mid-tick movement. */
  headRefOid: string;
}

/**
 * Classify the failure shape of a single PR snapshot.
 *
 * Phase 1 algorithm:
 *
 * 1. DRAFT or no checks yet → `skip`.
 * 2. `ai-sdlc/pr-ready` SUCCESS → `skip` (PR is mergeable as-is).
 * 3. `mergeStateStatus === 'BEHIND'` AND no FAILURE/ERROR on
 *    `ai-sdlc/pr-ready` → `behind-only` (rebase-fixable; most
 *    common shape).
 * 4. `ai-sdlc/pr-ready` FAILURE/ERROR → `conflict-detected`
 *    (rebase-fixable best-guess; the agent's defensive
 *    re-classification refines it via the actual git rebase).
 * 5. Otherwise → `unclassified`.
 */
export function classifyPrFailureShape(pr: PrSnapshot): FailureShape {
  if (pr.isDraft) return 'skip';
  if (!pr.statusCheckRollup || pr.statusCheckRollup.length === 0) return 'skip';

  const prReady = pr.statusCheckRollup.find((c) => c.name === 'ai-sdlc/pr-ready');
  const prReadyConclusion = (prReady?.conclusion ?? '').toUpperCase();
  const prReadyStatus = (prReady?.status ?? '').toUpperCase();

  // Pending pr-ready → skip; we only act once CI has a verdict.
  if (prReadyStatus !== '' && prReadyStatus !== 'COMPLETED') return 'skip';

  if (prReadyConclusion === 'SUCCESS' || prReadyConclusion === 'NEUTRAL') {
    return 'skip';
  }

  const ms = (pr.mergeStateStatus ?? '').toUpperCase();
  if (ms === 'BEHIND' && prReadyConclusion !== 'FAILURE' && prReadyConclusion !== 'ERROR') {
    return 'behind-only';
  }

  if (prReadyConclusion === 'FAILURE' || prReadyConclusion === 'ERROR') {
    return 'conflict-detected';
  }

  return 'unclassified';
}

// ── Cool-down state ────────────────────────────────────────────────────

/** Schema written to `.ai-sdlc/ci-conflict-resolver/cooldown/<pr>.json`. */
export interface CooldownRecord {
  prNumber: number;
  classification: FailureShape;
  /** Unix epoch ms. */
  escalatedAt: number;
  /** Optional human-readable reason for the cool-down entry. */
  reason?: string;
}

export function cooldownFilePath(workDir: string, prNumber: number): string {
  return join(workDir, COOLDOWN_DIR_REL, `${prNumber}.json`);
}

/**
 * Return the cool-down record for `prNumber` if one exists AND is
 * still within the 24h window. Returns `null` when no record exists
 * or the record has expired.
 */
export function readCooldown(
  workDir: string,
  prNumber: number,
  now: number = Date.now(),
): CooldownRecord | null {
  const filePath = cooldownFilePath(workDir, prNumber);
  if (!existsSync(filePath)) return null;
  let record: CooldownRecord;
  try {
    record = JSON.parse(readFileSync(filePath, 'utf8')) as CooldownRecord;
  } catch {
    return null; // malformed; treat as no cool-down
  }
  if (typeof record.escalatedAt !== 'number') return null;
  if (now - record.escalatedAt >= COOLDOWN_MS) return null; // expired
  return record;
}

/**
 * Write the cool-down record for `prNumber`. Idempotent — overwrites
 * any existing record so a fresh escalation resets the 24h clock.
 */
export function writeCooldown(workDir: string, record: CooldownRecord): void {
  const filePath = cooldownFilePath(workDir, record.prNumber);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
}

/**
 * Read every active cool-down record under the cool-down dir.
 * Expired records are silently filtered out.
 *
 * Exposed for diagnostic CLI surfaces and tests.
 */
export function listActiveCooldowns(workDir: string, now: number = Date.now()): CooldownRecord[] {
  const dir = join(workDir, COOLDOWN_DIR_REL);
  if (!existsSync(dir)) return [];
  const out: CooldownRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CooldownRecord;
      if (typeof record.escalatedAt !== 'number') continue;
      if (now - record.escalatedAt >= COOLDOWN_MS) continue;
      out.push(record);
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ── Agent return contract ──────────────────────────────────────────────

/**
 * The structured return envelope from the `ci-conflict-resolver`
 * agent. Mirrors the contract in
 * `ai-sdlc-plugin/agents/ci-conflict-resolver.md` "Return value"
 * section.
 */
export interface AgentReturn {
  prNumber: number;
  action: 'rebased' | 'escalated' | 'noop-already-up-to-date' | 'failed';
  commitSha?: string | null;
  pushedBranch?: string | null;
  reclassifiedShape?:
    | FailureShape
    | 'modify-vs-delete'
    | 'semantic-conflict'
    | 'changelog-merge-both-sides';
  escalationReason?: string | null;
  verifications?: {
    build?: 'passed' | 'failed' | 'skipped';
    test?: 'passed' | 'failed' | 'skipped';
    lint?: 'passed' | 'failed' | 'skipped';
    format?: 'passed' | 'failed' | 'skipped';
  };
  rebaseAttempts?: number;
  notes?: string;
}

/**
 * Injectable agent-spawn function. Production wires this to whatever
 * harness is hosting the watcher (CCR session, dispatch board worker,
 * inline-Agent call from a slash command). Tests inject a fake.
 */
export type AgentSpawnerFn = (input: {
  prNumber: number;
  branch: string;
  worktreePath: string;
  classifiedShape: FailureShape;
  headSha: string;
}) => Promise<AgentReturn>;

// ── Tick orchestration ─────────────────────────────────────────────────

export interface WatcherTickOptions {
  /** Project root (where `.ai-sdlc/` lives). */
  workDir: string;
  /** Injectable command runner for `gh pr list` + `gh pr comment`. */
  runner?: Runner;
  /** Injectable agent spawner. Falls through to a no-op stub for dry-run. */
  spawner?: AgentSpawnerFn;
  /** Wall-clock now (ms). Tests inject deterministic values. */
  now?: number;
  /** Repository slug for `gh` (defaults to inferring from cwd). */
  repo?: string;
  /**
   * Resolve a PR snapshot to its on-disk worktree path. The default
   * derives `.worktrees/<task-id-lower>` from the headRefName via the
   * same regex used by `commands/rebase.md`.
   */
  worktreeResolver?: (pr: PrSnapshot) => string;
  /**
   * Optional override for `MAX_CONCURRENT_AGENTS_PER_TICK`. Tests use
   * this to exercise the cap deterministically.
   */
  maxConcurrentAgents?: number;
}

export interface WatcherTickResult {
  scannedPrs: number;
  /** PRs that matched a rebase-fixable shape (before concurrency cap). */
  candidatePrs: number[];
  /** PRs the agent was spawned for (post-cap). */
  dispatchedPrs: number[];
  /** PRs skipped because a cool-down was active. */
  skippedByCooldown: number[];
  /** PRs the agent returned `rebased` for. */
  rebased: number[];
  /** PRs the agent returned `escalated` or `failed` for. */
  escalated: number[];
  /** PRs the watcher wrote a fresh comment to. */
  commentedPrs: number[];
  /** PRs where dedup suppressed the comment. */
  commentSuppressed: number[];
  /** Diagnostic dump for operator-facing tools. */
  classifications: Array<{ prNumber: number; shape: FailureShape }>;
}

/**
 * Default worktree resolver — derives `<workDir>/.worktrees/<task-id>`
 * from the PR's headRefName via the same regex as
 * `commands/rebase.md` Step 1.
 *
 * The regex captures `aisdlc-105`, `aisdlc-100.2`, etc. — any
 * `<letters>-<digits-and-dots>` shape.
 */
export function defaultWorktreeResolver(workDir: string): (pr: PrSnapshot) => string {
  return (pr) => {
    const match = /^ai-sdlc\/([a-z]+-[0-9.]+)/.exec(pr.headRefName);
    const taskId = match ? match[1] : pr.headRefName.replace(/\//g, '-').toLowerCase();
    return resolvePath(workDir, '.worktrees', taskId);
  };
}

/**
 * Run a single watcher tick.
 *
 * Steps:
 * 1. Fetch all open PRs via `gh pr list`.
 * 2. For each PR, classify the failure shape.
 * 3. Filter to rebase-fixable shapes.
 * 4. Drop PRs with an active cool-down.
 * 5. Cap at N=2 concurrent dispatches (configurable for tests).
 * 6. Spawn the agent per candidate.
 * 7. On `escalated` / `failed`: write cool-down + post deduped comment.
 *
 * Returns a structured {@link WatcherTickResult} for the caller's
 * logging + diagnostics.
 */
export async function runWatcherTick(opts: WatcherTickOptions): Promise<WatcherTickResult> {
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? Date.now();
  const resolveWorktree = opts.worktreeResolver ?? defaultWorktreeResolver(opts.workDir);
  const maxConcurrent = opts.maxConcurrentAgents ?? MAX_CONCURRENT_AGENTS_PER_TICK;

  const result: WatcherTickResult = {
    scannedPrs: 0,
    candidatePrs: [],
    dispatchedPrs: [],
    skippedByCooldown: [],
    rebased: [],
    escalated: [],
    commentedPrs: [],
    commentSuppressed: [],
    classifications: [],
  };

  const snapshots = await fetchOpenPrs(runner, opts.repo);
  result.scannedPrs = snapshots.length;

  // Step 2-3 — classify + filter to rebase-fixable.
  const candidates: Array<{ pr: PrSnapshot; shape: FailureShape }> = [];
  for (const pr of snapshots) {
    const shape = classifyPrFailureShape(pr);
    result.classifications.push({ prNumber: pr.number, shape });
    if (!isRebaseFixable(shape)) continue;
    candidates.push({ pr, shape });
    result.candidatePrs.push(pr.number);
  }

  // Step 4 — drop cool-down hits.
  const liveCandidates = candidates.filter(({ pr }) => {
    const cd = readCooldown(opts.workDir, pr.number, now);
    if (cd) {
      result.skippedByCooldown.push(pr.number);
      return false;
    }
    return true;
  });

  // Step 5 — cap at N=2.
  const dispatchSet = liveCandidates.slice(0, maxConcurrent);

  // Step 6-7 — dispatch + record outcomes.
  if (!opts.spawner) {
    // Dry-run path — record candidates but skip dispatch.
    return result;
  }

  for (const { pr, shape } of dispatchSet) {
    result.dispatchedPrs.push(pr.number);
    const worktreePath = resolveWorktree(pr);
    let agentResult: AgentReturn;
    try {
      agentResult = await opts.spawner({
        prNumber: pr.number,
        branch: pr.headRefName,
        worktreePath,
        classifiedShape: shape,
        headSha: pr.headRefOid,
      });
    } catch (err) {
      // Treat spawn errors as `failed` outcomes so the watcher
      // cool-down still kicks in (avoid spinning on the same PR).
      agentResult = {
        prNumber: pr.number,
        action: 'failed',
        escalationReason: `spawn-error: ${(err as Error).message}`,
      };
    }

    if (agentResult.action === 'rebased') {
      result.rebased.push(pr.number);
      continue;
    }
    if (agentResult.action === 'noop-already-up-to-date') {
      // No cool-down — the PR may legitimately need another tick
      // attention later (e.g. main moved between fetch + ancestor
      // check). Treat as success.
      result.rebased.push(pr.number);
      continue;
    }

    // escalated | failed — record cool-down + post comment.
    result.escalated.push(pr.number);
    writeCooldown(opts.workDir, {
      prNumber: pr.number,
      classification: (agentResult.reclassifiedShape ?? shape) as FailureShape,
      escalatedAt: now,
      reason: agentResult.escalationReason ?? agentResult.action,
    });

    const commentBody = composeEscalationComment(agentResult, shape);
    const posted = await postDeduplicatedComment(runner, opts.repo, pr.number, commentBody);
    if (posted) result.commentedPrs.push(pr.number);
    else result.commentSuppressed.push(pr.number);
  }

  return result;
}

/**
 * Compose the one-line PR comment for an escalated outcome.
 *
 * Mirror of the AISDLC-460 contract: comment starts with
 * `ai-sdlc/ci-conflict-resolver:` so the dedup predicate can find it.
 */
export function composeEscalationComment(
  agentResult: AgentReturn,
  watcherShape: FailureShape,
): string {
  const reason = agentResult.escalationReason ?? agentResult.action;
  const reclassified = agentResult.reclassifiedShape;
  const shapeForMsg = reclassified ?? watcherShape;
  return `${PR_COMMENT_PREFIX} failure shape '${shapeForMsg}' not auto-resolvable, operator review required (${reason})`;
}

// ── gh adapters ────────────────────────────────────────────────────────

/**
 * Fetch open PRs as `PrSnapshot[]`. Uses `gh pr list --state open
 * --json number,isDraft,mergeStateStatus,statusCheckRollup,headRefName,headRefOid`.
 *
 * Exported so callers can re-use the same projection without going
 * through `runWatcherTick`.
 */
export async function fetchOpenPrs(runner: Runner, repo?: string): Promise<PrSnapshot[]> {
  const args = ['pr', 'list', '--state', 'open', '--limit', '100', '--json'];
  args.push('number,isDraft,mergeStateStatus,statusCheckRollup,headRefName,headRefOid');
  if (repo) {
    args.push('--repo', repo);
  }
  const out = await runner('gh', args, { timeout: 30_000 });
  if (out.code !== 0) {
    throw new Error(`gh pr list failed (exit ${out.code}): ${out.stderr.trim()}`);
  }
  try {
    const parsed = JSON.parse(out.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw) => normalizePrSnapshot(raw as Record<string, unknown>));
  } catch (err) {
    throw new Error(`failed to parse gh pr list JSON: ${(err as Error).message}`);
  }
}

/**
 * Normalize a raw `gh pr list` row into a {@link PrSnapshot}. The
 * status-check rollup shape from `gh` is a tagged union; we flatten
 * it to the slim projection the classifier reads.
 */
export function normalizePrSnapshot(raw: Record<string, unknown>): PrSnapshot {
  const rollupRaw = raw.statusCheckRollup;
  let rollup: PrSnapshot['statusCheckRollup'] = [];
  if (Array.isArray(rollupRaw)) {
    rollup = rollupRaw.map((entry) => {
      const e = entry as Record<string, unknown>;
      // gh returns the check name on different fields depending on the
      // check kind. CheckRun uses `name`; StatusContext uses `context`.
      const name = String(e.name ?? e.context ?? '');
      return {
        name,
        status: typeof e.status === 'string' ? e.status : '',
        conclusion:
          typeof e.conclusion === 'string'
            ? e.conclusion
            : typeof e.state === 'string'
              ? e.state
              : '',
      };
    });
  }
  return {
    number: Number(raw.number ?? 0),
    isDraft: Boolean(raw.isDraft ?? false),
    mergeStateStatus: String(raw.mergeStateStatus ?? ''),
    statusCheckRollup: rollup,
    headRefName: String(raw.headRefName ?? ''),
    headRefOid: String(raw.headRefOid ?? ''),
  };
}

/**
 * Post a one-line comment to `prNumber` if and only if the most recent
 * comment does NOT already start with {@link PR_COMMENT_PREFIX}. The
 * dedup predicate is the AISDLC-460 contract — it avoids noisy
 * repeat-spam on PRs the watcher hits across multiple ticks.
 *
 * Returns `true` if a comment was posted, `false` if dedup suppressed.
 */
export async function postDeduplicatedComment(
  runner: Runner,
  repo: string | undefined,
  prNumber: number,
  body: string,
): Promise<boolean> {
  const listArgs = ['pr', 'view', String(prNumber), '--json', 'comments'];
  if (repo) listArgs.push('--repo', repo);
  const listOut = await runner('gh', listArgs, { timeout: 20_000, allowFailure: true });
  if (listOut.code === 0) {
    try {
      const parsed = JSON.parse(listOut.stdout) as { comments?: Array<{ body?: string }> };
      const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
      if (comments.length > 0) {
        const last = comments[comments.length - 1]?.body ?? '';
        if (last.startsWith(PR_COMMENT_PREFIX)) {
          return false;
        }
      }
    } catch {
      // If parsing fails, fall through and post — better to risk a
      // duplicate comment than to silently drop the escalation signal.
    }
  }

  const commentArgs = ['pr', 'comment', String(prNumber), '--body', body];
  if (repo) commentArgs.push('--repo', repo);
  const out = await runner('gh', commentArgs, { timeout: 20_000, allowFailure: true });
  if (out.code !== 0) {
    // Surface but don't throw — the cool-down was already written.
    process.stderr.write(
      `[ci-failure-watcher] failed to post comment on PR #${prNumber}: ${out.stderr.trim()}\n`,
    );
    return false;
  }
  return true;
}

// ── Daemon loop ────────────────────────────────────────────────────────

export interface WatcherLoopOptions extends WatcherTickOptions {
  pollIntervalSec?: number;
  /** Optional cap on total ticks — Infinity means "until killed". */
  maxTicks?: number;
  /** Injectable sleep for tests. Defaults to `setTimeout` Promise. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional logger called once per tick with the structured result. */
  onTick?: (result: WatcherTickResult, tickIndex: number) => void;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the watcher polling loop. Exits cleanly when `maxTicks` is
 * reached. Production daemons use `maxTicks: Infinity` and rely on
 * SIGINT/SIGTERM to drain.
 */
export async function runWatcherLoop(opts: WatcherLoopOptions): Promise<WatcherTickResult[]> {
  const pollMs = (opts.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC) * 1000;
  const maxTicks = opts.maxTicks ?? Infinity;
  const sleep = opts.sleepFn ?? defaultSleep;

  const results: WatcherTickResult[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const result = await runWatcherTick(opts);
    results.push(result);
    if (opts.onTick) opts.onTick(result, i);
    // Skip the final sleep so the loop exits immediately when
    // `maxTicks` is reached.
    if (i + 1 < maxTicks) {
      await sleep(pollMs);
    }
  }
  return results;
}
