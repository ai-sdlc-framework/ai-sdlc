/**
 * DoR clarification comment loop (RFC-0011 §6).
 *
 * Phase 3 (AISDLC-115.4) wires `evaluateIssueE2E()` output into the
 * issue lifecycle by:
 *
 *   1. **Composing** a markdown comment from the verdict per RFC §6.2,
 *      including the HTML idempotency marker.
 *   2. **Routing** the comment to enabled channels (author + optional
 *      dedicated) per RFC §13 Q5 dual-fanout.
 *   3. **Posting idempotently** — a re-check that produces the same
 *      verdict updates the existing comment rather than duplicating.
 *
 * All free-text inputs are passed through `redactSecrets()` before they
 * reach the comment body so a leaked token in the issue body never gets
 * mirrored back into a public comment.
 *
 * The poster itself is split out behind the `CommentPoster` interface
 * so the GitHub Action shim and the Claude Code subagent shim share the
 * composition + idempotency logic and only differ in I/O.
 */

import { redactSecrets } from './secret-redact.js';
import type { DorConfigDedicatedChannel, DorConfigNotifications } from './dor-config.js';
import type { RefinementVerdict } from './types.js';

/**
 * The HTML marker used to identify the agent's prior comment for
 * idempotent updates (RFC §6.2). Comment poster implementations MUST
 * search for this exact substring before deciding whether to insert
 * vs. update.
 */
export const DOR_COMMENT_MARKER = '<!-- ai-sdlc:dor-comment -->';

/** Channel-specific marker — append the channel id so dual-fanout posts don't collide. */
export function dorCommentMarkerFor(
  channel: 'author' | 'dedicated-slack' | 'dedicated-github',
): string {
  return `<!-- ai-sdlc:dor-comment channel="${channel}" -->`;
}

export interface RenderCommentOpts {
  /** Optional override for the rubric docs URL surfaced in the comment header. */
  rubricUrl?: string;
  /** Channel marker scoping (defaults to 'author'). */
  channel?: 'author' | 'dedicated-slack' | 'dedicated-github';
}

/**
 * Compose a markdown clarification comment from a verdict.
 *
 * The output is shaped per RFC §6.2:
 *   - Marker comment first (drives idempotency).
 *   - Heading.
 *   - Per-blocked-gate finding section.
 *   - Checklist of clarifying questions.
 *   - Footer with the recheck instruction.
 *
 * Findings + questions are passed through `redactSecrets()`. Every
 * other static literal in the body is author-independent so it never
 * needs redaction.
 */
export function renderClarificationComment(
  verdict: RefinementVerdict,
  opts: RenderCommentOpts = {},
): string {
  const marker = dorCommentMarkerFor(opts.channel ?? 'author');
  const rubricUrl = opts.rubricUrl ?? 'https://docs.ai-sdlc.io/rfc/0011';

  const blocked = verdict.gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');

  const sections: string[] = [marker, '', '## Issue not yet ready for execution', ''];
  sections.push(
    `I checked this issue against the [Definition-of-Ready rubric](${rubricUrl}) and it's blocked on the following gates:`,
  );
  sections.push('');

  for (const gate of blocked) {
    sections.push(`### Gate ${gate.gateId} — ${gateName(gate.gateId)}`);
    if (gate.finding) sections.push(redactSecrets(gate.finding));
    sections.push('');
  }

  const questions = (verdict.questions ?? []).map((q) => redactSecrets(q));
  if (questions.length > 0) {
    sections.push('### Clarifying questions');
    for (const q of questions) sections.push(`- [ ] ${q}`);
    sections.push('');
  }

  sections.push(
    "Edit the issue to address these, then comment `/dor-recheck` (or just edit and wait — I'll re-check on the next edit).",
  );
  return sections.join('\n');
}

/**
 * Render a "now ready" admit confirmation. Posted when a previously
 * needs-clarification issue passes a re-check, so the author sees the
 * loop close in the same thread.
 */
