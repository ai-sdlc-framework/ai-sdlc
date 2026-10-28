/**
 * Model family aliases for routing-table changes (RFC-0050 B5).
 *
 * Routing cells name a family alias (`sonnet`, `opus`, `haiku`) so a role
 * follows new releases. Evidence recorded under a versioned id and evidence
 * recorded under the alias of the same family are the same model when the
 * table uses aliases.
 *
 * @module usage/route-alias
 */

import type { RoutingTable } from '../routing/default-table.js';
import type { UnitWeights } from './units.js';
import type { EvidenceScorecard } from '../routing/evaluate-cell.js';

const FAMILIES = ['haiku', 'sonnet', 'opus'] as const;
const FAMILY_PATTERN = /(?:^|[^a-z])(haiku|sonnet|opus)(?:[^a-z]|$)/;

/** The family of an alias or versioned id, or null when it maps to no known family. */
export function familyOf(model: string): string | null {
  return FAMILY_PATTERN.exec(model.toLowerCase())?.[1] ?? null;
}

/** Whether the name is exactly a family alias. */
export function isFamilyAlias(model: string): boolean {
  return (FAMILIES as readonly string[]).includes(model);
}

/** A table is an alias table when any cell model or `strength` entry is a bare family alias. */
export function isAliasTable(table: RoutingTable): boolean {
  if (table.strength.some(isFamilyAlias)) return true;
  return Object.values(table.cells).some((byClass) =>
    Object.values(byClass).some((c) => isFamilyAlias(c.model)),
  );
}

/** Whether a scorecard row recorded under `rowModel` counts as `model`. */
export function sameModel(rowModel: string, model: string, aliasTable: boolean): boolean {
  if (rowModel === model) return true;
  if (!aliasTable) return false;
  const f = familyOf(model);
  return isFamilyAlias(model) && f !== null && familyOf(rowModel) === f;
}

/** The scorecard with every row's model folded into its family alias (alias tables only). */
export function foldScorecard<T extends EvidenceScorecard>(card: T, aliasTable: boolean): T {
  if (!aliasTable) return card;
  return {
    ...card,
    rows: card.rows.map((r) => ({ ...r, model: familyOf(r.model) ?? r.model })),
  };
}

/**
 * Unit weights with each family alias priced like the dearest derived id of its
 * family, so an alias cell can be compared with a candidate alias.
 */
export function foldWeights(weights: UnitWeights, aliasTable: boolean): UnitWeights {
  if (!aliasTable) return weights;
  const folded: Record<string, number> = { ...weights.modelMultipliers };
  for (const [model, mult] of Object.entries(weights.modelMultipliers)) {
    const f = familyOf(model);
    if (f !== null && !isFamilyAlias(model)) folded[f] = Math.max(folded[f] ?? 0, mult);
  }
  return { ...weights, modelMultipliers: folded };
}
