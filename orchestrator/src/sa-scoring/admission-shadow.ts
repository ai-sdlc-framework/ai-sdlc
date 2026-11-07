/**
 * Phase 2a shadow wiring for admission (RFC-0062 Phase 1, OQ-3 / DEC-0387).
 *
 * `createSoulAlignmentShadow` returns the `soulAlignmentShadow` hook for
 * `AdmissionCompositeOptions`. Each admission runs the three-layer engine
 * once in phase '2a' (weights 0,0), which persists one `did_scoring_events`
 * row per SA dimension carrying the composite score and `rank`. Admission
 * has no claim yet, so `rank` is `null`. The admitted score is untouched.
 */

import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';
import type { SoulAlignmentShadowContext } from '../admission-composite.js';
import { scoreSoulAlignment, type ScoreSoulAlignmentDeps } from './index.js';

export interface SoulAlignmentShadowConfig {
  did: DesignIntentDocument;
  dsb?: DesignSystemBinding;
  deps: ScoreSoulAlignmentDeps;
  /** Text to score for the work item (title + body). */
  issueText: (ctx: SoulAlignmentShadowContext) => string;
  /** Claim rank lookup; defaults to `null` (never claimed). */
  claimRank?: (ctx: SoulAlignmentShadowContext) => number | null;
  onError?: (err: unknown) => void;
}

export function createSoulAlignmentShadow(
  config: SoulAlignmentShadowConfig,
): (ctx: SoulAlignmentShadowContext) => void {
  return (ctx) => {
    void scoreSoulAlignment(
      {
        issueText: config.issueText(ctx),
        did: config.did,
        dsb: config.dsb,
        phase: '2a',
        issueNumber: ctx.issueNumber,
        claimRank: config.claimRank?.(ctx) ?? null,
      },
      config.deps,
    ).catch((err) => config.onError?.(err));
  };
}
