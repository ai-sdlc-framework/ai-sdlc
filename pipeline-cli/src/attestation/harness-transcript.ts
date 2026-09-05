/**
 * harness-transcript.ts — AISDLC-570 (DEC-0013 → opt1): bind the attestation
 * leaf, at SIGN TIME ONLY, to the reviewer subagent's own harness-captured
 * execution transcript.
 *
 * ## Background
 *
 * [[aisdlc-568]] added `verdictClass` (opt-b): a same-machine heuristic keyed
 * off a `SubagentStart`-hook marker file the coordinator could, in principle,
 * fabricate directly (see `verdict-class.ts`'s honest-limits section). This
 * module implements DEC-0012's other option, opt-a, per the operator-approved
 * design (`docs/design/aisdlc-570-opt-a-feasibility.md`, PR #991) and the
 * DEC-0013 trust-model resolution: **opt1 — sign-time-only, informational.**
 *
 * Claude Code's harness auto-captures every subagent invocation's full
 * multi-turn transcript to a deterministic, coordinator-UNforgeable-without-
 * a-real-spawn path:
 *
 *   `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl`
 *   `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.meta.json`
 *
 * "Unforgeable" here means: the coordinator cannot CHEAPLY fabricate a
 * plausible full multi-turn harness transcript without actually paying for
 * and executing a real `Agent`/`Task` tool call. It does NOT mean OS-level
 * sandboxing — the coordinator runs as the same user and could, in
 * principle, read/copy the file once it exists. See the design doc §2 for
 * the full forgery analysis (attacks a-d) and what this mechanism does and
 * does not close.
 *
 * ## DEC-0013 opt1: sign-time-only, informational
 *
 * `harnessTranscriptHash` is computed and verified ONCE, at sign time, on
 * the operator's own machine, immediately after the reviewer subagent ran —
 * while the ephemeral `~/.claude/projects/**` transcript still exists. It is
 * NOT re-derivable by a downstream CI verifier: a fresh CI runner has no
 * `~/.claude/projects/` at all. This is a materially different trust model
 * from the rest of RFC-0042's Merkle-proof design (built so CI *can*
 * independently re-verify). Once signed, the hash is part of the Merkle leaf
 * that gets hashed + root-signed, so POST-SIGN tampering with a declared
 * `harnessTranscriptHash` is still caught by the root signature — the
 * verifier just cannot independently RE-DERIVE it from scratch.
 *
 * ## Diff-binding via nonce (closes replay of a stale-but-real transcript)
 *
 * A real reviewer transcript from a DIFFERENT diff/commit must not pass. The
 * orchestrating dispatch is expected to embed the same nonce `emit-leaf`
 * will use (see `--nonce` on the `emit-leaf` CLI command) as a literal
 * string via `nonceMarkerLiteral(nonce)` in the reviewer's `Task`/`Agent`
 * prompt BEFORE the reviewer runs. `computeHarnessTranscriptHash` searches
 * the resolved harness transcript for that exact literal string; a
 * transcript missing it fails closed — `harnessTranscriptHash` stays `null`.
 * **This nonce-injection is only useful once the caller (the slash-command
 * body / orchestrator reconcile step) actually embeds the literal in the
 * dispatch prompt — that wiring is NOT part of this module and is tracked
 * as a follow-up (see this task's PR body).** Until that wiring lands,
 * `computeHarnessTranscriptHash` will fail closed for essentially every real
 * invocation (the nonce `emit-leaf` generates today is freshly randomized
 * per call and was never seen by the already-completed reviewer) — this is
 * the correct, safe default: never over-claim.
 *
 * ## Session-id resolution (AISDLC-216-style disclosure)
 *
 * Preferred: caller passes `--claude-session-id` explicitly (the orchestrator
 * would need a reliable source for its own session id — not confirmed
 * available in this investigation, see design doc §4.3 opt-i). Fallback:
 * most-recently-modified session directory under the resolved project slug
 * — the SAME heuristic AISDLC-216 already discloses for `.active-task`
 * sentinel resolution, with the SAME known race window under concurrent
 * sessions. This fallback is never silently accepted as equivalent to the
 * explicit form — `computeHarnessTranscriptHash`'s result records which path
 * was used.
 *
 * ## Composition with AISDLC-572 (role-binding)
 *
 * AISDLC-572 (landed on `main` before this task's own rebase) adds an
 * `agentType` field to the `SubagentStart` marker
 * (`.ai-sdlc/subagent-sessions/<agent-id>.json`) written by
 * `subagent-start.js`, plus the `REVIEWER_AGENT_TYPES` allowlist this module
 * imports directly (re-exported here as `HARNESS_REVIEWER_AGENT_TYPES` for
 * call-site clarity — a single source of truth, not a second driftable
 * copy). The harness's own `agent-<id>.meta.json` sidecar ALSO carries an
 * independent `agentType` claim, written by the harness itself at spawn
 * time. `computeHarnessTranscriptHash` prefers the marker's `agentType`
 * (belt-and-suspenders, cross-checkable against the harness's own claim)
 * and falls back to the harness `.meta.json`'s `agentType` for markers that
 * predate AISDLC-572.
 *
 * ## Honest limits
 *
 * Proves: a real, harness-dispatched subagent invocation produced the
 * transcript for the currently-reviewed diff (once nonce injection is
 * wired) with a reviewer-typed role. Does NOT prove: the subagent's
 * judgment was free of coordinator-engineered prompt bias (design doc §2
 * attack d — not closeable by any transcript-binding mechanism); reviewer
 * identity beyond the `agentType` string the coordinator itself selected at
 * spawn time (attack a, partially mitigated by transcript CONTENT — the
 * first-turn prompt — matching what the harness itself dispatched, not
 * eliminated). Fail-safe: ANY resolution failure (no marker, no transcript,
 * missing nonce, non-reviewer role) returns `null` — never over-claims.
 *
 * @module attestation/harness-transcript
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import {
  MARKER_MAX_AGE_MS,
  REVIEWER_AGENT_TYPES,
  subagentSessionsDir,
  type ReviewerAgentType,
} from './verdict-class.js';

/**
 * Reviewer agent roles eligible to back a `harnessTranscriptHash`. Re-export
 * of `verdict-class.ts`'s `REVIEWER_AGENT_TYPES` (AISDLC-572) — single
 * source of truth, kept in lockstep by construction rather than by
 * discipline.
 */
