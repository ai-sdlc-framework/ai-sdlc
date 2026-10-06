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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  REVIEWER_AGENT_TYPES,
  consumeSubagentMarker,
  determineVerdictClass,
  buildMarkerClaim,
  listSubagentMarkerCandidates,
  selectSubagentMarker,
  stripAgentTypeNamespace,
  type ReviewerAgentType,
  type SubagentMarkerSelection,
  type VerdictClass,
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
  /** The reviewer the leaf is for. A marker typed for another role never matches. */
  reviewerName?: string;
  /** Harness agent id of the reviewer run. When given, only that agent's marker matches. */
  agentId?: string;
  /** Further directories to search for markers (see {@link markerSearchRoots}). */
  extraRoots?: readonly string[];
}): HarnessMarkerMatch | null {
  try {
    const selection = selectSubagentMarker({
      roots: [opts.repoRoot, ...(opts.extraRoots ?? [])],
      transcriptMtimeMs: opts.transcriptMtimeMs,
      reviewerName: opts.reviewerName,
      agentId: opts.agentId,
      // Legacy markers carry no role; the caller then checks the harness's
      // own `.meta.json` role claim before trusting the transcript.
      allowUntyped: true,
    });
    if (!selection) return null;
    return {
      agentId: selection.marker.agentId,
      agentType: selection.marker.agentType,
      firedAt: selection.marker.firedAt,
    };
  } catch {
    return null;
  }
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
 * Resolve the MAIN checkout root of the repo `repoRoot` belongs to, or
 * `null` when it cannot be determined (not a git repo, `git` unavailable,
 * or unexpected `--git-common-dir` output).
 *
 * AISDLC-589 Gap A: in a Pattern-C layout (non-bare parent repo +
 * `.worktrees/<task-id>/` linked worktrees), a reviewer subagent is
 * dispatched with `repoRoot` pointing at the WORKTREE, but the top-level
 * Claude Code session — and therefore its `~/.claude/projects/<slug>/`
 * transcript directory — was launched from the PARENT (main checkout) path.
 * `claudeProjectSlug(repoRoot)` on the worktree path produces a slug that
 * has never existed on disk, so every worktree-dispatched reviewer's
 * `harnessTranscriptHash` silently resolved to `null` even with a genuine
 * marker + transcript present under the main checkout's slug.
 *
 * `git rev-parse --git-common-dir` returns the `.git` directory shared by
 * every linked worktree of a repo — for a linked worktree this is the MAIN
 * checkout's `.git` directory (not the worktree's own
 * `.git/worktrees/<id>` administrative dir), so its parent is the main
 * checkout root. For a non-worktree checkout (`--git-common-dir` returns
 * `.git` relative to `repoRoot` itself), this resolves back to `repoRoot`
 * unchanged — safe no-op.
 */
export function resolveMainCheckoutRoot(repoRoot: string): string | null {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!commonDir) return null;
    const commonDirAbs = resolve(repoRoot, commonDir);
    if (basename(commonDirAbs) !== '.git') return null;
    return dirname(commonDirAbs);
  } catch {
    return null;
  }
}

/**
 * Resolve the directory whose slug (`claudeProjectSlug`) should be used to
 * locate the Claude Code project transcripts directory.
 *
 * Precedence: explicit `--project-dir` override (caller-supplied, no git
 * involved — useful when `git rev-parse` is unavailable/unreliable, or the
 * caller already knows the exact directory Claude Code was launched from) >
 * the git-derived main checkout root (`resolveMainCheckoutRoot`) > `repoRoot`
 * itself (fail-safe fallback preserving pre-AISDLC-589 behavior when the
 * git lookup fails, e.g. `repoRoot` isn't a git repo at all).
 */
export function resolveClaudeProjectRoot(opts: {
  repoRoot: string;
  projectDirOverride?: string;
}): string {
  if (opts.projectDirOverride) return resolve(opts.projectDirOverride);
  return resolveMainCheckoutRoot(opts.repoRoot) ?? opts.repoRoot;
}

/**
 * Directories that may hold the harness-written `SubagentStart` markers for
 * a pipeline run, besides `repoRoot` itself.
 *
 * The `SubagentStart` hook writes a marker under the directory the Claude
 * Code SESSION was started in. In the worktree layout (`--repo-root` is
 * `.worktrees/<task-id>/`) that is the main checkout, not the worktree, so
 * a lookup that only reads `<repoRoot>/.ai-sdlc/subagent-sessions/` never
 * finds a marker and every leaf is classed `self-authored` even though
 * independent reviewers ran. This returns the main checkout root (derived
 * from git) and the explicit `--project-dir` override, when they differ
 * from `repoRoot`.
 */
