/**
 * RFC-0024 Refit Phase 4 (AISDLC-276) — PR-comment bidirectional sync +
 * LLM auto-classifier.
 *
 * Closes the OQ-3 (2026-05-15) gap: pre-Phase-4 only PR comments that
 * carried the explicit `<!-- ai-sdlc:capture ... -->` marker (parsed by
 * `pr-comment-parser.ts`) became captures, losing ~80% of actual review
 * signal because busy reviewers don't reliably tag.
 *
 * This module composes the shipped pieces:
 *
 *   1. `pr-comment-parser` — fast marker detection (no LLM call).
 *   2. The shared classifier substrate (`classifier/substrate`) — Haiku
 *      classifier for the `pr-comment-is-capture` task type.
 *   3. `capture-writer` / `draft-capture` — the persistence layer that
 *      turns a positive classification into a real capture record.
 *
 * The composition + the bidirectional-sync marker helpers are the only
 * new surface; no capture-record-shape changes and no new persistence.
 *
 * ## Routing rules (AC-1..AC-5)
 *
 *   - Marker present (`pr-comment-parser` returns `found: true`) →
 *     **bypass classifier**, return `kind: 'marker'` decision so callers
 *     write the capture with the operator-supplied severity/triage.
 *   - Author looks like an AI-agent bot (`source-agent-<role>` / GitHub
 *     bot login / well-known reviewer logins per the trusted-marker
 *     allowlist) → **bypass classifier**, return `kind: 'ai-agent'`. The
 *     agent already typed the finding; double-classifying wastes tokens.
 *   - Otherwise → invoke the substrate's `classify()` with task type
 *     `pr-comment-is-capture`. **Threshold default 0.5** (per the 2026-05-15
 *     OQ-3 resolution — looser than the substrate's 0.7 default because
 *     "is this worth indexing" is a lower bar than "is this triage right").
 *     - `is-capture` + confidence ≥ 0.5 → `kind: 'classified-capture'`
 *     - `not-capture` or confidence < 0.5 → `kind: 'classified-skip'`
 *     - Substrate fall-open (no invoker / invoker error) → `kind: 'classified-skip'`
 *       (safe default — the caller never silently misses a high-signal
 *       comment because the classifier short-circuited; the operator can
 *       re-run when the invoker is available).
 *
 * ## Bidirectional sync (AC-6, AC-7)
 *
 * Once a capture is indexed (any of the 3 positive kinds), the caller
 * appends a `<!-- ai-sdlc:capture-id=<id> -->` footer to the GitHub
 * comment via `appendCaptureMarkerToComment()`. This marker:
 *
 *   - Survives the comment-edit / new-webhook loop (idempotent — won't
 *     append a second marker if one is already present per AC-7's "GitHub
 *     edit-wins; capture re-syncs on next webhook" rule).
 *   - Lets the next sync pass recognise the comment is already linked to
 *     a capture, so we don't double-index. AC-6 = "GitHub-edit-wins":
 *     when the comment body changes (e.g. the reviewer added more
 *     context), the existing capture stays the source of truth and the
 *     re-sync just updates the comment marker; the *capture record* is
 *     immutable per RFC-0024 §11.
 *
 * @module capture/pr-comment-classifier
 */

import { classify } from '../classifier/substrate/index.js';
import type { ClassifierDecision, ClassifyOpts } from '../classifier/substrate/index.js';
import { parsePrCommentMarker, type GhPrReviewComment } from './pr-comment-parser.js';

// ── Public threshold default ─────────────────────────────────────────────────

/**
 * Per OQ-3 (2026-05-15): the PR-comment classifier uses 0.5 — looser than
 * the substrate's default 0.7. Rationale: "is this worth indexing?" is a
 * lower bar than "is this triage classification correct?". A 0.5
 * threshold catches signal that busy reviewers wouldn't have tagged,
 * accepting some false positives for the operator to re-classify (or
 * redact) at triage time.
 *
 * Per-org override: `.ai-sdlc/capture-config.yaml`'s
 * `classifier.perTaskType.pr-comment-is-capture.threshold` field
 * (resolved by the substrate's `loadSubstrateConfig`). Tests + callers
 * may pass `opts.threshold` to override at call site.
 */
export const PR_COMMENT_DEFAULT_THRESHOLD = 0.5;