export const HARNESS_REVIEWER_AGENT_TYPES = REVIEWER_AGENT_TYPES;

export type HarnessReviewerAgentType = ReviewerAgentType;

/** The literal marker string a reviewer dispatch prompt must embed for diff-binding. */
export function nonceMarkerLiteral(nonce: string): string {
  return `[[ai-sdlc-nonce: ${nonce}]]`;
}

/** Result of a read-only (non-consuming) scan for a matching SubagentStart marker. */
export interface HarnessMarkerMatch {
  agentId: string;
  /** `null` for legacy (pre-AISDLC-572) markers that don't carry a role. */
  agentType: string | null;
  firedAt: string;
}

/**
 * Read-only scan of `.ai-sdlc/subagent-sessions/*.json` for a marker whose
 * `firedAt` falls within `MARKER_MAX_AGE_MS` of `transcriptMtimeMs`.
 *
 * Deliberately does NOT consume (delete) the marker — `verdict-class.ts`'s
 * `determineVerdictClass` owns consumption semantics for `verdictClass`.
 * This function only needs the marker's `agentId` (to locate the harness
 * transcript file) and optional `agentType` (once AISDLC-572 lands).
 *
 * Fail-safe: any error (missing dir, unreadable/malformed file) is treated
 * as "no marker" and this function returns `null`. It never throws.
 */
