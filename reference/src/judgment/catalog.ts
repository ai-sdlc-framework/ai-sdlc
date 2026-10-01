import type { JudgmentDefinition } from './definition.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefinition = JudgmentDefinition<any, any>;

const DEFINITIONS = new Map<string, AnyDefinition>();

const DIRECTIONS: readonly unknown[] = ['tighten-only', 'bidirectional'];
const RISK_CLASSES: readonly unknown[] = ['seam', 'tighten', 'relax'];

function reject(id: unknown, rule: string): never {
  throw new Error(`Judgment definition '${String(id)}' rejected: ${rule}`);
}

/**
 * Registration-time safety rules. All fail closed. Declarations are the author's
 * attestation; the registry cannot observe what `compose` returns.
 */
function validateSafety(definition: AnyDefinition): void {
  const { id, riskClass, direction, fallback, reducesReview, reducingOutcomes } = definition;
  if (!RISK_CLASSES.includes(riskClass)) {
    reject(id, `riskClass must be 'seam', 'tighten' or 'relax' (got ${JSON.stringify(riskClass)})`);
  }
  if (!DIRECTIONS.includes(direction)) {
    reject(
      id,
      `direction must be 'tighten-only' or 'bidirectional' (got ${JSON.stringify(direction)})`,
    );
  }
  if (reducesReview !== undefined && typeof reducesReview !== 'boolean') {
    reject(id, 'reducesReview must be a boolean when declared');
  }
  if (
    reducingOutcomes !== undefined &&
    (!Array.isArray(reducingOutcomes) || reducingOutcomes.some((o) => typeof o !== 'string'))
  ) {
    reject(id, 'reducingOutcomes must be an array of strings when declared');
  }
  // (a) seam requires the pending fallback.
  if (riskClass === 'seam' && fallback !== 'pending') {
    reject(id, "rule (a): a 'seam' definition must declare fallback: 'pending'");
  }
  // (b) seam + bidirectional must explicitly declare no reducing outcomes.
  if (riskClass === 'seam' && direction === 'bidirectional') {
    if (reducingOutcomes === undefined || reducingOutcomes.length !== 0) {
      reject(
        id,
        "rule (b): a 'seam' definition that is 'bidirectional' must declare reducingOutcomes as an empty array",
      );
    }
  }
  // (c) anything that reduces review is held to the relax bar.
  const hasReducing = reducingOutcomes !== undefined && reducingOutcomes.length > 0;
  if (hasReducing && reducesReview !== true) {
    reject(id, 'rule (c): reducingOutcomes is non-empty but reducesReview is not true');
  }
  if ((reducesReview === true || hasReducing) && riskClass !== 'relax') {
    reject(id, "rule (c): a definition that reduces review must have riskClass 'relax'");
  }
}

/**
 * Register a judgment definition. Duplicate ids and definitions that violate the
 * registration-time safety rules are rejected without changing the registry.
 */
export function registerJudgmentDefinition<I, D>(definition: JudgmentDefinition<I, D>): void {
  if (DEFINITIONS.has(definition.id)) {
    throw new Error(`Judgment definition '${definition.id}' is already registered`);
  }
  validateSafety(definition);
  DEFINITIONS.set(definition.id, definition);
}

/** Look up a definition by id; undefined when absent. */
export function getJudgmentDefinition(id: string): AnyDefinition | undefined {
  return DEFINITIONS.get(id);
}

export function listJudgmentDefinitions(): AnyDefinition[] {
  return [...DEFINITIONS.values()];
}
