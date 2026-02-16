/**
 * Process escalation — detects complexity band transitions and
 * returns escalation actions to tighten or relax the pipeline.
 *
 * RFC reference: progressive process adaptation.
 */

import type { Gate } from '@ai-sdlc/reference';
import { getComplexityBand, type AdjustedGate } from './progressive-gates.js';
import type { ComplexityBand } from './defaults.js';

export type EscalationActionType =
  | 'add-gate'
  | 'remove-gate'
  | 'tighten-gate'
  | 'relax-gate'
  | 'require-review'
  | 'remove-review-requirement'
  | 'notify';

export interface EscalationAction {
  type: EscalationActionType;
  gateName?: string;
  reason: string;
  fromBand: ComplexityBand;
  toBand: ComplexityBand;
  details?: Record<string, unknown>;
}

export interface EscalationResult {
  escalated: boolean;
  fromBand: ComplexityBand;
  toBand: ComplexityBand;
  actions: EscalationAction[];
}

/**
 * Band ordering for comparison.
 */
function bandOrd(band: ComplexityBand): number {
  switch (band) {
    case 'trivial': return 0;
    case 'standard': return 1;
    case 'complex': return 2;
    case 'critical': return 3;
    default: return 1;
  }
}

/**
 * Evaluate whether a complexity score change triggers process escalation.
 * Returns a list of escalation actions when the band changes.
 */
export function evaluateProcessEscalation(
  prevScore: number,
  curScore: number,
  gates: Gate[],
): EscalationResult {
  const fromBand = getComplexityBand(prevScore);
  const toBand = getComplexityBand(curScore);

  if (fromBand === toBand) {
    return { escalated: false, fromBand, toBand, actions: [] };
  }

  const fromOrd = bandOrd(fromBand);
  const toOrd = bandOrd(toBand);
  const escalating = toOrd > fromOrd;
  const actions: EscalationAction[] = [];

  if (escalating) {
    // Complexity increased — tighten process
    actions.push({
      type: 'notify',
      reason: `Complexity band escalated from ${fromBand} to ${toBand}`,
      fromBand,
      toBand,
    });

    // Tighten all existing gates
    for (const gate of gates) {
      actions.push({
        type: 'tighten-gate',
        gateName: gate.name,
        reason: `Gate enforcement tightened due to band change ${fromBand} -> ${toBand}`,
        fromBand,
        toBand,
      });
    }

    // Add review requirement if moving to complex or critical
    if (toOrd >= 2) {
      actions.push({
        type: 'require-review',
        reason: `Review required for ${toBand} complexity band`,
        fromBand,
        toBand,
      });
    }

    // Add security gate if moving to complex or critical and none exists
    if (toOrd >= 2 && !gates.some((g) => g.name.toLowerCase().includes('security'))) {
      actions.push({
        type: 'add-gate',
        gateName: 'security-scan',
        reason: `Security scan required for ${toBand} complexity band`,
        fromBand,
        toBand,
        details: { enforcement: 'hard-mandatory' },
      });
    }
  } else {
    // Complexity decreased — relax process
    actions.push({
      type: 'notify',
      reason: `Complexity band de-escalated from ${fromBand} to ${toBand}`,
      fromBand,
      toBand,
    });

    // Relax all existing gates
    for (const gate of gates) {
      actions.push({
        type: 'relax-gate',
        gateName: gate.name,
        reason: `Gate enforcement relaxed due to band change ${fromBand} -> ${toBand}`,
        fromBand,
        toBand,
      });
    }

    // Remove review requirement if moving to trivial
    if (toOrd === 0) {
      actions.push({
        type: 'remove-review-requirement',
        reason: 'Review not required for trivial complexity band',
        fromBand,
        toBand,
      });
    }
  }

  return { escalated: true, fromBand, toBand, actions };
}

/**
 * Check if a band transition represents a significant escalation
 * (jumping 2+ bands).
 */
export function isSignificantEscalation(fromBand: ComplexityBand, toBand: ComplexityBand): boolean {
  return Math.abs(bandOrd(toBand) - bandOrd(fromBand)) >= 2;
}

/**
 * Get escalation summary for logging/notification.
 */
export function formatEscalationSummary(result: EscalationResult): string {
  if (!result.escalated) {
    return `No escalation: band remains ${result.fromBand}`;
  }

  const direction = bandOrd(result.toBand) > bandOrd(result.fromBand) ? 'escalated' : 'de-escalated';
  const actionSummary = result.actions
    .filter((a) => a.type !== 'notify')
    .map((a) => `${a.type}${a.gateName ? ` (${a.gateName})` : ''}`)
    .join(', ');

  return `Process ${direction}: ${result.fromBand} -> ${result.toBand}. Actions: ${actionSummary || 'none'}`;
}