export function renderAdmitComment(
  verdict: RefinementVerdict,
  opts: RenderCommentOpts = {},
): string {
  const marker = dorCommentMarkerFor(opts.channel ?? 'author');
  const rubricUrl = opts.rubricUrl ?? 'https://docs.ai-sdlc.io/rfc/0011';
  const lines = [
    marker,
    '',
    '## Issue ready for execution',
    '',
    `All Definition-of-Ready gates pass against this issue (rubric ${verdict.rubricVersion} via ${verdict.evaluatorVersion}). [Rubric reference](${rubricUrl}).`,
  ];
  if (verdict.summary) lines.push('', redactSecrets(verdict.summary));
  return lines.join('\n');
}

/**
 * One verdict + the source file it was derived from, used by the PR-tasks
 * summary renderer. The GitHub Action's evaluate step writes one of these
 * per line to `/tmp/dor/results.jsonl`; the renderer aggregates them.
 */
export interface PrTaskVerdict extends RefinementVerdict {
  /** Path of the backlog task file the verdict was evaluated against. */
  __file: string;
}

/**
 * Compose the PR-level summary comment for the `evaluate-pr-tasks` job.
 *
 * Single source of truth + redaction — same justification as
 * `renderClarificationComment()`: the inline github-script renderer used
 * to embed `gate.finding` verbatim, so a leaked token in the task body
 * could be reflected back into the public PR comment. Now every finding
 * passes through `redactSecrets()` here.
 */
export function renderPrTasksComment(
  verdicts: PrTaskVerdict[],
  opts: { channel?: 'author' | 'dedicated-slack' | 'dedicated-github' } = {},
): string {
  const marker = dorCommentMarkerFor(opts.channel ?? 'author');
  const blocking = verdicts.filter((v) => v.overallVerdict === 'needs-clarification');
  const sections: string[] = [marker, ''];
  if (blocking.length === 0) {
    sections.push('## Backlog tasks: DoR clean', '');
    sections.push('All backlog tasks changed by this PR pass the Definition-of-Ready rubric.');
    return sections.join('\n');
  }
  sections.push('## Backlog tasks: DoR clarifications needed', '');
  for (const v of blocking) {
    sections.push(`### \`${v.__file}\` (${v.issueId})`);
    const blocked = (v.gates ?? []).filter((g) => g.verdict === 'fail' && g.severity === 'block');
    for (const g of blocked) {
      const finding = g.finding ? redactSecrets(g.finding) : '(no finding)';
      sections.push(`- **Gate ${g.gateId}**: ${finding}`);
    }
    sections.push('');
  }
  sections.push('Edit the offending task body and push; this comment will update on next CI run.');
  return sections.join('\n');
}

/**
 * Stable gate names used in the rendered comment. Mirrors RFC §4.1 row
 * order so the comment reads as authored by the same rubric the verdict
 * was evaluated against.
 */
export function gateName(id: number): string {
  const names: Record<number, string> = {
    1: 'Acceptance criteria are binary-testable',
    2: 'No unresolved markers in the body',
    3: 'Named-thing references resolve',
    4: 'Scope is bounded',
    5: 'Affected surface is named',
    6: 'Done-state is describable',
    7: 'No invisible dependencies',
  };
  return names[id] ?? `Gate ${id}`;
}

export interface ExistingComment {
  id: string;
  body: string;
}

export interface CommentPosterContext {
  /** The marker substring that identifies a prior agent comment on this channel. */
  marker: string;
  /** The composed comment body (already redacted). */
  body: string;
  /** Channel kind — passed through for the poster's own routing if needed. */
  channel: 'author' | 'dedicated-slack' | 'dedicated-github';
}

export interface PostResult {
  /**
   * Whether a comment was created vs. an existing one was updated, or
   * whether the per-channel post failed. Promise-rejecting posters are
   * reported as `error` instead of throwing through the fanout boundary
   * so that one bad channel can't block the others.
   */
  action: 'created' | 'updated' | 'no-op' | 'error';
  /** The comment id (poster-specific). May be undefined for `no-op` / `error`. */
  commentId?: string;
  /** Channel kind. */
  channel: CommentPosterContext['channel'];
  /** When `action === 'error'`, the captured error message (no stack). */
  error?: string;
}