export function markerSearchRoots(opts: {
  repoRoot: string;
  projectDirOverride?: string;
}): string[] {
  // Compare on real paths so one directory is never listed twice under two
  // spellings (git reports /private/var/... where the caller passed /var/...).
  const real = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  const own = real(opts.repoRoot);
  const roots: string[] = [];
  const seen = new Set<string>([own]);
  const add = (dir: string | null | undefined): void => {
    if (!dir) return;
    const key = real(dir);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(resolve(dir));
  };
  add(resolveMainCheckoutRoot(opts.repoRoot));
  add(opts.projectDirOverride);
  return roots;
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
  /**
   * True when a most-recently-modified heuristic decided the session
   * directory: no explicit session id was given AND the agent's transcript
   * could not be pinned to exactly one session directory by its agent id.
   */
  usedFallbackHeuristic: boolean;
  reason?: string;
}

/**
 * Find the session directory under `projectSlugDir` that holds
 * `subagents/agent-<safeAgentId>.jsonl`.
 *
 * Agent ids are unique per subagent run, so this normally yields exactly one
 * directory, and the result does not depend on which session was written to
 * last. That matters when several Claude Code sessions share one project
 * directory (an operator session plus executors): "the most recently
 * modified session" is then usually the wrong one. If more than one
 * directory holds the file, the one whose transcript is newest is returned
 * and `unique` is false.
 */
export function locateSessionDirByAgentId(
  projectSlugDir: string,
  safeAgentId: string,
): { sessionDir: string | null; unique: boolean } {
  let entries: string[];
  try {
    entries = readdirSync(projectSlugDir).sort();
  } catch {
    return { sessionDir: null, unique: false };
  }
  const hits: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const dir = join(projectSlugDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const st = statSync(join(dir, 'subagents', `agent-${safeAgentId}.jsonl`));
      if (st.isFile()) hits.push({ path: dir, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  if (hits.length === 0) return { sessionDir: null, unique: false };
  hits.sort((x, y) => y.mtimeMs - x.mtimeMs || (x.path < y.path ? -1 : 1));
  return { sessionDir: hits[0]!.path, unique: hits.length === 1 };
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
  /**
   * AISDLC-589 Gap A: explicit override for the directory whose slug is
   * used to resolve `~/.claude/projects/<slug>/`. When omitted, the
   * git-derived main-checkout root is used (see `resolveClaudeProjectRoot`).
   */
  projectDirOverride?: string;
}): ResolveHarnessTranscriptPathResult {
  const { repoRoot, agentId, claudeSessionId, projectDirOverride } = opts;
  const projectRoot = resolveClaudeProjectRoot({ repoRoot, projectDirOverride });
  const slug = claudeProjectSlug(projectRoot);
  const slugDir = join(claudeProjectsDir(), slug);

  if (!existsSync(slugDir)) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic: false,
      reason: `no Claude Code project directory found at ${slugDir}`,
    };
  }

  const safeAgentId = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  let usedFallbackHeuristic = !claudeSessionId;
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
    // Pin the session by the agent's own transcript file; fall back to the
    // most-recently-modified session only when no session holds it (the
    // "not found" result below then names the path that was expected).
    const located = locateSessionDirByAgentId(slugDir, safeAgentId);
    if (located.sessionDir) {
      sessionDir = located.sessionDir;
      usedFallbackHeuristic = !located.unique;
    } else {
      sessionDir = resolveMostRecentSessionDir(slugDir);
    }
  }

  if (!sessionDir) {
    return {
      transcriptPath: null,
      metaPath: null,
      usedFallbackHeuristic,
      reason: `no session directory resolvable under ${slugDir}`,
    };
  }

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
 * Read `agentType` from a harness `.meta.json` sidecar, stripping any
 * plugin namespace prefix via `stripAgentTypeNamespace()` (e.g.
 * `"ai-sdlc:code-reviewer"` → `"code-reviewer"`). Returns `null` on any
 * read/parse failure or missing/non-string field.
 */
