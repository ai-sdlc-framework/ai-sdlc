import type { JudgmentDefinition } from './definition.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefinition = JudgmentDefinition<any, any>;

const DEFINITIONS = new Map<string, AnyDefinition>();

const DIRECTIONS: readonly unknown[] = ['tighten-only', 'bidirectional'];
const RISK_CLASSES: readonly unknown[] = ['seam', 'tighten', 'relax'];

/**
 * Registration-time safety rules over the declarations. All fail closed. The rules check
 * what the author declared, not what `compose` does: declarations are the author's
 * attestation, reviewed in code review. Returns the violation message, or undefined.
 */
export function validateJudgmentDefinitionSafety(definition: AnyDefinition): string | undefined {
  const { id, riskClass, direction, fallback, reducesReview, reducingOutcomes } = definition;
  if (typeof id !== 'string' || id.length === 0) {
    return 'id must be a non-empty string';
  }
  if (!RISK_CLASSES.includes(riskClass)) {
    return `riskClass must be 'seam', 'tighten' or 'relax' (got ${JSON.stringify(riskClass)})`;
  }
  if (!DIRECTIONS.includes(direction)) {
    return `direction must be 'tighten-only' or 'bidirectional' (got ${JSON.stringify(direction)})`;
  }
  if (reducesReview !== undefined && typeof reducesReview !== 'boolean') {
    return 'reducesReview must be a boolean when declared';
  }
  if (reducingOutcomes !== undefined) {
    if (
      !Array.isArray(reducingOutcomes) ||
      reducingOutcomes.some((o) => typeof o !== 'string' || o.length === 0)
    ) {
      return 'reducingOutcomes must be an array of non-empty strings when declared';
    }
  }
  // (a) seam requires the pending fallback.
  if (riskClass === 'seam' && fallback !== 'pending') {
    return "rule (a): a 'seam' definition must declare fallback: 'pending'";
  }
  // (b) seam + bidirectional must explicitly declare no reducing outcomes.
  if (riskClass === 'seam' && direction === 'bidirectional') {
    if (reducingOutcomes === undefined || reducingOutcomes.length !== 0) {
      return "rule (b): a 'seam' definition that is 'bidirectional' must declare reducingOutcomes as an empty array";
    }
  }
  // (c) anything that reduces review is held to the relax bar.
  const hasReducing = reducingOutcomes !== undefined && reducingOutcomes.length > 0;
  if (hasReducing && reducesReview !== true) {
    return 'rule (c): reducingOutcomes is non-empty but reducesReview is not true';
  }
  if ((reducesReview === true || hasReducing) && riskClass !== 'relax') {
    return "rule (c): a definition that reduces review must have riskClass 'relax'";
  }
  // (d) a bidirectional definition can decide permissively; it must say whether it can
  // reduce review (undeclared means unknown, so reject).
  if (direction === 'bidirectional' && typeof reducesReview !== 'boolean') {
    return "rule (d): a 'bidirectional' definition must declare reducesReview explicitly (true or false)";
  }
  return undefined;
}

export type DefinitionSnapshot =
  | { ok: true; definition: AnyDefinition }
  | { ok: false; id: string; error: string };

/**
 * Read every field of the definition exactly once, validate that copy, and return a
 * frozen shallow copy. Later mutation or stateful getters on the original cannot change
 * what is validated or stored. Never throws.
 */
export function snapshotJudgmentDefinition(definition: AnyDefinition): DefinitionSnapshot {
  let id = '';
  try {
    const d = definition;
    const rawId = d.id;
    id = typeof rawId === 'string' ? rawId : String(rawId);
    const reducing = d.reducingOutcomes;
    const copy = {
      id: rawId,
      version: d.version,
      egressClass: d.egressClass,
      direction: d.direction,
      riskClass: d.riskClass,
      fallback: d.fallback,
      reducesReview: d.reducesReview,
      reducingOutcomes: Array.isArray(reducing) ? Object.freeze([...reducing]) : reducing,
      capabilityId: d.capabilityId,
      buildState: bindMember(d.buildState, d),
      questions: bindMember(d.questions, d),
      compose: bindMember(d.compose, d),
      agrees: bindMember(d.agrees, d),
    } as AnyDefinition;
    for (const k of Object.keys(copy) as (keyof AnyDefinition)[]) {
      if (copy[k] === undefined) delete copy[k];
    }
    const error = validateJudgmentDefinitionSafety(copy);
    if (error !== undefined) return { ok: false, id, error };
    return { ok: true, definition: Object.freeze(copy) };
  } catch (e) {
    return { ok: false, id, error: `definition could not be read: ${(e as Error).message}` };
  }
}

function bindMember<T>(fn: T, owner: unknown): T {
  return typeof fn === 'function' ? (fn.bind(owner) as T) : fn;
}

/**
 * Register a judgment definition. Duplicate ids and definitions that violate the
 * registration-time safety rules are rejected without changing the registry. The stored
 * definition is a frozen copy.
 */
export function registerJudgmentDefinition<I, D>(definition: JudgmentDefinition<I, D>): void {
  const snap = snapshotJudgmentDefinition(definition);
  if (!snap.ok) {
    throw new Error(`Judgment definition '${snap.id}' rejected: ${snap.error}`);
  }
  if (DEFINITIONS.has(snap.definition.id)) {
    throw new Error(`Judgment definition '${snap.definition.id}' is already registered`);
  }
  DEFINITIONS.set(snap.definition.id, snap.definition);
}

/** Look up a definition by id; undefined when absent. */
export function getJudgmentDefinition(id: string): AnyDefinition | undefined {
  return DEFINITIONS.get(id);
}

export function listJudgmentDefinitions(): AnyDefinition[] {
  return [...DEFINITIONS.values()];
}