export function findMatchingSubagentMarker(opts: {
  repoRoot: string;
  transcriptMtimeMs: number;
}): HarnessMarkerMatch | null {
  const { repoRoot, transcriptMtimeMs } = opts;
  const dir = subagentSessionsDir(repoRoot);

  let entries: string[];
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  for (const fileName of entries) {
    const filePath = join(dir, fileName);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const marker = JSON.parse(raw) as {
        agentId?: unknown;
        agentType?: unknown;
        firedAt?: unknown;
      };
      if (typeof marker.agentId !== 'string' || typeof marker.firedAt !== 'string') continue;
      const firedAtMs = new Date(marker.firedAt).getTime();
      if (Number.isNaN(firedAtMs)) continue;

      const deltaMs = Math.abs(transcriptMtimeMs - firedAtMs);
      if (deltaMs <= MARKER_MAX_AGE_MS) {
        return {
          agentId: marker.agentId,
          agentType: typeof marker.agentType === 'string' ? marker.agentType : null,
          firedAt: marker.firedAt,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Derive Claude Code's project-slug directory name from an absolute repo
 * root path. Confirmed heuristic (design doc §1, live samples on this
 * machine): every `/` in the absolute path is replaced with `-`.
 */
export function claudeProjectSlug(repoRoot: string): string {
  return repoRoot.replace(/\//g, '-');
}

/** Absolute path of Claude Code's projects directory (`~/.claude/projects`). */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Strict charset a `--claude-session-id` value must match: bare token, no
 * path separators, no `.` at all (so `..` traversal is impossible by
 * construction, not just by luck of `path.join` normalization). Real Claude
 * Code session ids are UUIDs (hex digits + hyphens), so this is not a
 * functional restriction — it exists purely to close the path-traversal
 * attack surface documented below.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Return `true` iff `candidate` resolves (after following any symlinks) to a
 * path contained within `baseDir` (also symlink-resolved). Fails CLOSED
 * (`false`) if either path cannot be realpath-resolved (e.g. does not exist)
 * — callers must treat a `false` result as "reject", not "unknown".
 *
 * This is the second of two independent defenses against path traversal via
 * `--claude-session-id` (the first is `SESSION_ID_PATTERN`, which rejects
 * `..`/`/` lexically before any filesystem access happens at all): even if a
 * lexically-valid session id were combined with a symlink planted inside
 * `~/.claude/projects/<slug>/` that points outside the trusted base, the
 * REALPATH containment check here still refuses it.
 */
function isRealPathContained(baseDir: string, candidate: string): boolean {
  let realBase: string;
  let realCandidate: string;
  try {
    realBase = realpathSync(baseDir);
    realCandidate = realpathSync(candidate);
  } catch {
    return false;
  }
  return realCandidate === realBase || realCandidate.startsWith(realBase + sep);
}

/**
 * Resolve the most-recently-modified session directory under a project-slug
 * directory (the AISDLC-216-style fallback heuristic — see module docblock).
 * Returns `null` when the directory is missing, unreadable, or has no
 * session subdirectories.
 */
export function resolveMostRecentSessionDir(projectSlugDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectSlugDir);
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    const fullPath = join(projectSlugDir, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: fullPath, mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.path : null;
}

export interface ResolveHarnessTranscriptPathResult {
  transcriptPath: string | null;
  metaPath: string | null;
  /** True when the fallback most-recently-modified heuristic was used (not an explicit session id). */
  usedFallbackHeuristic: boolean;
  reason?: string;
}

/**
 * Resolve the absolute path of a subagent's own harness-captured transcript
 * (and its `.meta.json` sidecar, if present).
 *
 * The resolved path is NEVER parameterized by anything a coordinator's
 * `emit-leaf` invocation directly controls beyond `repoRoot` (used only to
 * derive the deterministic project slug) and `agentId` (sourced from the
 * SubagentStart marker, not a free-form CLI flag) — this closes design doc
 * §2 attack (c) (pointing `emit-leaf` at an attacker-controlled path) by
 * construction.
 *
 * **Path-traversal hardening (defense-in-depth, two independent layers):**
 * `--claude-session-id` IS a coordinator-controlled CLI flag (unlike
 * `agentId`), so it gets two independent checks before ever being trusted:
 * (1) `SESSION_ID_PATTERN` rejects any value containing `/`, `\`, or `.`
 * lexically, BEFORE it touches the filesystem at all — a value like
 * `../../../tmp/evil-session` is rejected outright, it never even reaches
 * `path.join`; (2) after the candidate session dir is joined, its REALPATH
 * (symlinks resolved) must be contained within the realpath of the trusted
 * `~/.claude/projects/<slug>/` base — this additionally defeats a symlink
 * planted inside the project dir that points outside it. Without both
 * checks, a coordinator (opt-a's actual target threat model — see the
 * module docblock) could pre-place a directory containing a fabricated
 * `agent-<agentId>.jsonl` (with the nonce and a reviewer `agentType`
 * baked in) and pass its path via `--claude-session-id`, defeating the
 * entire "coordinator cannot cheaply fabricate this" guarantee opt-a exists
 * to provide.
 */
export function resolveHarnessTranscriptPath(opts: {
  repoRoot: string;
  agentId: string;
  claudeSessionId?: string;
}): ResolveHarnessTranscriptPathResult {
  const { repoRoot, agentId, claudeSessionId } = opts;
  const slug = claudeProjectSlug(repoRoot);
  const slugDir = join(claudeProjectsDir(), slug);

  if (!existsSync(slugDir)) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic: false,
      reason: `no Claude Code project directory found at ${slugDir}`,
    };
  }

  const usedFallbackHeuristic = !claudeSessionId;
  let sessionDir: string | null;

  if (claudeSessionId) {
    // Layer 1: strict charset — rejects '..' and path separators lexically,
    // before any filesystem access. Never derived from an existing path, so
    // this check cannot be bypassed by a symlink.
    if (!SESSION_ID_PATTERN.test(claudeSessionId)) {
      return {
        transcriptPath: null,
        metaPath: null,
        usedFallbackHeuristic: false,
        reason: `--claude-session-id '${claudeSessionId}' contains characters outside the allowed charset [A-Za-z0-9-] — refusing (path-traversal hardening)`,
      };
    }
    const candidate = join(slugDir, claudeSessionId);
    if (!existsSync(candidate)) {
      return {
        transcriptPath: null,
        metaPath: null,
        usedFallbackHeuristic: false,
        reason: `explicit --claude-session-id '${claudeSessionId}' not found under ${slugDir}`,
      };
    }
    // Layer 2: realpath containment — defeats a symlink inside slugDir that
    // resolves outside the trusted base.
    if (!isRealPathContained(slugDir, candidate)) {
      return {
        transcriptPath: null,
        metaPath: null,
        usedFallbackHeuristic: false,
        reason: `--claude-session-id '${claudeSessionId}' resolves outside the trusted project directory ${slugDir} — refusing (path-traversal hardening)`,
      };
    }
    sessionDir = candidate;
  } else {
    sessionDir = resolveMostRecentSessionDir(slugDir);
  }

  if (!sessionDir) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic,
      reason: `no session directory resolvable under ${slugDir}`,
    };
  }

  const safeAgentId = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const transcriptPath = join(sessionDir, 'subagents', `agent-${safeAgentId}.jsonl`);
  const metaPath = join(sessionDir, 'subagents', `agent-${safeAgentId}.meta.json`);

  if (!existsSync(transcriptPath)) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic,
      reason: `harness transcript not found at ${transcriptPath}`,
    };
  }

  // Final containment check on the resolved transcript file itself — belt
  // and suspenders against a symlinked *file* (as opposed to a symlinked
  // session directory, already covered above).
  if (!isRealPathContained(slugDir, transcriptPath)) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic,
      reason: `resolved transcript path escapes the trusted project directory ${slugDir} — refusing (path-traversal hardening)`,
    };
  }

  return {
    transcriptPath,
    metaPath: existsSync(metaPath) ? metaPath : null,
    usedFallbackHeuristic,
  };
}