// ── AI-agent bot detection ───────────────────────────────────────────────────

/**
 * Logins that the framework treats as AI-agent / bot-authored. Comments
 * from these authors bypass the classifier (their findings are already
 * typed — the originating agent applied its own triage/severity at
 * capture time, so the classifier would just spend tokens to re-derive
 * the same answer).
 *
 * Kept narrow on purpose: the false-negative cost (missing one bot's
 * comment) is bounded by re-running the classifier; the false-positive
 * cost (an opinionated human's comment being silently bypassed because
 * we matched their login as "looks like a bot") is harder to recover from.
 *
 * Mirrors `TRUSTED_MARKER_AUTHOR_LOGINS` in
 * `pipeline-cli/src/incremental-review/incremental.ts` for the same
 * trusted-bot set — both module's purposes coincide (a comment we'd
 * trust as authored by us, the framework, OR by a known agent).
 */
export const AI_AGENT_BOT_LOGINS: ReadonlySet<string> = new Set([
  'github-actions',
  'github-actions[bot]',
  'ai-sdlc-bot',
  'ai-sdlc-bot[bot]',
  'ai-sdlc-ci-attestor[bot]',
]);

/**
 * Heuristic: return true when the comment author's login looks like an
 * AI-agent bot. Two signals:
 *
 *   1. The login is in `AI_AGENT_BOT_LOGINS`.
 *   2. The login ends in `[bot]` (GitHub's bot-account convention).
 *
 * The second rule catches GitHub Apps the framework hasn't seen before;
 * combined with the first rule it gives us reasonable coverage without
 * needing a centralised registry.
 */
export function isAiAgentAuthor(comment: GhPrReviewComment): boolean {
  const login = comment.author?.login;
  if (!login) return false;
  if (AI_AGENT_BOT_LOGINS.has(login)) return true;
  return login.endsWith('[bot]');
}

// ── Decision shape ───────────────────────────────────────────────────────────

/**
 * The classifier's verdict for a single PR comment. `kind` discriminates
 * how the verdict was reached:
 *
 *   - `marker`              — comment had `ai-sdlc:capture` marker; we
 *                              bypass the classifier and pull severity /
 *                              triage out of the marker. AC-4.
 *   - `ai-agent`            — comment author is an AI-agent bot; we
 *                              bypass and treat the body as the finding
 *                              text. AC-5.
 *   - `classified-capture`  — classifier returned `is-capture` with
 *                              confidence ≥ threshold. AC-1, AC-2.
 *   - `classified-skip`     — classifier returned `not-capture`,
 *                              confidence < threshold, or fall-open. AC-3.
 *   - `already-linked`      — the comment already carries a
 *                              `<!-- ai-sdlc:capture-id=... -->` footer
 *                              (we previously indexed it). AC-7
 *                              idempotence guard — no re-classification,
 *                              no new capture, no duplicate marker
 *                              append.
 */
export type ClassifyPrCommentDecision =
  | { kind: 'marker'; finding: string; severity?: string; triage?: string }
  | { kind: 'ai-agent'; finding: string }
  | { kind: 'classified-capture'; finding: string; decision: ClassifierDecision }
  | {
      kind: 'classified-skip';
      reason: 'not-capture' | 'below-threshold' | 'classifier-fall-open';
      decision: ClassifierDecision | null;
    }
  | { kind: 'already-linked'; existingCaptureId: string };

// ── Capture-ID marker (bidirectional sync) ───────────────────────────────────

/**
 * The footer marker we append to a GitHub PR comment after indexing it
 * as a capture (AC-7). Pattern:
 *
 *   <!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abcdef -->
 *
 * The regex below is strict to avoid matching content that incidentally
 * mentions the marker text inside code blocks or quoted text — we only
 * match the HTML-comment form.
 */
export const CAPTURE_ID_MARKER_PREFIX = '<!-- ai-sdlc:capture-id=';
const CAPTURE_ID_MARKER_REGEX = /<!--\s*ai-sdlc:capture-id=([a-zA-Z0-9_\-:]+)\s*-->/;

/**
 * If the comment body already carries a `<!-- ai-sdlc:capture-id=... -->`
 * footer, return the captured id. Otherwise return `null`.
 *
 * Used by `classifyPrCommentForCapture()` to short-circuit re-indexing
 * (AC-7 idempotence) and by `syncPrCommentChanges()` to detect that a
 * comment edit is a re-sync rather than a new capture.
 */
