/**
 * Gate 3 — Named-thing references resolve.
 *
 * Stage A (deterministic): extract every reference from the body using
 * `extractReferences()` and dispatch to the resolver registry. Any
 * reference that fails to resolve fails the gate.
 *
 * Stage B (Phase 2b) handles the bare-reference-without-link case
 * ("Like the dashboard PR" with no URL) — Stage A can only check refs
 * that are syntactically present.
 *
 * The gate is **skip** when there are zero references in the body
 * (vacuous pass). The orchestrator records that as `verdict: 'pass'`
 * with confidence 'medium' so Stage B can still flag the bare-reference
 * case.
 *
 * RFC-0011 §4.4 — gate 3 row + §13 Q2 resolver registry.
 */

import { defaultRunner } from '../../runtime/exec.js';
import { extractReferences, resolveReference } from '../resolvers/index.js';
import type { GateEvaluation, IssueInput, ResolverOpts, Resolver } from '../types.js';

export interface Gate3Opts {
  /** Project root passed to resolvers. Defaults to `input.workDir`. */
  workDir?: string;
  runner?: typeof defaultRunner;
  fetchImpl?: typeof fetch;
  /** Custom resolver list (tests inject a no-network registry). */
  resolvers?: Resolver[];
  /** Per-reference timeout in ms. */
  timeoutMs?: number;
}

export async function evaluateGate3(
  input: IssueInput,
  opts: Gate3Opts = {},
): Promise<GateEvaluation> {
  const explicit = input.references ?? [];
  // Strip AC checklist numbering (`- [ ] #N`) before extraction so AC IDs
  // aren't mistaken for GitHub issue refs.
  const bodyForExtraction = input.body.replace(/^(\s*-\s+\[(?: |x|X)\]\s+)#\d+(\s)/gm, '$1$2');
  const extracted = extractReferences(bodyForExtraction);
  // Promote explicit string references to file-existence by default —
  // ingress shims pass project-root-relative paths.
  const explicitRefs = explicit.map((raw) => ({ raw, kind: 'file-existence' as const }));
  const allRefs = [...explicitRefs, ...extracted];

  if (allRefs.length === 0) {
    return {
      gateId: 3,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'medium',
    };
  }

  const workDir = opts.workDir ?? input.workDir ?? process.cwd();
  const resolverOpts: ResolverOpts = {
    workDir,
    runner: opts.runner,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  };

  const failures: Array<{ raw: string; reason: string | undefined }> = [];
  for (const ref of allRefs) {
    const result = await resolveReference(ref, resolverOpts, opts.resolvers);
    if (!result.resolved) {
      failures.push({ raw: ref.raw, reason: result.reason });
    }
  }

  if (failures.length === 0) {
    return {
      gateId: 3,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
    };
  }

  const sample = failures
    .slice(0, 5)
    .map((f) => (f.reason ? `${f.raw} (${f.reason})` : f.raw))
    .join('; ');
  return {
    gateId: 3,
    verdict: 'fail',
    severity: 'block',
    stage: 'A',
    confidence: 'high',
    finding: `${failures.length} reference(s) failed to resolve: ${sample}.`,
    clarificationQuestion:
      'Each named-thing reference (file path, RFC ID, GitHub issue, URL) must resolve. Fix or remove the broken references above.',
  };
}
