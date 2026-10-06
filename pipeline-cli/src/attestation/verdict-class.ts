/**
 * verdict-class.ts — AISDLC-568 AC#1/AC#2: lower-trust self-review class.
 *
 * Adds a structural (best-effort, single-machine) signal that distinguishes
 * a transcript leaf produced by a REAL, harness-spawned reviewer subagent
 * from one the coordinator process authored itself by running the same
 * Bash sequence the reviewer agent body prescribes.
 *
 * ## Mechanism
 *
 * Claude Code's `SubagentStart` hook (`ai-sdlc-plugin/hooks/subagent-start.js`)
 * fires ONLY when the harness itself dispatches a subagent via the `Agent`/
 * `Task` tool (verified in claude-code's `runAgent.ts`) — it cannot be
 * triggered by a coordinator merely writing files or emitting text. On each
 * firing, the hook writes a marker file to
 * `.ai-sdlc/subagent-sessions/<agent-id-or-random>.json` containing the
 * firing timestamp.
 *
 * `determineVerdictClass()` checks whether an UNCONSUMED marker exists whose
 * `agentType` is in the REVIEWER allowlist (AISDLC-572) AND whose `firedAt`
 * timestamp falls within a bounded lookback window ending at the reviewer
 * transcript file's last-write time. A match means a real REVIEWER-typed
 * subagent was spawned during (or shortly before) the window the transcript
 * was written — strong evidence the transcript reflects an actual
 * independent review, not a same-process self-review. On a match the marker
 * is CONSUMED (deleted) so a single subagent spawn cannot be reused to
 * legitimize multiple leaves.
 *
 * ## AISDLC-572: role binding (not just timing)
 *
 * Prior to this task, `independent` was credited on TIMING ALONE — ANY
 * subagent dispatched within the window (a `developer`, a
 * `rebase-resolver`, anything) made a leaf `independent`, because the
 * marker never recorded which agent role fired the hook. That is a
 * structural false-positive: a coordinator that dispatches a `developer`
 * subagent (which writes a marker) and then hand-authors a `code-reviewer`
 * transcript within the window got `independent` with NO fabrication — an
 * unrelated real marker was silently reused.
 *
 * The fix: the marker (written by `ai-sdlc-plugin/hooks/subagent-start.js`)
 * now also records `agentType` from the `SubagentStart` payload's
 * `agent_type` field. BEFORE the time-window check, this module requires
 * `agentType` to be one of the REVIEWER roles:
 * `code-reviewer`, `test-reviewer`, `security-reviewer`,
 * `code-reviewer-codex`, `test-reviewer-codex`. Explicitly excluded:
 * `developer`, `rebase-resolver`, `ci-conflict-resolver` (none of these
 * review a diff), and `refinement-reviewer` (a DoR/Definition-of-Ready
 * evaluator, not a code/test/security review of the diff being merged).
 * A marker with a non-reviewer `agentType`, or a legacy marker with no
 * `agentType` at all, fails safe to `self-authored` — exactly like a
 * missing marker.
 *
 * Role-binding is now the PRIMARY defense (raising the forgery floor from
 * "any subagent ran" to "a reviewer-typed subagent ran"), which is why the
 * lookback window below was narrowed from 2h to 30 minutes — the timing
 * check is now a secondary/defense-in-depth bound on an already role-gated
 * marker, not the sole signal, so a shorter window that closely tracks a
 * real reviewer subagent's actual runtime is both safer (smaller stale-
 * marker reuse surface) and still generous for normal review latency.
 *
 * ## Honest limits (documented per AC#3 wording discipline)
 *
 * This is a same-process/session HEURISTIC, not a cryptographic proof:
 *   - Single machine, same repo checkout: a sufficiently determined
 *     coordinator with Bash/Write access could fabricate a marker file
 *     directly — INCLUDING forging a reviewer `agentType` string — bypassing
 *     the need to actually spawn a subagent. Role-binding (AISDLC-572)
 *     raises the bar against ACCIDENTAL or lazy self-review (the common
 *     case: the coordinator running the reviewer's own prescribed Bash
 *     steps itself, or reusing an unrelated real marker from a non-reviewer
 *     subagent) — it does not defend against a deliberately adversarial
 *     coordinator willing to also forge `agent_type`. Closing that gap is
 *     `harnessTranscriptHash` (AISDLC-570, DEC-0012 opt-a, DEC-0013 → opt1
 *     sign-time-only trust model) — see `attestation/harness-transcript.ts`.
 *   - Fail-safe default: ANY missing, malformed, non-reviewer, or stale
 *     marker resolves to the LOWER-trust `self-authored` class — this
 *     function never over-claims `independent`.
 *
 * @module attestation/verdict-class
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/** The two trust classes a transcript leaf can be assigned. */
export type VerdictClass = 'independent' | 'self-authored';

