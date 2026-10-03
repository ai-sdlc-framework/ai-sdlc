/**
 * Input budgets for the planner and synthesizer.
 *
 * Truncation is by risk-map rank, never by position: items are considered from
 * the highest rank (rank 1) down, so the least risky content is what gets
 * omitted, whatever order it appeared in. The result is deterministic and the
 * omission is always recorded.
 *
 * @module review-synth/budget
 */

import type { TruncationRecord } from './types.js';

/** Rough token estimate: four characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BudgetItem<T> {
  id: string;
  /** 1 is the highest risk. A missing or non-finite rank sorts last. */
  rank: number;
  tokens: number;
  value: T;
}

export interface BudgetResult<T> {
  /** Kept items, in rank order. */
  kept: BudgetItem<T>[];
  omitted: BudgetItem<T>[];
  record: TruncationRecord;
}

function rankKey(rank: number): number {
  return Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

/**
 * Keep items in rank order until the budget is spent. The first item that does
 * not fit, and everything ranked below it, is omitted: a lower-ranked item is
 * never kept in place of a higher-ranked one. Ties break on id. `maxItems`, when given,
 * is an additional count cap with the same rank rule: items past it are omitted.
 */
export function budgetByRank<T>(
  section: string,
  items: readonly BudgetItem<T>[],
  budgetTokens: number,
  maxItems?: number,
): BudgetResult<T> {
  const ordered = [...items].sort((a, b) => {
    const ra = rankKey(a.rank);
    const rb = rankKey(b.rank);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const budget = Number.isFinite(budgetTokens) ? Math.max(0, budgetTokens) : 0;
  const kept: BudgetItem<T>[] = [];
  const omitted: BudgetItem<T>[] = [];
  let used = 0;
  let full = false;
  for (const item of ordered) {
    const countFull = maxItems !== undefined && kept.length >= Math.max(0, maxItems);
    if (!full && !countFull && used + item.tokens <= budget) {
      kept.push(item);
      used += item.tokens;
    } else {
      full = true;
      omitted.push(item);
    }
  }
  return {
    kept,
    omitted,
    record: {
      section,
      budgetTokens: budget,
      usedTokens: used,
      keptCount: kept.length,
      omittedCount: omitted.length,
      omittedIds: omitted.map((i) => i.id),
    },
  };
}

const MAX_LISTED_IDS = 50;

/** Render truncation records as the block the agent copies into its transcript. */
export function renderTruncationBlock(records: readonly TruncationRecord[]): string {
  const lines = records.map((r) => {
    if (r.omittedCount === 0)
      return (
        `- ${r.section}: all ${r.keptCount} items kept ` +
        `(${r.usedTokens}/${r.budgetTokens} tokens)`
      );
    const shown = r.omittedIds.slice(0, MAX_LISTED_IDS).join(', ');
    const extra = r.omittedIds.length - MAX_LISTED_IDS;
    const more = extra > 0 ? `, +${extra} more` : '';
    return (
      `- ${r.section}: kept ${r.keptCount}, omitted ${r.omittedCount} lowest-ranked ` +
      `(${r.usedTokens}/${r.budgetTokens} tokens); omitted: ${shown}${more}`
    );
  });
  return ['TRUNCATION RECORD (copy verbatim into your transcript):', ...lines].join('\n');
}