export function extractCaptureIdFromComment(commentBody: string): string | null {
  const m = commentBody.match(CAPTURE_ID_MARKER_REGEX);
  return m ? m[1] : null;
}

/**
 * Append the capture-id footer marker to a comment body. Idempotent: if
 * a marker for the same `captureId` already exists, returns the body
 * unchanged. If a marker for a DIFFERENT capture id exists, the existing
 * marker stays (GitHub-edit-wins per AC-6 — the original linkage is the
 * source of truth) and the new one is NOT appended.
 *
 * Returns `{body, changed, alreadyLinked}` so callers can decide whether
 * to issue an `update-comment` API call (changed=true) or skip it
 * (changed=false).
 */
export function appendCaptureMarkerToComment(
  commentBody: string,
  captureId: string,
): { body: string; changed: boolean; alreadyLinked: boolean } {
  const existing = extractCaptureIdFromComment(commentBody);
  if (existing === captureId) {
    return { body: commentBody, changed: false, alreadyLinked: true };
  }
  if (existing && existing !== captureId) {
    // GitHub-edit-wins (AC-6): keep the original linkage, do not
    // overwrite. Caller decides whether to log / surface the collision.
    return { body: commentBody, changed: false, alreadyLinked: true };
  }
  const trimmed = commentBody.replace(/\s+$/, '');
  const sep = trimmed.length === 0 ? '' : '\n\n';
  const body = `${trimmed}${sep}${CAPTURE_ID_MARKER_PREFIX}${captureId} -->\n`;
  return { body, changed: true, alreadyLinked: false };
}

// ── Classifier entry point ───────────────────────────────────────────────────

/**
 * Options for `classifyPrCommentForCapture()`. All inherit from the
 * substrate's `ClassifyOpts`; we expose them at this layer so callers can
 * inject the test invoker, override the threshold per-call, or redirect
 * the corpus directory to a tmpdir.
 *
 * `treatAuthorAsAiAgent` — explicit caller override. When the caller has
 * out-of-band knowledge that an author is an AI agent (e.g. a custom
 * reviewer subagent posting via the GitHub API), passing `true` bypasses
 * the classifier even when the login wouldn't match the heuristic.
 */
export interface ClassifyPrCommentOpts extends ClassifyOpts {
  /**
   * Per-call threshold override. When undefined, uses
   * `PR_COMMENT_DEFAULT_THRESHOLD` (0.5). Callers MAY pass 0.0 in tests
   * to force every classified comment to pass the threshold, or 1.01 to
   * force every comment to fail (useful for `classified-skip` tests).
   *
   * Note: this OVERRIDES the substrate's per-task-type config-resolved
   * threshold. The substrate's default (0.7) is appropriate for the
   * other 4 task types (capture-triage / capture-severity /
   * dor-answer-is-new-concern / decision-recommendation) but NOT for
   * pr-comment-is-capture — see the module header docstring for the
   * rationale.
   */
  threshold?: number;
  /**
   * Force AI-agent bypass even when the author login wouldn't match
   * `isAiAgentAuthor`. Useful for tests + for callers wrapping a custom
   * subagent dispatch.
   */
  treatAuthorAsAiAgent?: boolean;
}

/**
 * Classify ONE PR review comment. Routes per the rules documented in the
 * module header.
 *
 * Implements AC-1 / AC-2 / AC-3 / AC-4 / AC-5 / AC-7. AC-6 + AC-8 are
 * tested in `pr-comment-classifier.integration.test.ts` (where the
 * fake invoker drives the full re-sync loop).
 */
