/**
 * Reviewer marginal-value analysis (AISDLC-616).
 *
 * Consumes the append-only reviews ledger (`reviews-ledger.ts`) and computes
 * the metrics needed to answer the motivating question: **does running 3
 * reviewers catch materially more blocking defects than 1 would?**
 *
 * ## Grouping: "review cycles"
 *
 * Records are grouped into a "review cycle" — one code review pass over one
 * commit — keyed by `(taskId, commitSha, iteration)`. Within a cycle, each
 * role (code/test/security) contributes at most one record (the CLI/pipeline
 * wiring calls `emit-leaf` once per reviewer per iteration).
 *
 * ## Metrics
 *
 * - **Block rate** (per role): fraction of cycles a role participated in
 *   where that role's own verdict was `rejected`.
 * - **Sole-blocker rate** (per role): fraction of cycles where a role
 *   blocked AND no other role in the SAME cycle also blocked — the role
 *   caught something nobody else would have.
 * - **Cross-reviewer overlap** (per role pair): of the union of normalized
 *   finding titles raised by either role across all cycles both
 *   participated in, what fraction were raised by BOTH roles.
 * - **Discordant-pair count** (per role, McNemar-style): number of cycles
 *   where the PANEL decision (blocked if ANY participating role blocked)
 *   disagrees with what a SINGLE reviewer of that role, acting alone, would
 *   have decided. Because the panel decision is the logical OR of every
 *   role's decision, the panel can only ever block MORE than (or equal to) a
 *   single role — so this count is exactly "how many times did the OTHER
 *   reviewers catch something role R would have missed acting alone". This
 *   is the direct answer to the reviewer-cost question: a role with 0
 *   discordant cycles across a large enough corpus contributed nothing the
 *   other reviewers didn't already catch.
 *
 * @module attestation/reviews-analysis
 */

import type { ReviewLedgerRecord, ReviewLedgerRole } from './reviews-ledger.js';

/** Per-role stats computed by {@link analyzeReviewLedger}. */
export interface RoleStats {
  role: ReviewLedgerRole;
  /** Number of review cycles this role participated in. */
  participatedCycles: number;
  /** Number of those cycles where this role's own verdict was 'rejected'. */
  blockedCycles: number;
  /** blockedCycles / participatedCycles (0 when participatedCycles === 0). */
  blockRate: number;
  /** Cycles where this role blocked AND no other participating role blocked. */
  soleBlockerCycles: number;
  /** soleBlockerCycles / participatedCycles (0 when participatedCycles === 0). */
  soleBlockerRate: number;
  /**
   * McNemar-style: cycles where the PANEL blocked (any role) but this role
   * ALONE would not have (i.e. the other reviewers caught something this
   * role missed).
   */
  discordantCycles: number;
  /** discordantCycles / participatedCycles (0 when participatedCycles === 0). */
  discordantRate: number;
}

/** Cross-reviewer finding overlap for one unordered role pair. */
export interface PairOverlap {
  roleA: ReviewLedgerRole;
  roleB: ReviewLedgerRole;
  /** Cycles where BOTH roles participated. */
  cyclesBothParticipated: number;
  /** Count of distinct normalized finding titles raised by either role, summed across cycles. */
  unionFindingCount: number;
  /** Count of distinct normalized finding titles raised by BOTH roles in the same cycle, summed. */
  overlapFindingCount: number;
  /** overlapFindingCount / unionFindingCount (0 when unionFindingCount === 0). */
  overlapRatio: number;
}

export interface ReviewAnalysisResult {
  /** Total number of distinct (taskId, commitSha, iteration) review cycles observed. */
  totalCycles: number;
  perRole: RoleStats[];
  pairOverlaps: PairOverlap[];
}

// AISDLC-617 — 'correctness' (the opt-in merged code+test reviewer role) is
// included so cycles run under `reviewerSet: code-test-merged` are not
// silently dropped from the analysis. A cycle only ever has EITHER
// {code, test} OR {correctness}, never both, so per-role stats and pair
// overlaps degrade gracefully (0 participation) for whichever set a given
// repo/period didn't use.
const ALL_ROLES: ReviewLedgerRole[] = ['code', 'test', 'security', 'correctness'];

function cycleKey(record: ReviewLedgerRecord): string {
  return `${record.taskId}::${record.commitSha}::${record.iteration}`;
}