/** Repo-relative directory where SubagentStart markers are written. */
export const SUBAGENT_SESSIONS_DIR_RELATIVE = '.ai-sdlc/subagent-sessions';

/**
 * Maximum age (ms) a marker may have relative to the transcript's mtime and
 * still count as evidence of a real subagent spawn. Bounds the window so an
 * unrelated, long-stale marker from an earlier run cannot be reused.
 *
 * AISDLC-572: narrowed from 2 hours to 30 minutes now that role-binding
 * (the `agentType` reviewer-allowlist check below) is the primary defense.
 * A shorter window shrinks the stale-marker reuse surface for an already
 * role-gated marker while still comfortably covering normal reviewer
 * subagent runtimes.
 */
export const MARKER_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Reviewer agent roles (see `ai-sdlc-plugin/agents/*.md` `name:` frontmatter)
 * whose `SubagentStart` marker is eligible to back a `verdictClass:
 * 'independent'` classification. Explicitly excludes `developer`,
 * `rebase-resolver`, `ci-conflict-resolver` (none review a diff) and
 * `refinement-reviewer` (a DoR/Definition-of-Ready evaluator, not a
 * code/test/security review of the diff being merged) — see the module
 * docblock's AISDLC-572 section for the full rationale.
 */
export const REVIEWER_AGENT_TYPES = [
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
  'code-reviewer-codex',
  'test-reviewer-codex',
] as const;

export type ReviewerAgentType = (typeof REVIEWER_AGENT_TYPES)[number];

/**
 * Strip a plugin namespace prefix from an `agentType` string, e.g.
 * `"ai-sdlc:code-reviewer"` -> `"code-reviewer"`.
 *
 * AISDLC-589 Gap B: the `SubagentStart` hook's `agent_type` payload field
 * records whatever Claude Code's harness resolved the subagent's name to —
 * for a plugin-installed agent that is the NAMESPACED form
 * (`ai-sdlc:code-reviewer`), not the bare `name:` frontmatter value
 * (`code-reviewer`) `REVIEWER_AGENT_TYPES` is defined against. Without this
 * normalization, every genuine harness-dispatched reviewer marker fails the
 * role-gate below and silently falls back to `self-authored` /
 * `independenceTier: none` — the exact false-negative this task exists to
 * close.
 *
 * `split(':').pop()` handles any namespace (not just `ai-sdlc:`), including
 * the `-codex` reviewer variants (`ai-sdlc:code-reviewer-codex` ->
 * `code-reviewer-codex`). A bare, unnamespaced value passes through
 * unchanged — `'code-reviewer'.split(':')` yields a single-element array,
 * so `.pop()` returns the original string.
 */
export function stripAgentTypeNamespace(agentType: string | null | undefined): string | null {
  if (typeof agentType !== 'string' || agentType.length === 0) return null;
  const stripped = agentType.split(':').pop();
  return stripped && stripped.length > 0 ? stripped : null;
}

/** Shape of a marker file written by `subagent-start.js`. */
export interface SubagentStartMarker {
  /** The harness-assigned agent identifier (or a random fallback). */
  agentId: string;
  /**
   * The harness-assigned agent role (`SubagentStart` payload's `agent_type`),
   * e.g. `'code-reviewer'`. `null` for legacy markers written before
   * AISDLC-572, or when the payload omitted/malformed the field.
   */
  agentType: string | null;
  /** ISO-8601 timestamp of when the SubagentStart hook fired. */
  firedAt: string;
  /**
   * AISDLC-734: set when a leaf has been emitted from this run. The marker is
   * no longer deleted on first use; it is bound to the (head, reviewer) it
   * backed, so re-emitting for the SAME head and reviewer keeps its class,
   * while any other head or reviewer cannot use it (no relabeling).
   */
  consumedFor?: MarkerClaim;
}