export async function classifyPrCommentForCapture(
  comment: GhPrReviewComment,
  opts: ClassifyPrCommentOpts = {},
): Promise<ClassifyPrCommentDecision> {
  // AC-7 idempotence: short-circuit when the comment is already linked
  // to a capture. We MUST do this before any other branch so the
  // classifier never re-runs on a previously-indexed comment.
  const existingId = extractCaptureIdFromComment(comment.body);
  if (existingId) {
    return { kind: 'already-linked', existingCaptureId: existingId };
  }

  // AC-4: marker-tagged comments bypass the classifier (already typed).
  const marker = parsePrCommentMarker(comment.body);
  if (marker.found) {
    return {
      kind: 'marker',
      finding: marker.finding,
      severity: marker.severity,
      triage: marker.triage,
    };
  }

  // AC-5: AI-agent-authored comments bypass the classifier (already typed).
  if (opts.treatAuthorAsAiAgent || isAiAgentAuthor(comment)) {
    return { kind: 'ai-agent', finding: comment.body.trim() };
  }

  // AC-1 + AC-2 + AC-3: run the classifier.
  const threshold = opts.threshold ?? PR_COMMENT_DEFAULT_THRESHOLD;
  const decision = await classify(
    {
      text: comment.body,
      context: {
        author: comment.author?.login ?? 'unknown',
        prNumber: comment.prNumber,
        commentUrl: comment.url,
      },
    },
    'pr-comment-is-capture',
    { ...opts, threshold },
  );

  // Substrate fall-open: classification is the `pending` sentinel
  // with confidence 0 when the invoker is missing / errored / returned
  // an invalid response. Treat as "skip" (caller never silently
  // misses high-signal comments because of an infra blip — the operator
  // can re-run when the invoker is available).
  if (decision.classification === 'pending') {
    return { kind: 'classified-skip', reason: 'classifier-fall-open', decision };
  }

  if (decision.classification === 'is-capture' && decision.confidence >= threshold) {
    return {
      kind: 'classified-capture',
      finding: comment.body.trim(),
      decision,
    };
  }

  // Either `not-capture` OR `is-capture` below threshold → skip.
  const reason: 'not-capture' | 'below-threshold' =
    decision.classification === 'is-capture' ? 'below-threshold' : 'not-capture';
  return { kind: 'classified-skip', reason, decision };
}

// ── Batch entry point ────────────────────────────────────────────────────────

/** One batch-result row. */
export interface ClassifyPrCommentsBatchResult {
  comment: GhPrReviewComment;
  decision: ClassifyPrCommentDecision;
}

/**
 * Classify a list of PR review comments. Convenience wrapper around
 * `classifyPrCommentForCapture` for the common "fan out across an entire
 * PR's comments" call shape.
 *
 * Runs serially (preserves request order in the corpus + makes the
 * subscription-ledger account deterministic). If your invoker is a
 * paid API and you need parallelism, wrap this function and apply your
 * own concurrency control.
 */
export async function classifyPrCommentsBatch(
  comments: readonly GhPrReviewComment[],
  opts: ClassifyPrCommentOpts = {},
): Promise<ClassifyPrCommentsBatchResult[]> {
  const out: ClassifyPrCommentsBatchResult[] = [];
  for (const comment of comments) {
    const decision = await classifyPrCommentForCapture(comment, opts);
    out.push({ comment, decision });
  }
  return out;
}

// ── AC-6: re-sync detection ──────────────────────────────────────────────────

/**
 * Compare a freshly-fetched comment body against the body we previously
 * indexed (recoverable from the comment's `capture-id` footer + the
 * stored capture record). Returns whether the visible PR-comment text
 * (the body MINUS the capture-id footer) has changed.
 *
 * Per AC-6 (GitHub-edit-wins), an edit on GitHub does NOT mutate the
 * capture record (RFC-0024 §11 immutability) — instead, the next sync
 * pass observes the change here and the caller decides whether to:
 *
 *   - File a new capture for the new content (default — keeps both
 *     versions auditable), OR
 *   - Append a `note` audit entry to the existing capture (when the
 *     edit is a small clarification).
 *
 * The caller policy choice is out of scope for this module; this helper
 * surfaces the signal.
 */
export function detectCommentBodyChange(
  currentBody: string,
  previousBody: string,
): { changed: boolean; currentVisible: string; previousVisible: string } {
  const currentVisible = stripCaptureIdMarker(currentBody).trim();
  const previousVisible = stripCaptureIdMarker(previousBody).trim();
  return {
    changed: currentVisible !== previousVisible,
    currentVisible,
    previousVisible,
  };
}

/** Remove the `<!-- ai-sdlc:capture-id=... -->` footer if present. */
export function stripCaptureIdMarker(commentBody: string): string {
  return commentBody.replace(CAPTURE_ID_MARKER_REGEX, '').replace(/\s+$/, '');
}