function isBlocked(record: ReviewLedgerRecord): boolean {
  return record.verdict === 'rejected';
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Group records into review cycles keyed by `(taskId, commitSha, iteration)`.
 * When a role has multiple records in the same cycle (should not happen in
 * practice — each `emit-leaf` call is one role/iteration — but the ledger is
 * append-only so a caller bug could theoretically double-append), the LAST
 * record for that role in file order wins, matching "most recent write" for
 * an append-only log.
 */
function groupIntoCycles(
  records: ReviewLedgerRecord[],
): Map<string, Partial<Record<ReviewLedgerRole, ReviewLedgerRecord>>> {
  const cycles = new Map<string, Partial<Record<ReviewLedgerRole, ReviewLedgerRecord>>>();
  for (const record of records) {
    const key = cycleKey(record);
    const cycle = cycles.get(key) ?? {};
    cycle[record.role] = record;
    cycles.set(key, cycle);
  }
  return cycles;
}

/**
 * Compute the full marginal-value analysis over a flat list of ledger
 * records (typically the output of `loadAllReviewLedgers()`, possibly
 * concatenated across multiple `--repo-root` invocations for a
 * multi-repo corpus).
 */
export function analyzeReviewLedger(records: ReviewLedgerRecord[]): ReviewAnalysisResult {
  const cycles = groupIntoCycles(records);
  const cycleList = [...cycles.values()];

  const perRole: RoleStats[] = ALL_ROLES.map((role) => {
    let participatedCycles = 0;
    let blockedCycles = 0;
    let soleBlockerCycles = 0;
    let discordantCycles = 0;

    for (const cycle of cycleList) {
      const own = cycle[role];
      if (!own) continue;
      participatedCycles++;

      const ownBlocked = isBlocked(own);
      if (ownBlocked) blockedCycles++;

      const otherRoles = ALL_ROLES.filter((r) => r !== role);
      const anyOtherBlocked = otherRoles.some((r) => {
        const other = cycle[r];
        return other ? isBlocked(other) : false;
      });

      if (ownBlocked && !anyOtherBlocked) soleBlockerCycles++;

      const panelBlocked = ownBlocked || anyOtherBlocked;
      if (panelBlocked && !ownBlocked) discordantCycles++;
    }

    return {
      role,
      participatedCycles,
      blockedCycles,
      blockRate: safeDiv(blockedCycles, participatedCycles),
      soleBlockerCycles,
      soleBlockerRate: safeDiv(soleBlockerCycles, participatedCycles),
      discordantCycles,
      discordantRate: safeDiv(discordantCycles, participatedCycles),
    };
  });

  const pairOverlaps: PairOverlap[] = [];
  for (let i = 0; i < ALL_ROLES.length; i++) {
    for (let j = i + 1; j < ALL_ROLES.length; j++) {
      const roleA = ALL_ROLES[i]!;
      const roleB = ALL_ROLES[j]!;
      let cyclesBothParticipated = 0;
      let unionFindingCount = 0;
      let overlapFindingCount = 0;

      for (const cycle of cycleList) {
        const recA = cycle[roleA];
        const recB = cycle[roleB];
        if (!recA || !recB) continue;
        cyclesBothParticipated++;

        const titlesA = new Set(recA.findings.map((f) => f.title));
        const titlesB = new Set(recB.findings.map((f) => f.title));
        const union = new Set([...titlesA, ...titlesB]);
        let overlap = 0;
        for (const title of union) {
          if (titlesA.has(title) && titlesB.has(title)) overlap++;
        }
        unionFindingCount += union.size;
        overlapFindingCount += overlap;
      }

      pairOverlaps.push({
        roleA,
        roleB,
        cyclesBothParticipated,
        unionFindingCount,
        overlapFindingCount,
        overlapRatio: safeDiv(overlapFindingCount, unionFindingCount),
      });
    }
  }

  return {
    totalCycles: cycleList.length,
    perRole,
    pairOverlaps,
  };
}

/** Render a {@link ReviewAnalysisResult} as a human-readable plain-text table. */
export function formatReviewAnalysis(result: ReviewAnalysisResult): string {
  const lines: string[] = [];
  lines.push(`Review cycles analyzed: ${result.totalCycles}`);
  lines.push('');
  lines.push('Per-role:');
  lines.push(
    '  role      participated  blocked  blockRate  soleBlocker  soleBlockerRate  discordant  discordantRate',
  );
  for (const r of result.perRole) {
    lines.push(
      `  ${r.role.padEnd(9)} ${String(r.participatedCycles).padStart(12)}  ` +
        `${String(r.blockedCycles).padStart(7)}  ${r.blockRate.toFixed(3).padStart(9)}  ` +
        `${String(r.soleBlockerCycles).padStart(11)}  ${r.soleBlockerRate.toFixed(3).padStart(15)}  ` +
        `${String(r.discordantCycles).padStart(10)}  ${r.discordantRate.toFixed(3).padStart(14)}`,
    );
  }
  lines.push('');
  lines.push('Cross-reviewer finding overlap:');
  lines.push('  pair              bothParticipated  union  overlap  overlapRatio');
  for (const p of result.pairOverlaps) {
    lines.push(
      `  ${(p.roleA + '/' + p.roleB).padEnd(16)}  ${String(p.cyclesBothParticipated).padStart(16)}  ` +
        `${String(p.unionFindingCount).padStart(5)}  ${String(p.overlapFindingCount).padStart(7)}  ` +
        `${p.overlapRatio.toFixed(3).padStart(12)}`,
    );
  }
  return lines.join('\n');
}
