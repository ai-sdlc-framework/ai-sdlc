/**
 * The one way pipeline code arms auto-merge (AISDLC-975).
 *
 * Governance (`allowMerge: onGreenClean`) says arming goes only through
 * `cli-merge-if-eligible --arm`. This wraps the same module that CLI runs
 * (`runMergeIfEligible` with `mode: 'arm'`) so the policy, fork, author, base,
 * task and head-commit checks apply, and a refusal comes back with the gate's
 * reason instead of a swallowed non-zero exit.
 */
import type { Runner } from '../runtime/exec.js';
import {
  defaultBacklogAuditWriter,
  resolveTargetRepo,
  runMergeIfEligible,
  type SourceKind,
} from './merge-if-eligible.js';

export interface ArmViaGateResult {
  /** True when auto-merge is armed, or the PR landed at once. */
  ok: boolean;
  /** Gate outcome, or the refusal reason when `ok` is false. */
  reason: string;
}

export async function armViaGate(opts: {
  prNumber: number;
  runner: Runner;
  cwd: string;
  sourceKind?: SourceKind;
}): Promise<ArmViaGateResult> {
  try {
    const target = await resolveTargetRepo({ runner: opts.runner, cwd: opts.cwd });
    const result = await runMergeIfEligible({
      prNumber: opts.prNumber,
      sourceKind: opts.sourceKind ?? 'backlog',
      repoSlug: target.slug ?? '',
      repoRoot: target.slug === null ? null : opts.cwd,
      rootRefusal: target.reason,
      runner: opts.runner,
      cwd: opts.cwd,
      mode: 'arm',
      auditWriter: defaultBacklogAuditWriter(),
    });
    if (result.armed || result.outcome === 'armed' || result.outcome === 'landed') {
      return { ok: true, reason: result.outcome ?? 'armed' };
    }
    return { ok: false, reason: result.eligibility.reason || result.outcome || 'not armed' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