export function readHarnessAgentType(metaPath: string | null): string | null {
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { agentType?: unknown };
    if (typeof meta.agentType !== 'string') return null;
    return stripAgentTypeNamespace(meta.agentType);
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
  /**
   * AISDLC-589 Gap A: explicit override for the directory whose slug is
   * used to resolve `~/.claude/projects/<slug>/`. When omitted, the
   * git-derived main-checkout root is used — see `resolveClaudeProjectRoot`.
   */
  projectDirOverride?: string;
  /**
   * The reviewer the leaf is for (`--reviewer`). The marker, and the role the
   * harness recorded for the transcript, must be this reviewer's; otherwise
   * the hash stays `null`. Without it any reviewer-role marker is accepted
   * (earlier behaviour).
   */
  reviewerName?: string;
  /** Harness agent id of the reviewer run, when the caller has it. */
  agentId?: string;
  /** AISDLC-734: head the leaf is for; lets the same run re-emit for the same head. */
  headSha?: string;
  /** AISDLC-734: task the leaf is for; part of the marker claim. */
  taskId?: string;
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
/**
 * Check ONE marker against the harness evidence: its transcript must resolve
 * inside the trusted project directory, the role the harness recorded must be
 * a reviewer role (and the leaf's reviewer, when known), and the transcript
 * must contain the diff-binding nonce. Returns the transcript hash, or `null`
 * with the reason. Never throws.
 */
function hashForMarker(
  marker: HarnessMarkerMatch,
  opts: ComputeHarnessTranscriptHashOptions,
): ComputeHarnessTranscriptHashResult {
  try {
    const resolved = resolveHarnessTranscriptPath({
      repoRoot: opts.repoRoot,
      agentId: marker.agentId,
      claudeSessionId: opts.claudeSessionId,
      projectDirOverride: opts.projectDirOverride,
    });
    if (!resolved.transcriptPath) {
      return {
        harnessTranscriptHash: null,
        reason: resolved.reason ?? 'harness transcript not resolvable',
      };
    }

    // Prefer the (AISDLC-572) marker's own agentType; fall back to the
    // harness's own .meta.json claim. See "Composition with AISDLC-572".
    // AISDLC-589 Gap B: normalize the marker's agentType (may carry a
    // plugin namespace prefix, e.g. `ai-sdlc:code-reviewer`) before
    // matching — readHarnessAgentType already normalizes the .meta.json
    // fallback, so this keeps both paths symmetric.
    const agentType =
      stripAgentTypeNamespace(marker.agentType) ?? readHarnessAgentType(resolved.metaPath);
    if (
      !agentType ||
      !HARNESS_REVIEWER_AGENT_TYPES.includes(agentType as HarnessReviewerAgentType)
    ) {
      return {
        harnessTranscriptHash: null,
        reason: `resolved agentType '${String(agentType)}' is not a reviewer role`,
      };
    }

    // Bind to the reviewer the leaf names: a transcript the harness recorded
    // for a different reviewer role must never back this leaf.
    const expectedRole =
      opts.reviewerName !== undefined ? stripAgentTypeNamespace(opts.reviewerName) : null;
    if (expectedRole && agentType !== expectedRole) {
      return {
        harnessTranscriptHash: null,
        reason: `resolved agentType '${agentType}' does not match the leaf's reviewer '${expectedRole}'`,
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
        : opts.claudeSessionId
          ? 'ok (explicit --claude-session-id)'
          : 'ok (session resolved by the agent id of the marker)',
    };
  } catch (err) {
    return {
      harnessTranscriptHash: null,
      reason: `unexpected error during harness-transcript resolution: ${String(err)}`,
    };
  }
}

/** Markers that could belong to this leaf's reviewer run, best first. */
function markerCandidates(opts: ComputeHarnessTranscriptHashOptions): SubagentMarkerSelection[] {
  return listSubagentMarkerCandidates({
    roots: [
      opts.repoRoot,
      ...markerSearchRoots({
        repoRoot: opts.repoRoot,
        projectDirOverride: opts.projectDirOverride,
      }),
    ],
    transcriptMtimeMs: opts.transcriptMtimeMs,
    reviewerName: opts.reviewerName,
    agentId: opts.agentId,
    // Legacy markers carry no role; hashForMarker then checks the harness's
    // own `.meta.json` role claim before trusting the transcript.
    allowUntyped: true,
    claim: buildMarkerClaim(opts.headSha, opts.reviewerName, opts.taskId),
  });
}

/** The candidate whose harness transcript proves it belongs to this leaf, if any. */
function findNonceVerifiedMarker(opts: ComputeHarnessTranscriptHashOptions): {
  selection: SubagentMarkerSelection | null;
  result: ComputeHarnessTranscriptHashResult;
} {
  const candidates = markerCandidates(opts);
  if (candidates.length === 0) {
    return {
      selection: null,
      result: {
        harnessTranscriptHash: null,
        reason: 'no matching SubagentStart marker found within the timing window',
      },
    };
  }
  let firstFailure: ComputeHarnessTranscriptHashResult | null = null;
  for (const selection of candidates) {
    const result = hashForMarker(selection.marker, opts);
    // A marker already bound to a transcript is re-usable only for that same
    // transcript: a different one for the same head and reviewer is not the run.
    const boundHash = selection.marker.consumedFor?.transcriptHash;
    if (boundHash && result.harnessTranscriptHash && boundHash !== result.harnessTranscriptHash) {
      firstFailure ??= {
        harnessTranscriptHash: null,
        reason: 'marker already bound to a different transcript',
      };
      continue;
    }
    if (result.harnessTranscriptHash) return { selection, result };
    firstFailure ??= result;
  }
  return { selection: null, result: firstFailure as ComputeHarnessTranscriptHashResult };
}

export function computeHarnessTranscriptHash(
  opts: ComputeHarnessTranscriptHashOptions,
): ComputeHarnessTranscriptHashResult {
  try {
    // Every candidate marker is checked, not only the first: when several
    // tasks share a main checkout, the most recent marker of a role may be
    // another task's reviewer, whose transcript does not carry this nonce.
    return findNonceVerifiedMarker(opts).result;
  } catch (err) {
    return {
      harnessTranscriptHash: null,
      reason: `unexpected error during harness-transcript resolution: ${String(err)}`,
    };
  }
}

export interface LeafBinding extends ComputeHarnessTranscriptHashResult {
  verdictClass: VerdictClass;
}

/**
 * Decide, in ONE selection, which reviewer run a leaf belongs to, and derive
 * both `harnessTranscriptHash` and `verdictClass` from it.
 *
 * 1. Among the markers of the leaf's reviewer (under `repoRoot`, the main
 *    checkout and `--project-dir`), find one whose own harness transcript
 *    carries this leaf's diff-binding nonce. That run reviewed THIS diff.
 *    The hash is that transcript's; the class is `independent` when the
 *    marker is typed; exactly that marker is consumed.
 * 2. Otherwise the hash is `null`, and the class falls back to
 *    {@link determineVerdictClass}: a role-matched marker under `repoRoot`
 *    itself. Markers in directories shared between tasks are NOT credited
 *    without the nonce, because role and timing cannot tell this task's
 *    reviewer from another task's.
 *
 * Deriving both fields from the same marker also removes the window in which
 * a parallel `emit-leaf` could consume the marker between two separate
 * selections. Never throws.
 */
export function bindLeafToReviewerRun(opts: ComputeHarnessTranscriptHashOptions): LeafBinding {
  let found: ReturnType<typeof findNonceVerifiedMarker>;
  try {
    found = findNonceVerifiedMarker(opts);
  } catch (err) {
    found = {
      selection: null,
      result: {
        harnessTranscriptHash: null,
        reason: `unexpected error during harness-transcript resolution: ${String(err)}`,
      },
    };
  }

  if (found.selection && found.result.harnessTranscriptHash) {
    const role = stripAgentTypeNamespace(found.selection.marker.agentType);
    const typedReviewer =
      role !== null && HARNESS_REVIEWER_AGENT_TYPES.includes(role as HarnessReviewerAgentType);
    if (typedReviewer) {
      const claim = buildMarkerClaim(opts.headSha, opts.reviewerName, opts.taskId);
      consumeSubagentMarker(
        found.selection.filePath,
        claim ? { ...claim, transcriptHash: found.result.harnessTranscriptHash } : claim,
      );
      return { ...found.result, verdictClass: 'independent' };
    }
    // An untyped (legacy) marker backs the hash through the harness's own
    // role claim, but it never earned `independent` on its own and still
    // does not. No other marker is consulted: one leaf, one run.
    return { ...found.result, verdictClass: 'self-authored' };
  }

  return {
    ...found.result,
    verdictClass: determineVerdictClass({
      repoRoot: opts.repoRoot,
      transcriptMtimeMs: opts.transcriptMtimeMs,
      reviewerName: opts.reviewerName,
      agentId: opts.agentId,
      headSha: opts.headSha,
      taskId: opts.taskId,
    }),
  };
}