/** What a consumed marker is bound to. */
export interface MarkerClaim {
  /** Head commit the leaf was emitted for. */
  headSha: string;
  /** Reviewer role the leaf was emitted for (namespace stripped), or '' when unknown. */
  reviewer: string;
  /** Task the leaf was emitted for, or '' when unknown. */
  taskId: string;
  /**
   * Hash of the harness transcript that backed the leaf, when one was
   * resolved. A later re-match must present the same transcript.
   */
  transcriptHash?: string;
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Build a claim from emit-time knowledge; `null` unless the head is a full 40-hex SHA. */
export function buildMarkerClaim(
  headSha: string | undefined,
  reviewerName: string | undefined,
  taskId?: string,
): MarkerClaim | null {
  if (!headSha || !HEAD_SHA_PATTERN.test(headSha)) return null;
  return {
    headSha: headSha.toLowerCase(),
    reviewer: (reviewerName !== undefined ? stripAgentTypeNamespace(reviewerName) : null) ?? '',
    taskId: (taskId ?? '').toLowerCase(),
  };
}

/** Same (head, reviewer, task); the transcript hash is checked separately by the caller. */
function claimsEqual(a: MarkerClaim, b: MarkerClaim): boolean {
  return a.headSha === b.headSha && a.reviewer === b.reviewer && a.taskId === b.taskId;
}

/** Resolve the absolute path of the subagent-sessions marker directory. */
export function subagentSessionsDir(repoRoot: string): string {
  return join(repoRoot, SUBAGENT_SESSIONS_DIR_RELATIVE);
}

/**
 * Harness agent ids are opaque tokens. Anything outside this charset is
 * refused before it is compared or used in a path.
 */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// Not to be confused with the stricter `AGENT_ID_PATTERN` in
// `orchestrator/reconcile.ts`, which gates the ids reconcile forwards.

/** What a caller knows about the reviewer run a marker must belong to. */
export interface SubagentMarkerQuery {
  /**
   * Directories that may hold `.ai-sdlc/subagent-sessions/`, in preference
   * order. The harness writes markers under the directory the SESSION was
   * started in (usually the main checkout), while the pipeline's
   * `--repo-root` is usually a task worktree, so both must be searched.
   */
  roots: readonly string[];
  transcriptMtimeMs: number;
  /**
   * The reviewer the leaf is for, e.g. `code-reviewer` (a plugin namespace
   * prefix is ignored). A marker typed for another role never matches.
   */
  reviewerName?: string;
  /** Harness agent id of the reviewer run. When given, only that agent's marker matches. */
  agentId?: string;
  /** Accept markers that carry no `agentType` (written before AISDLC-572). Default false. */
  allowUntyped?: boolean;
  /** Accept only markers whose role is one of `REVIEWER_AGENT_TYPES`. Default false. */
  reviewerRolesOnly?: boolean;
  /**
   * AISDLC-734: the (head, reviewer) this lookup is for. A marker already
   * consumed for a DIFFERENT claim never matches; one consumed for this exact
   * claim matches again (idempotent re-emit). Without a claim, any consumed
   * marker is skipped.
   */
  claim?: MarkerClaim | null;
}

export interface SubagentMarkerSelection {
  marker: SubagentStartMarker;
  /** Absolute path of the marker file, so the caller can consume exactly this one. */
  filePath: string;
}

/**
 * Select the one `SubagentStart` marker that belongs to a reviewer run.
 *
 * The match is by identity, not by timing alone: the marker's role must be
 * the reviewer's role, and when the caller knows the harness agent id the
 * marker must be that agent's. The time window (`MARKER_MAX_AGE_MS`) only
 * bounds how old a marker may be. Before this function existed, the first
 * marker inside the window was taken regardless of role, so three reviewers
 * finishing together had their leaves bound to each other's markers.
 *
 * When several markers qualify (same role, no agent id given), the choice
 * is deterministic: typed before untyped, then the most recent `firedAt`,
 * then agent id, then path. Directory listing order never decides.
 *
 * Read-only and fail-safe: unreadable directories and malformed files are
 * skipped, and `null` is returned when nothing qualifies. It never throws.
 */
export function selectSubagentMarker(query: SubagentMarkerQuery): SubagentMarkerSelection | null {
  return listSubagentMarkerCandidates(query)[0] ?? null;
}

/**
 * Every marker that qualifies for `query`, best first (the order
 * {@link selectSubagentMarker} documents). A caller that must check each
 * candidate against further evidence — the diff-binding nonce in the
 * candidate's harness transcript — walks this list instead of trusting the
 * first entry. Read-only; returns an empty list on any error.
 */
export function listSubagentMarkerCandidates(
  query: SubagentMarkerQuery,
): SubagentMarkerSelection[] {
  const expectedRole =
    query.reviewerName !== undefined ? stripAgentTypeNamespace(query.reviewerName) : undefined;
  if (query.reviewerName !== undefined && !expectedRole) return [];
  if (query.agentId !== undefined && !AGENT_ID_PATTERN.test(query.agentId)) return [];

  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  const candidates: Array<
    SubagentMarkerSelection & { firedAtMs: number; typed: boolean; reused: boolean }
  > = [];

  for (const root of query.roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const absRoot = resolve(root);
    if (seenRoots.has(absRoot)) continue;
    seenRoots.add(absRoot);

    const dir = subagentSessionsDir(absRoot);
    let entries: string[];
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const fileName of entries) {
      const filePath = join(dir, fileName);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const marker = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SubagentStartMarker>;
        if (typeof marker.agentId !== 'string' || marker.agentId.length === 0) continue;
        if (typeof marker.firedAt !== 'string') continue;
        const firedAtMs = new Date(marker.firedAt).getTime();
        if (Number.isNaN(firedAtMs)) continue;
        if (Math.abs(query.transcriptMtimeMs - firedAtMs) > MARKER_MAX_AGE_MS) continue;

        if (query.agentId !== undefined && marker.agentId !== query.agentId) continue;

        const consumedFor = readClaim(marker.consumedFor);
        if (marker.consumedFor !== undefined) {
          // Malformed claim data fails safe: treated as consumed for someone else.
          if (!consumedFor || !query.claim || !claimsEqual(consumedFor, query.claim)) continue;
          // A consumed marker is re-matchable only while its run is recent
          // against the wall clock, so a stale marker cannot be re-matched
          // indefinitely by a transcript with a forged-recent mtime.
          if (Date.now() - firedAtMs > MARKER_MAX_AGE_MS) continue;
        }

        const role =
          typeof marker.agentType === 'string' ? stripAgentTypeNamespace(marker.agentType) : null;
        if (role === null) {
          if (!query.allowUntyped) continue;
        } else {
          if (expectedRole !== undefined && role !== expectedRole) continue;
          if (
            query.reviewerRolesOnly &&
            !REVIEWER_AGENT_TYPES.includes(role as ReviewerAgentType)
          ) {
            continue;
          }
        }

        candidates.push({
          marker: {
            agentId: marker.agentId,
            agentType: typeof marker.agentType === 'string' ? marker.agentType : null,
            firedAt: marker.firedAt,
            ...(consumedFor ? { consumedFor } : {}),
          },
          filePath,
          firedAtMs,
          typed: role !== null,
          reused: consumedFor !== null,
        });
      } catch {
        continue;
      }
    }
  }

  candidates.sort((a, b) => {
    // The run that already backed this exact claim is the same run: first.
    if (a.reused !== b.reused) return a.reused ? -1 : 1;
    if (a.typed !== b.typed) return a.typed ? -1 : 1;
    if (a.firedAtMs !== b.firedAtMs) return b.firedAtMs - a.firedAtMs;
    if (a.marker.agentId !== b.marker.agentId) return a.marker.agentId < b.marker.agentId ? -1 : 1;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });
  return candidates.map((c) => ({ marker: c.marker, filePath: c.filePath }));
}

