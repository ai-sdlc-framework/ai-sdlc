/**
 * 3-round escalation + low-confidence auto-escalate (RFC-0011 §6.3 + Q4 +
 * Phase 6 / AISDLC-115.7).
 *
 * Two trigger paths feed the same handler so the operator learns one
 * mental model:
 *
 *   1. **Round-cap escalation (RFC §6.3)**: an issue cycles through
 *      `Needs Clarification` more than `escalation.maxRoundsBeforeHumanTriage`
 *      times (default 3). The author may have gone quiet, the rubric may
 *      be a false positive, or the agent + author may be talking past
 *      each other — in all three cases a human triager is the next move.
 *
 *   2. **Low-confidence escalation (Q4)**: the verdict's
 *      `overallConfidence` is `'low'`. Per Q4 we never auto-act on low
 *      confidence; the same handler routes the issue to the configured
 *      triager with the low-confidence reason captured. Composes
 *      naturally with bypass (the maintainer can apply `dor-bypass` if
 *      they disagree with the escalation).
 *
 * The handler is **decision + comment-render only**. Posting the comment
 * + applying any `escalated` label + pinging the human are the calling
 * shim's responsibilities — same separation as `staleness.ts` and
 * `comment-loop.ts`.
 *
 * `unrouted: true` means the escalation fired but no `triager` is
 * configured. The shim should surface that loudly (CI log warning, Slack
 * alert) so the operator knows their gate is escalating into the void.
 */

import { redactSecrets } from './secret-redact.js';
import { DOR_CONFIG_DEFAULTS, type DorConfigEscalation } from './dor-config.js';
import type { RefinementVerdict } from './types.js';

/** HTML idempotency marker — the comment poster uses this to update in place. */
export const DOR_ESCALATION_MARKER = '<!-- ai-sdlc:dor-escalation -->';

export type EscalationTrigger = 'round-cap' | 'low-confidence';

export interface EscalationInput {
  /** Issue identifier (e.g. `AISDLC-92`, `gh#42`). */
  issueId: string;
  /**
   * Number of clarification rounds the issue has been through. The
   * round counter is owned by the comment-loop / orchestration layer
   * (one round = one clarification post + one author edit). Pass the
   * current count; the decider compares it to
   * `config.maxRoundsBeforeHumanTriage`.
   */
  roundCount: number;
  /**
   * Latest verdict for the issue. Drives the low-confidence trigger
   * (`verdict.overallConfidence === 'low'`) AND the rendered comment
   * (failed gates + clarifying questions). Optional — round-cap can
   * fire without a verdict in hand (e.g. the author has been ignoring
   * the loop and the orchestration layer just wants to escalate the
   * raw round count).
   */
  verdict?: RefinementVerdict;
}

export interface DecideEscalationOpts {
  /** Override the escalation config. Defaults to `DOR_CONFIG_DEFAULTS.escalation`. */
  config?: DorConfigEscalation;
}

export interface EscalationDecision {
  issueId: string;
  /** Whether the escalation should fire now. */
  shouldEscalate: boolean;
  /** All triggers that contributed (one or both of round-cap / low-confidence). */
  triggers: EscalationTrigger[];
  /** Triager target from config (Slack channel, GitHub team, free-form). */
  triager?: string;
  /**
   * True when `shouldEscalate` is true but no triager is configured. The
   * decision still fires (we don't drop the alert) — the calling shim
   * surfaces a loud warning so the operator knows the gate is
   * escalating into the void.
   */
  unrouted: boolean;
  /** Human-readable reason — useful for the orchestration layer's log line. */
  reason: string;
  /** Snapshot of the round count at decision time. */
  roundCount: number;
  /** Snapshot of the configured cap at decision time. */
  maxRoundsBeforeHumanTriage: number;
}

/**
 * Decide whether to escalate the issue to a human triager.
 *
 * Returns `shouldEscalate: false` only when neither trigger fires.
 * `unrouted: true` flags the configured-as-escalation-but-no-triager case
 * — the alert still fires but the operator should see a warning.
 */