/** Whether a resolved harness transcript's raw bytes contain the diff-binding nonce literal. */
export function transcriptContainsNonce(transcriptPath: string, nonce: string): boolean {
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    return content.includes(nonceMarkerLiteral(nonce));
  } catch {
    return false;
  }
}

/**
 * Read `agentType` from a harness `.meta.json` sidecar, stripping the
 * `ai-sdlc:` namespace prefix used by this framework's agent frontmatter
 * `name:` fields (e.g. `"ai-sdlc:code-reviewer"` → `"code-reviewer"`).
 * Returns `null` on any read/parse failure or missing/non-string field.
 */
export function readHarnessAgentType(metaPath: string | null): string | null {
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { agentType?: unknown };
    if (typeof meta.agentType !== 'string') return null;
    return meta.agentType.replace(/^ai-sdlc:/, '');
  } catch {
    return null;
  }
}

export interface ComputeHarnessTranscriptHashOptions {
  repoRoot: string;
  /** mtime (ms) of the Bash-written reviewer transcript — same window anchor as `verdictClass`. */
  transcriptMtimeMs: number;
  /** The nonce this leaf will carry (see `nonceMarkerLiteral`). */
  nonce: string;
  /** Optional explicit Claude Code session id (preferred over the fallback heuristic). */
  claudeSessionId?: string;
}