function readClaim(value: unknown): MarkerClaim | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<MarkerClaim>;
  if (typeof v.headSha !== 'string' || v.headSha.length === 0) return null;
  if (typeof v.reviewer !== 'string') return null;
  if (typeof v.taskId !== 'string') return null;
  return {
    headSha: v.headSha,
    reviewer: v.reviewer,
    taskId: v.taskId,
    ...(typeof v.transcriptHash === 'string' ? { transcriptHash: v.transcriptHash } : {}),
  };
}

/**
 * Consume a marker so it cannot legitimize a leaf for another head or role.
 *
 * With a `claim` (AISDLC-734) the marker is kept and bound to that (head,
 * reviewer): the SAME run may re-emit its leaf for the same head and keep its
 * class, but no other head can use it, so an old run still cannot be
 * relabeled onto new code. Without a claim the marker is deleted (the earlier
 * behaviour). Best-effort: a failure is not an error for the caller.
 */
export function consumeSubagentMarker(filePath: string, claim?: MarkerClaim | null): void {
  if (claim) {
    try {
      const marker = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...marker, consumedFor: claim }), 'utf8');
      renameSync(tmp, filePath);
      return;
    } catch {
      // Could not bind in place; fall through to deletion, which is the safe side.
      process.stderr.write(
        `[verdict-class] could not bind marker ${filePath} in place; deleting it instead ` +
          `(a re-emit for the same run will not keep its class)\n`,
      );
    }
  }
  try {
    unlinkSync(filePath);
  } catch {
    // The marker counts as consumed for this call. A re-use would need a
    // second matching leaf inside the same window, the same residual gap as
    // before.
  }
}

