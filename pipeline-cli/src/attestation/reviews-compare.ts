/**
 * Head-to-head comparison of the staged review set against the gating reviewers
 * (RFC-0052 section 6, AISDLC-677).
 *
 * During the comparison the gating set (code, test, security or correctness) decides
 * the PR and the staged pipeline runs beside it as shadow: its ledger row carries
 * `gating: false`. This module pairs the two per review cycle `(taskId, commitSha,
 * iteration)` and reports, per case, the findings only the staged set raised, the
 * findings only a gating reviewer raised, and the agreed findings (matched by the
 * ledger's normalized finding title). The security comparison is its own section:
 * staged findings against the standalone security reviewer's.
 *
 * A case is flagged when either side raised a critical or major finding the other side
 * did not raise at all; flagged cases are listed first and are what the operator
 * re-evaluates. Pure functions, no IO.
 *
 * ## Bar
 *
 * The relax bar (RFC-0049/0050) is at least 50 compared PRs and act-band precision of at
 * least 95 percent. Here the act band is the cases where the staged set blocked, and a
 * staged block counts as precise when the gating side also blocked that case. Computed
 * for all cases and, separately, for the cases that have a standalone security row.
 *
 * @module attestation/reviews-compare
 */

import type {
  ReviewLedgerFinding,
  ReviewLedgerRecord,
  ReviewLedgerRole,
  ReviewLedgerSeverity,
} from './reviews-ledger.js';

export const BAR_MIN_PRS = 50;
export const BAR_MIN_PRECISION = 0.95;

export interface AgreedFinding {
  title: string;
  stagedSeverity: ReviewLedgerSeverity;
  standaloneSeverity: ReviewLedgerSeverity;
}

export interface SideOnlyFinding {
  title: string;
  severity: ReviewLedgerSeverity;
  /** Roles that raised it; set only on the standalone side. */
  roles?: ReviewLedgerRole[];
}

export interface FindingDiff {
  stagedOnly: SideOnlyFinding[];
  standaloneOnly: SideOnlyFinding[];
  agreed: AgreedFinding[];
}

export interface ComparedCase {
  taskId: string;
  prNumber: number | null;
  commitSha: string;
  iteration: number;
  stagedBlocked: boolean;
  standaloneBlocked: boolean;
  overall: FindingDiff;
  /** Staged findings against the security reviewer's; null when no security row exists. */
  security: (FindingDiff & { securityBlocked: boolean }) | null;
  flagged: boolean;
  /** Blocking findings only one side raised. */
  stagedOnlyBlocking: number;
  standaloneOnlyBlocking: number;
}

export interface BarSubset {
  comparedPrs: number;
  comparedCases: number;
  stagedBlocks: number;
  confirmedBlocks: number;
  /** confirmedBlocks / stagedBlocks; null with no staged block. */
  actBandPrecision: number | null;
  met: boolean;
}

export interface ComparisonReport {
  cases: ComparedCase[];
  flaggedCases: number;
  bar: { required: { prs: number; precision: number }; overall: BarSubset; security: BarSubset };
}

const RANK: Record<ReviewLedgerSeverity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  suggestion: 0,
};

function isBlockingSeverity(s: ReviewLedgerSeverity): boolean {
  return s === 'critical' || s === 'major';
}

/** Highest severity per title, with the roles that raised it. */
function indexFindings(
  records: ReviewLedgerRecord[],
): Map<string, { severity: ReviewLedgerSeverity; roles: ReviewLedgerRole[] }> {
  const out = new Map<string, { severity: ReviewLedgerSeverity; roles: ReviewLedgerRole[] }>();
  for (const rec of records) {
    for (const f of rec.findings as ReviewLedgerFinding[]) {
      const cur = out.get(f.title);
      if (!cur) {
        out.set(f.title, { severity: f.severity, roles: [rec.role] });
        continue;
      }
      if (RANK[f.severity] > RANK[cur.severity]) cur.severity = f.severity;
      if (!cur.roles.includes(rec.role)) cur.roles.push(rec.role);
    }
  }
  return out;
}

function diffSides(staged: ReviewLedgerRecord[], standalone: ReviewLedgerRecord[]): FindingDiff {
  const a = indexFindings(staged);
  const b = indexFindings(standalone);
  const diff: FindingDiff = { stagedOnly: [], standaloneOnly: [], agreed: [] };
  for (const [title, s] of a) {
    const o = b.get(title);
    if (o) diff.agreed.push({ title, stagedSeverity: s.severity, standaloneSeverity: o.severity });
    else diff.stagedOnly.push({ title, severity: s.severity });
  }
  for (const [title, o] of b) {
    if (!a.has(title)) diff.standaloneOnly.push({ title, severity: o.severity, roles: o.roles });
  }
  return diff;
}

const blocked = (recs: ReviewLedgerRecord[]): boolean => recs.some((r) => r.verdict === 'rejected');

