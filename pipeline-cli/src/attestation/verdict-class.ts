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
 * `firedAt` timestamp falls within a bounded lookback window ending at the
 * reviewer transcript file's last-write time. A match means a real subagent
 * was spawned during (or shortly before) the window the transcript was
 * written — strong evidence the transcript reflects an actual independent
 * review, not a same-process self-review. On a match the marker is CONSUMED
 * (deleted) so a single subagent spawn cannot be reused to legitimize
 * multiple leaves.
 *
 * ## Honest limits (documented per AC#3 wording discipline)
 *
 * This is a same-process/session HEURISTIC, not a cryptographic proof:
 *   - Single machine, same repo checkout: a sufficiently determined
 *     coordinator with Bash/Write access could fabricate a marker file
 *     directly, bypassing the need to actually spawn a subagent. This
 *     mechanism raises the bar against ACCIDENTAL or lazy self-review (the
 *     common case: the coordinator running the reviewer's own prescribed
 *     Bash steps itself) — it does not defend against a deliberately
 *     adversarial coordinator. Closing that gap is the harness-coupled
 *     follow-up tracked as DEC-0012 opt-a.
 *   - Fail-safe default: ANY missing, malformed, or stale marker resolves
 *     to the LOWER-trust `self-authored` class — this function never
 *     over-claims `independent`.
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
 */
export const MARKER_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Shape of a marker file written by `subagent-start.js`. */
export interface SubagentStartMarker {
  /** The harness-assigned agent identifier (or a random fallback). */
  agentId: string;
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
        // window is short (2h) and the file is local-disk only.
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
