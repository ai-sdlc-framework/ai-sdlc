/**
 * QualityGate domain reconciler.
 * Evaluates gate rules and updates status.
 */

import type { QualityGate } from '../core/types.js';
import type { EvaluationContext } from '../policy/enforcement.js';
import { enforce } from '../policy/enforcement.js';
import type { ReconcileResult } from './types.js';

export interface GateReconcilerDeps {
  getContext: (gate: QualityGate) => EvaluationContext;
}

/**
 * Create a reconciler function for QualityGate resources.
 * Calls enforce() and updates status.compliant and conditions.
 */
export function createGateReconciler(
  deps: GateReconcilerDeps,
): (resource: QualityGate) => Promise<ReconcileResult> {
  return async (gate: QualityGate): Promise<ReconcileResult> => {
    try {
      const ctx = deps.getContext(gate);
      const result = enforce(gate, ctx);

      if (!gate.status) {
        (gate as { status: QualityGate['status'] }).status = {};
      }

      gate.status!.compliant = result.allowed;
      gate.status!.conditions = result.results.map((r) => ({
        type: r.gate,
        status: r.verdict === 'pass' || r.verdict === 'override' ? 'True' : 'False',
        reason: r.verdict,
        message: r.message,
        lastEvaluated: new Date().toISOString(),
      }));

      return { type: 'success' };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}
