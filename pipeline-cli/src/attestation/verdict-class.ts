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
 *     the need to actually spawn a subagent. Role-binding (this task) raises
 *     the bar against ACCIDENTAL or lazy self-review (the common case: the
 *     coordinator running the reviewer's own prescribed Bash steps itself,
 *     or reusing an unrelated real marker from a non-reviewer subagent) —
 *     it does not defend against a deliberately adversarial coordinator
 *     willing to also forge `agent_type`. Closing that gap requires binding
 *     the leaf to the reviewer subagent's own harness-captured execution
 *     transcript — the harness-coupled follow-up tracked as DEC-0012 opt-a
 *     / AISDLC-570.
 *   - Fail-safe default: ANY missing, malformed, non-reviewer, or stale
 *     marker resolves to the LOWER-trust `self-authored` class — this
 *     function never over-claims `independent`.
 *
 * @module attestation/verdict-class
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
 * Determine the verdict class for a transcript leaf.
 *
 * Scans `subagentSessionsDir(repoRoot)` for marker files whose `firedAt`
 * timestamp is within `MARKER_MAX_AGE_MS` of `transcriptMtimeMs` (either
 * side — a subagent may be dispatched slightly before its transcript's
 * final write). The first qualifying marker found is CONSUMED (deleted) so
 * it cannot legitimize a second leaf.
 *
 * Fail-safe: any error (missing dir, unreadable file, malformed JSON,
 * missing/invalid `firedAt`) is treated as "no marker" and this function
 * returns `'self-authored'`. It never throws.
 */
export function determineVerdictClass(opts: {
  repoRoot: string;
  transcriptMtimeMs: number;
}): VerdictClass {
  const { repoRoot, transcriptMtimeMs } = opts;
  const dir = subagentSessionsDir(repoRoot);

  let entries: string[];
  try {
    if (!existsSync(dir)) return 'self-authored';
    entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 'self-authored';
  }

  for (const fileName of entries) {
    const filePath = join(dir, fileName);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const marker = JSON.parse(raw) as Partial<SubagentStartMarker>;

      // AISDLC-572: role gate BEFORE the timing check. A non-reviewer or
      // missing/null agentType (including legacy pre-572 markers) never
      // qualifies, regardless of how well its timing lines up.
      if (
        typeof marker.agentType !== 'string' ||
        !REVIEWER_AGENT_TYPES.includes(marker.agentType as ReviewerAgentType)
      ) {
        continue;
      }

      if (typeof marker.firedAt !== 'string') continue;
      const firedAtMs = new Date(marker.firedAt).getTime();
      if (Number.isNaN(firedAtMs)) continue;

      const deltaMs = Math.abs(transcriptMtimeMs - firedAtMs);
      if (deltaMs <= MARKER_MAX_AGE_MS) {
        // Consume: remove so a single subagent spawn cannot back-stop
        // multiple leaves. Best-effort — if the unlink fails we still
        // return 'independent' for THIS leaf (the marker existed and
        // matched); a leftover file only risks over-crediting a future
        // leaf, which is the fail-open direction we accept here since the
        // window is short (30 min, MARKER_MAX_AGE_MS) and the file is local-disk only.
        try {
          unlinkSync(filePath);
        } catch {
          // ignore — best-effort consumption
        }
        return 'independent';
      }
    } catch {
      continue;
    }
  }

  return 'self-authored';
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