/** Compare every cycle that has both a staged row and at least one gating row. */
export function compareStagedToGating(records: ReviewLedgerRecord[]): ComparisonReport {
  const cycles = new Map<string, Partial<Record<ReviewLedgerRole, ReviewLedgerRecord>>>();
  for (const r of records) {
    const key = `${r.taskId}::${r.commitSha}::${r.iteration}`;
    const c =
      cycles.get(key) ??
      (Object.create(null) as Partial<Record<ReviewLedgerRole, ReviewLedgerRecord>>);
    // A re-run of the same role in a cycle replaces the earlier row, as the analysis does.
    if (r.role === 'staged' || r.gating !== false) c[r.role] = r;
    cycles.set(key, c);
  }

  const cases: ComparedCase[] = [];
  for (const cycle of cycles.values()) {
    const stagedRec = cycle.staged;
    const standalone = (Object.keys(cycle) as ReviewLedgerRole[])
      .filter((role) => role !== 'staged')
      .map((role) => cycle[role] as ReviewLedgerRecord);
    if (!stagedRec || standalone.length === 0) continue;

    const overall = diffSides([stagedRec], standalone);
    const securityRec = cycle.security;
    const security = securityRec
      ? { ...diffSides([stagedRec], [securityRec]), securityBlocked: blocked([securityRec]) }
      : null;
    const stagedOnlyBlocking = overall.stagedOnly.filter((f) =>
      isBlockingSeverity(f.severity),
    ).length;
    const standaloneOnlyBlocking = overall.standaloneOnly.filter((f) =>
      isBlockingSeverity(f.severity),
    ).length;
    cases.push({
      taskId: stagedRec.taskId,
      prNumber: stagedRec.prNumber,
      commitSha: stagedRec.commitSha,
      iteration: stagedRec.iteration,
      stagedBlocked: blocked([stagedRec]),
      standaloneBlocked: blocked(standalone),
      overall,
      security,
      flagged: stagedOnlyBlocking > 0 || standaloneOnlyBlocking > 0,
      stagedOnlyBlocking,
      standaloneOnlyBlocking,
    });
  }

  cases.sort(
    (x, y) =>
      Number(y.flagged) - Number(x.flagged) ||
      x.taskId.localeCompare(y.taskId) ||
      x.iteration - y.iteration,
  );

  const secCases = cases.filter((c) => c.security);
  return {
    cases,
    flaggedCases: cases.filter((c) => c.flagged).length,
    bar: {
      required: { prs: BAR_MIN_PRS, precision: BAR_MIN_PRECISION },
      overall: barSubset(
        cases.map((c) => ({
          taskId: c.taskId,
          staged: c.stagedBlocked,
          other: c.standaloneBlocked,
        })),
      ),
      security: barSubset(
        secCases.map((c) => ({
          taskId: c.taskId,
          staged: c.stagedBlocked,
          other: (c.security as { securityBlocked: boolean }).securityBlocked,
        })),
      ),
    },
  };
}

function barSubset(rows: Array<{ taskId: string; staged: boolean; other: boolean }>): BarSubset {
  const stagedBlocks = rows.filter((r) => r.staged).length;
  const confirmedBlocks = rows.filter((r) => r.staged && r.other).length;
  const comparedPrs = new Set(rows.map((r) => r.taskId)).size;
  const actBandPrecision = stagedBlocks === 0 ? null : confirmedBlocks / stagedBlocks;
  return {
    comparedPrs,
    comparedCases: rows.length,
    stagedBlocks,
    confirmedBlocks,
    actBandPrecision,
    met:
      comparedPrs >= BAR_MIN_PRS &&
      actBandPrecision !== null &&
      actBandPrecision >= BAR_MIN_PRECISION,
  };
}

function renderDiff(diff: FindingDiff, indent: string): string[] {
  const lines: string[] = [];
  for (const f of diff.stagedOnly) lines.push(`${indent}staged-only    [${f.severity}] ${f.title}`);
  for (const f of diff.standaloneOnly) {
    lines.push(
      `${indent}standalone-only [${f.severity}] ${f.title} (${(f.roles ?? []).join(',')})`,
    );
  }
  for (const f of diff.agreed) {
    lines.push(
      `${indent}agreed         [staged ${f.stagedSeverity} / standalone ${f.standaloneSeverity}] ${f.title}`,
    );
  }
  if (lines.length === 0) lines.push(`${indent}(no findings on either side)`);
  return lines;
}

export function renderBar(bar: ComparisonReport['bar']): string[] {
  const row = (name: string, s: BarSubset): string => {
    const p = s.actBandPrecision === null ? 'n/a' : s.actBandPrecision.toFixed(3);
    return (
      `  ${name.padEnd(9)} compared PRs ${s.comparedPrs}, act-band precision ${p} ` +
      `(${s.confirmedBlocks}/${s.stagedBlocks} staged blocks confirmed): ` +
      `${s.met ? 'met' : 'not met'} (need ${bar.required.prs} PRs and ${bar.required.precision})`
    );
  };
  return ['Relax bar:', row('overall', bar.overall), row('security', bar.security)];
}

export function formatComparison(report: ComparisonReport, opts: { bar?: boolean } = {}): string {
  const lines: string[] = [
    `Compared cases: ${report.cases.length} (${report.flaggedCases} flagged for re-evaluation)`,
  ];
  for (const c of report.cases) {
    lines.push('');
    lines.push(
      `${c.flagged ? 'FLAGGED ' : ''}${c.taskId} @ ${c.commitSha.slice(0, 8)} iteration ${c.iteration}: ` +
        `staged ${c.stagedBlocked ? 'rejected' : 'approved'}, standalone ${c.standaloneBlocked ? 'rejected' : 'approved'}`,
    );
    lines.push(...renderDiff(c.overall, '  '));
    if (c.security) {
      lines.push('  security (staged vs security-reviewer):');
      lines.push(...renderDiff(c.security, '    '));
    }
  }
  if (opts.bar) {
    lines.push('');
    lines.push(...renderBar(report.bar));
  }
  return lines.join('\n');
}
