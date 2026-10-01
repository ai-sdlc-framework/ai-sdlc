import type { JudgmentDefinition } from './definition.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefinition = JudgmentDefinition<any, any>;

const DEFINITIONS = new Map<string, AnyDefinition>();

/** Register a judgment definition. Duplicate ids are rejected. */
export function registerJudgmentDefinition<I, D>(definition: JudgmentDefinition<I, D>): void {
  if (DEFINITIONS.has(definition.id)) {
    throw new Error(`Judgment definition '${definition.id}' is already registered`);
  }
  DEFINITIONS.set(definition.id, definition);
}

/** Look up a definition by id; undefined when absent. */
export function getJudgmentDefinition(id: string): AnyDefinition | undefined {
  return DEFINITIONS.get(id);
}

export function listJudgmentDefinitions(): AnyDefinition[] {
  return [...DEFINITIONS.values()];
}