export interface ComputeHarnessTranscriptHashResult {
  /** SHA-256 hex of the resolved harness transcript's raw bytes, or `null` if unresolvable/ineligible. */
  harnessTranscriptHash: string | null;
  /** Human-readable reason, always populated — for signer-side observability, never thrown. */
  reason: string;
}

/**
 * Compute the sign-time-only `harnessTranscriptHash` for a reviewer leaf.
 *
 * Fail-safe at every step: any missing marker, unresolvable transcript,
 * non-reviewer role, or missing diff-binding nonce returns
 * `{ harnessTranscriptHash: null, reason: '<why>' }` — never throws, never
 * over-claims. See the module docblock for the full mechanism and honest
 * limits.
 */
export function computeHarnessTranscriptHash(
  opts: ComputeHarnessTranscriptHashOptions,
): ComputeHarnessTranscriptHashResult {
  try {
    const marker = findMatchingSubagentMarker({
      repoRoot: opts.repoRoot,
      transcriptMtimeMs: opts.transcriptMtimeMs,
    });
    if (!marker) {
      return {
        harnessTranscriptHash: null,
        reason: 'no matching SubagentStart marker found within the timing window',
      };
    }

    const resolved = resolveHarnessTranscriptPath({
      repoRoot: opts.repoRoot,
      agentId: marker.agentId,
      claudeSessionId: opts.claudeSessionId,
    });
    if (!resolved.transcriptPath) {
      return {
        harnessTranscriptHash: null,
        reason: resolved.reason ?? 'harness transcript not resolvable',
      };
    }

    // Prefer the (AISDLC-572) marker's own agentType; fall back to the
    // harness's own .meta.json claim. See "Composition with AISDLC-572".
    const agentType = marker.agentType ?? readHarnessAgentType(resolved.metaPath);
    if (
      !agentType ||
      !HARNESS_REVIEWER_AGENT_TYPES.includes(agentType as HarnessReviewerAgentType)
    ) {
      return {
        harnessTranscriptHash: null,
        reason: `resolved agentType '${String(agentType)}' is not a reviewer role`,
      };
    }

    if (!transcriptContainsNonce(resolved.transcriptPath, opts.nonce)) {
      return {
        harnessTranscriptHash: null,
        reason:
          'diff-binding nonce not found in harness transcript ' +
          '(requires the orchestrating dispatch to embed nonceMarkerLiteral(nonce) in the ' +
          "reviewer's prompt BEFORE the reviewer runs — not yet wired end-to-end, see AISDLC-570 PR notes)",
      };
    }

    const bytes = readFileSync(resolved.transcriptPath);
    const harnessTranscriptHash = createHash('sha256').update(bytes).digest('hex');
    return {
      harnessTranscriptHash,
      reason: resolved.usedFallbackHeuristic
        ? 'ok (session-id resolved via most-recently-modified heuristic — disclosed race window, AISDLC-216-style)'
        : 'ok (explicit --claude-session-id)',
    };
  } catch (err) {
    return {
      harnessTranscriptHash: null,
      reason: `unexpected error during harness-transcript resolution: ${String(err)}`,
    };
  }
}
