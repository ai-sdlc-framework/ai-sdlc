/**
 * Step 8 — Aggregate the three reviewer verdicts into a single gate decision.
 *
 * Mirrors `execute-orchestrator.md` Step 8:
 *
 *  - Count findings by severity across all reviewers.
 *  - APPROVED if all reviewers approved AND no critical/major findings.
 *  - CHANGES_REQUESTED otherwise → enters the iteration loop (Step 9).
 *  - HARNESS_NOTE (if any) prepended to the aggregated summary.
 *
 * Pure function — no IO, fully deterministic.
 *
 * @module steps/08-aggregate-verdicts
 */

import type { AggregatedVerdict, ReviewerFinding, ReviewerVerdict, Severity } from '../types.js';

export interface AggregateVerdictsOptions {
  verdicts: ReviewerVerdict[];
  harnessNote?: string;
}

const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'suggestion'];

export async function aggregateVerdicts(
  opts: AggregateVerdictsOptions,
): Promise<AggregatedVerdict> {
  const counts: Record<Severity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
    suggestion: 0,
  };

  for (const v of opts.verdicts) {
    for (const f of v.findings ?? []) {
      const sev = SEVERITIES.includes(f.severity) ? f.severity : 'suggestion';
      counts[sev] = (counts[sev] ?? 0) + 1;
    }
  }

  const allApproved = opts.verdicts.length > 0 && opts.verdicts.every((v) => v.approved);
  const blocking = counts.critical > 0 || counts.major > 0;
  const decision: AggregatedVerdict['decision'] =
    allApproved && !blocking ? 'APPROVED' : 'CHANGES_REQUESTED';

  const harnessNote = opts.harnessNote ?? '';
  const summaryLines: string[] = [];
  if (harnessNote) summaryLines.push(harnessNote);
  summaryLines.push(
    `Verdict: ${decision} — ` +
      `${counts.critical} critical, ${counts.major} major, ${counts.minor} minor, ${counts.suggestion} suggestion ` +
      `across ${opts.verdicts.length} reviewers`,
  );

  return {
    approved: decision === 'APPROVED',
    counts,
    decision,
    verdicts: opts.verdicts,
    harnessNote,
    summary: summaryLines.join('\n'),
  };
}

/**
 * Render the structured findings list into a human-readable bullet block
 * for the developer's reviewer-feedback section in iteration N>1 (Step 9).
 */
export function formatFeedback(verdicts: ReviewerVerdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    const blockingFindings = (v.findings ?? []).filter(
      (f: ReviewerFinding) => f.severity === 'critical' || f.severity === 'major',
    );
    if (blockingFindings.length === 0) continue;
    lines.push(`### ${v.agentId} (${v.harness})`);
    for (const f of blockingFindings) {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'general';
      lines.push(`- [${f.severity}] ${loc} — ${f.message}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