/**
 * Generic comment poster contract. Every shim (GitHub Action,
 * Claude Code subagent, future Slack / Forge) implements this; the
 * shared `postIdempotent()` helper drives the create-vs-update decision.
 */
export interface CommentPoster {
  /** List existing comments on the target so we can locate prior agent comments by marker. */
  list(): Promise<ExistingComment[]>;
  /** Create a new comment. Returns the new comment's id. */
  create(body: string): Promise<string>;
  /** Update an existing comment in place. */
  update(commentId: string, body: string): Promise<void>;
}

/**
 * Idempotent post: walks the existing comments looking for one carrying
 * the marker; updates it if the body changed; creates a new one otherwise.
 *
 * `no-op` is returned when the prior comment's body byte-for-byte matches
 * the new body — the orchestration layer can fold that into "nothing to
 * tell the author", avoiding noise on every re-check.
 */
export async function postIdempotent(
  poster: CommentPoster,
  ctx: CommentPosterContext,
): Promise<PostResult> {
  const existing = await poster.list();
  const prior = existing.find((c) => c.body.includes(ctx.marker));
  if (!prior) {
    const id = await poster.create(ctx.body);
    return { action: 'created', commentId: id, channel: ctx.channel };
  }
  if (prior.body.trim() === ctx.body.trim()) {
    return { action: 'no-op', commentId: prior.id, channel: ctx.channel };
  }
  await poster.update(prior.id, ctx.body);
  return { action: 'updated', commentId: prior.id, channel: ctx.channel };
}

/**
 * Dual-fanout helper — runs `postIdempotent()` once per enabled channel.
 *
 * Per RFC §13 Q5 the rubric library returns the verdict; the shim
 * decides where to post. Channels are addressed by string keys:
 *   - 'author' — always present when `notifications.authorChannel`
 *   - 'dedicated-slack' / 'dedicated-github' — present when the
 *     respective `dedicatedChannel.*` field is set
 *
 * The caller provides one poster per enabled channel; this helper
 * runs them in parallel via `Promise.allSettled` so a transient failure
 * on one channel (e.g. Slack 503) doesn't strand the others. Per-channel
 * errors are captured into the `PostResult` (`action: 'error'`,
 * `error: <message>`) so the operator can see the failure in CI logs
 * and the orchestration layer can decide whether to retry.
 */
export async function fanoutPost(
  posters: Partial<Record<PostResult['channel'], CommentPoster>>,
  body: string,
  notifications: DorConfigNotifications,
): Promise<PostResult[]> {
  const channels = enabledChannels(notifications).filter((c) => posters[c] !== undefined);
  const settled = await Promise.allSettled(
    channels.map(async (channel) => {
      const poster = posters[channel]!;
      const ctxBody = bodyForChannel(body, channel);
      return postIdempotent(poster, {
        marker: dorCommentMarkerFor(channel),
        body: ctxBody,
        channel,
      });
    }),
  );
  return settled.map((outcome, idx) => {
    const channel = channels[idx]!;
    if (outcome.status === 'fulfilled') return outcome.value;
    const reason = outcome.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    return { action: 'error', channel, error: message };
  });
}

/**
 * Compute the list of enabled channels from the notifications config.
 * Exposed so shims can pre-construct posters lazily.
 */
export function enabledChannels(notifications: DorConfigNotifications): PostResult['channel'][] {
  const out: PostResult['channel'][] = [];
  if (notifications.authorChannel) out.push('author');
  const dedicated = notifications.dedicatedChannel;
  if (dedicated) {
    if (dedicated.slack) out.push('dedicated-slack');
    if (dedicated.github_team) out.push('dedicated-github');
  }
  return out;
}

/**
 * Replace the channel marker inside a body so the same composed text can
 * be reused across the per-channel posters without each one rendering
 * its own copy.
 */
export function bodyForChannel(body: string, channel: PostResult['channel']): string {
  return body.replace(/<!-- ai-sdlc:dor-comment[^>]*-->/, dorCommentMarkerFor(channel));
}

/**
 * Re-export the dedicated-channel shape so shim code can import the
 * type alongside the comment-loop helpers.
 */
export type { DorConfigDedicatedChannel };
