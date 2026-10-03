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

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
  const expectedRole =
    query.reviewerName !== undefined ? stripAgentTypeNamespace(query.reviewerName) : undefined;
  if (query.reviewerName !== undefined && !expectedRole) return null;
  if (query.agentId !== undefined && !AGENT_ID_PATTERN.test(query.agentId)) return null;

  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  const candidates: Array<SubagentMarkerSelection & { firedAtMs: number; typed: boolean }> = [];

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
          },
          filePath,
          firedAtMs,
          typed: role !== null,
        });
      } catch {
        continue;
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.typed !== b.typed) return a.typed ? -1 : 1;
    if (a.firedAtMs !== b.firedAtMs) return b.firedAtMs - a.firedAtMs;
    if (a.marker.agentId !== b.marker.agentId) return a.marker.agentId < b.marker.agentId ? -1 : 1;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });
  const best = candidates[0]!;
  return { marker: best.marker, filePath: best.filePath };
}

/**
 * Determine the verdict class for a transcript leaf.
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
 * `extraRoots` adds directories to search besides `repoRoot` — the main
 * checkout when `repoRoot` is a task worktree. A call without `reviewerName`
 * keeps the earlier behaviour of accepting any reviewer-role marker.
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
  extraRoots?: readonly string[];
}): VerdictClass {
  let selection: SubagentMarkerSelection | null;
  try {
    selection = selectSubagentMarker({
      roots: [opts.repoRoot, ...(opts.extraRoots ?? [])],
      transcriptMtimeMs: opts.transcriptMtimeMs,
      reviewerName: opts.reviewerName,
      agentId: opts.agentId,
      allowUntyped: false,
      reviewerRolesOnly: true,
    });
  } catch {
    return 'self-authored';
  }
  if (!selection) return 'self-authored';

  // Consume exactly the selected marker so it cannot be re-used for another leaf.
  try {
    unlinkSync(selection.filePath);
  } catch {
    // Best-effort: if deletion fails the marker is still considered consumed
    // for this call; a re-use would need a second matching leaf inside the
    // same window, which is the same residual gap as before.
  }
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