/**
 * Determine the verdict class for a transcript leaf from markers under
 * `repoRoot` ONLY.
 *
 * Looks for an UNCONSUMED reviewer marker (see {@link selectSubagentMarker})
 * whose `firedAt` is within `MARKER_MAX_AGE_MS` of `transcriptMtimeMs`
 * (either side — a subagent may be dispatched slightly before its
 * transcript's final write). The selected marker is CONSUMED (deleted) so it
 * cannot legitimize a second leaf.
 *
 * Callers that know which reviewer the leaf is for pass `reviewerName` (and
 * `agentId` when they have it); the marker must then belong to that
 * reviewer, so one reviewer's marker is never consumed for another's leaf.
 * A call without `reviewerName` keeps the earlier behaviour of accepting any
 * reviewer-role marker.
 *
 * This function deliberately does NOT search the main checkout or any other
 * directory shared between tasks. A marker in a shared directory may belong
 * to another task's reviewer, and role plus timing cannot tell them apart.
 * Shared-directory markers are credited only by
 * `bindLeafToReviewerRun` (harness-transcript.ts), which additionally
 * requires the diff-binding nonce in that marker's own harness transcript.
 *
 * Fail-safe: any error (missing dir, unreadable file, malformed JSON,
 * missing/invalid `firedAt`) is treated as "no marker" and this function
 * returns `'self-authored'`. It never throws.
 */
export function determineVerdictClass(opts: {
  repoRoot: string;
  transcriptMtimeMs: number;
  reviewerName?: string;
  agentId?: string;
  /** AISDLC-734: head the leaf is for; enables idempotent re-emit (see {@link consumeSubagentMarker}). */
  headSha?: string;
  /** AISDLC-734: task the leaf is for; part of the marker claim. */
  taskId?: string;
}): VerdictClass {
  const claim = buildMarkerClaim(opts.headSha, opts.reviewerName, opts.taskId);
  let selection: SubagentMarkerSelection | null;
  try {
    selection = selectSubagentMarker({
      roots: [opts.repoRoot],
      transcriptMtimeMs: opts.transcriptMtimeMs,
      reviewerName: opts.reviewerName,
      agentId: opts.agentId,
      allowUntyped: false,
      reviewerRolesOnly: true,
      claim,
    });
  } catch {
    return 'self-authored';
  }
  if (!selection) return 'self-authored';
  consumeSubagentMarker(selection.filePath, claim);
  return 'independent';
}

/**
 * Return the mtime (ms since epoch) of a file, or `null` if it cannot be
 * stat'd. Small helper so callers don't need to import `node:fs` directly
 * just for this.
 */
export function fileMtimeMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}