export function decideEscalation(
  input: EscalationInput,
  opts: DecideEscalationOpts = {},
): EscalationDecision {
  const config = opts.config ?? DOR_CONFIG_DEFAULTS.escalation;
  const triggers: EscalationTrigger[] = [];

  // Round-cap: escalate the moment the round count crosses the cap. The
  // comment-loop counts one round per clarification post, so
  // `roundCount > maxRoundsBeforeHumanTriage` means "we asked the author
  // more times than the policy allows."
  if (input.roundCount > config.maxRoundsBeforeHumanTriage) {
    triggers.push('round-cap');
  }

  // Low-confidence: per Q4, never auto-act. Escalate via the same path
  // so the operator only has to learn one routing mechanism.
  if (input.verdict?.overallConfidence === 'low') {
    triggers.push('low-confidence');
  }

  if (triggers.length === 0) {
    return {
      issueId: input.issueId,
      shouldEscalate: false,
      triggers,
      unrouted: false,
      reason: `no escalation triggered (rounds=${input.roundCount}/${config.maxRoundsBeforeHumanTriage}; confidence=${input.verdict?.overallConfidence ?? 'unknown'})`,
      roundCount: input.roundCount,
      maxRoundsBeforeHumanTriage: config.maxRoundsBeforeHumanTriage,
    };
  }

  const reasonParts: string[] = [];
  if (triggers.includes('round-cap')) {
    reasonParts.push(`round-cap (${input.roundCount} > ${config.maxRoundsBeforeHumanTriage})`);
  }
  if (triggers.includes('low-confidence')) {
    reasonParts.push('low-confidence verdict (Q4 — never auto-act)');
  }

  const decision: EscalationDecision = {
    issueId: input.issueId,
    shouldEscalate: true,
    triggers,
    unrouted: !config.triager,
    reason: reasonParts.join(' + '),
    roundCount: input.roundCount,
    maxRoundsBeforeHumanTriage: config.maxRoundsBeforeHumanTriage,
  };
  if (config.triager) decision.triager = config.triager;
  return decision;
}

/**
 * Render the escalation comment body. The comment is posted via the
 * comment loop's poster contract, so we only need to compose the
 * markdown body here. The marker is intentionally distinct from the
 * clarification + staleness markers so dual-fanout posters can store
 * all three side-by-side without colliding.
 *
 * Findings + questions are passed through `redactSecrets()` — same
 * defense-in-depth pattern as `renderClarificationComment` since the
 * source text comes from the (potentially user-supplied) verdict.
 */
export function renderEscalationComment(
  decision: EscalationDecision,
  verdict?: RefinementVerdict,
): string {
  const lines: string[] = [DOR_ESCALATION_MARKER, '', '## Escalating to human triager', ''];

  // Routing line — explicit so the human reader (and any humans CC'd via
  // the channel mention) can immediately see who's on point.
  if (decision.triager) {
    lines.push(`Routing to ${decision.triager}.`);
  } else {
    lines.push(
      'No `escalation.triager` configured in `.ai-sdlc/dor-config.yaml` — this escalation is **unrouted**. Assign a triager manually.',
    );
  }
  lines.push('');

  // Reason summary.
  lines.push(`**Why this escalation fired**: ${decision.reason}.`);
  lines.push('');

  // Per-trigger context.
  if (decision.triggers.includes('round-cap')) {
    lines.push(
      `- **Round-cap** (RFC §6.3): this issue has been through ${decision.roundCount} clarification rounds (cap: ${decision.maxRoundsBeforeHumanTriage}). The author may need a real human to unblock the loop.`,
    );
  }
  if (decision.triggers.includes('low-confidence')) {
    lines.push(
      '- **Low-confidence verdict** (Q4): the rubric returned `overallConfidence: low`. Per the Q4 resolution we never auto-act on low confidence — a human reviews the verdict before any admit / block decision lands.',
    );
  }
  lines.push('');

  if (verdict) {
    const blocked = verdict.gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
    if (blocked.length > 0) {
      lines.push('### Latest verdict — blocking gates');
      lines.push('');
      for (const g of blocked) {
        const finding = g.finding ? redactSecrets(g.finding) : '(no finding)';
        lines.push(`- **Gate ${g.gateId}**: ${finding}`);
      }
      lines.push('');
    }
    const questions = (verdict.questions ?? []).map((q) => redactSecrets(q));
    if (questions.length > 0) {
      lines.push('### Outstanding clarifying questions');
      for (const q of questions) lines.push(`- [ ] ${q}`);
      lines.push('');
    }
  }

  lines.push(
    'Triager options (RFC §6.3): approve manually (apply `dor-bypass` with a reason — RFC §7.4); close as not actionable; split into smaller issues; work with the author directly.',
  );

  return lines.join('\n');
}
