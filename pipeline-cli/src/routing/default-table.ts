/**
 * Built-in default routing table.
 *
 * Reproduces exactly the per-role models the Tier 2 spawner has always used
 * (developer, code and test reviewers on sonnet; security reviewer on opus),
 * with no candidates. A repository with no `.ai-sdlc/model-routing.yaml` on
 * its base ref resolves every role through this table, so behaviour is
 * unchanged until a repo adopts its own table.
 *
 * @module routing/default-table
 */

/**
 * Per-role model defaults. The single source for the spawner's fixed map.
 * Family aliases, not versioned ids: the harness resolves them to the current
 * release (AISDLC-690). A routing table cell or override may pin a full id.
 */
export const DEFAULT_ROLE_MODELS: Readonly<Record<string, string>> = {
  developer: 'sonnet',
  'code-reviewer': 'sonnet',
  'test-reviewer': 'sonnet',
  'security-reviewer': 'opus',
};

/** The role that is never explored and never accepts candidates. */
export const SECURITY_REVIEWER_ROLE = 'security-reviewer';

export interface RoutingCell {
  model: string;
  candidates?: string[];
  /** Reference to the evidence that justified `model` (a path or id, never content). */
  evidence?: string;
  /** The model this cell used before the change `evidence` records. */
  previousModel?: string;
}

export interface RoutingTable {
  /** Models, weakest first. */
  strength: string[];
  exploreShare: number;
  salt: string;
  /** role -> task class (or '*') -> cell. */
  cells: Record<string, Record<string, RoutingCell>>;
}

/** The built-in default table: one wildcard cell per role, no candidates. */
export function builtInDefaultTable(): RoutingTable {
  const cells: RoutingTable['cells'] = {};
  for (const [role, model] of Object.entries(DEFAULT_ROLE_MODELS)) {
    cells[role] = { '*': { model } };
  }
  return {
    strength: ['sonnet', 'opus'],
    exploreShare: 0,
    salt: '',
    cells,
  };
}
