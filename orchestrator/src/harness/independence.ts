/**
 * Harness independence enforcement per RFC §13.10 (Q8 resolution).
 *
 * When a stage declares requiresIndependentHarnessFrom: [stageA, stageB], the orchestrator
 * filters that stage's harness chain to exclude harnesses that actually ran the named
 * upstream stages (which may differ from declared if a fallback was used).
 *
 * This is the load-bearing safety property for cross-harness review (RFC §13.6) — without
 * it, fallback can silently collapse review onto the same harness as the implementer.
 */

import type { HarnessName } from './types.js';

export interface UpstreamRun {
  stage: string;
  resolvedHarness: HarnessName;
}

export interface IndependenceResult {
  effectiveChain: HarnessName[];
  removed: HarnessName[];
  forbidden: HarnessName[];
  /** True when the filtered chain is empty — caller must apply onFailure. */
  violated: boolean;
}

/**
 * Filter a stage's candidate harness chain to preserve independence from named upstreams.
 */
export function enforceIndependence(
  candidateChain: HarnessName[],
  requiresIndependentFrom: string[],
  upstreamRuns: UpstreamRun[],
): IndependenceResult {
  const upstreamMap = new Map(upstreamRuns.map((r) => [r.stage, r.resolvedHarness]));
  const forbidden = new Set<HarnessName>();
  for (const stage of requiresIndependentFrom) {
    const h = upstreamMap.get(stage);
    if (h) forbidden.add(h);
  }
  const effectiveChain = candidateChain.filter((h) => !forbidden.has(h));
  const removed = candidateChain.filter((h) => forbidden.has(h));
  return {
    effectiveChain,
    removed,
    forbidden: Array.from(forbidden),
    violated: effectiveChain.length === 0,
  };
}

/**
 * Validate that requiresIndependentHarnessFrom declarations form a DAG.
 * Returns the set of cyclic edges (empty array means valid).
 *
 * Each stage is identified by name; references must point at stages that appear *earlier*
 * in the pipeline order. References to downstream or self → cycle.
 */
export function validateIndependenceGraph(
  stages: ReadonlyArray<{
    name: string;
    requiresIndependentHarnessFrom?: string[];
  }>,
): Array<{ stage: string; references: string }> {
  const stageOrder = new Map(stages.map((s, i) => [s.name, i]));
  const cycles: Array<{ stage: string; references: string }> = [];
  for (const [i, s] of stages.entries()) {
    const refs = s.requiresIndependentHarnessFrom ?? [];
    for (const ref of refs) {
      const refIndex = stageOrder.get(ref);
      if (refIndex === undefined) {
        cycles.push({ stage: s.name, references: `unknown stage '${ref}'` });
      } else if (refIndex >= i) {
        cycles.push({
          stage: s.name,
          references: `'${ref}' is not strictly upstream (cycle / self-reference)`,
        });
      }
    }
  }
  return cycles;
}

export class CyclicIndependenceConstraintError extends Error {
  constructor(public readonly cycles: Array<{ stage: string; references: string }>) {
    const summary = cycles.map((c) => `${c.stage} → ${c.references}`).join('; ');
    super(`requiresIndependentHarnessFrom forms invalid graph: ${summary}`);
    this.name = 'CyclicIndependenceConstraintError';
  }
}
