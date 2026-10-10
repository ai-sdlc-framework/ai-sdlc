/**
 * Knowledge ontology (RFC-0053 OQ-1 / OQ-3): the trunks, entry types, allowed
 * relations and the closed proof-kind vocabulary used later for promotion.
 * The file lives at `<trackedRoot>/ontology.yaml`; when absent the built-in
 * default applies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface Ontology {
  trunks: string[];
  entryTypes: string[];
  relations: string[];
  proofKinds: string[];
}

export const ONTOLOGY_FILE = 'ontology.yaml';

export const DEFAULT_ONTOLOGY: Ontology = {
  trunks: ['systems', 'products', 'customers', 'decisions', 'people', 'process'],
  entryTypes: ['fact', 'decision', 'constraint', 'procedure', 'person', 'system'],
  relations: ['supports', 'contradicts', 'supersedes', 'depends_on'],
  proofKinds: ['test-id', 'decision-id', 'path-exists', 'allowlisted-command'],
};

const ONTOLOGY_KEYS = Object.keys(DEFAULT_ONTOLOGY) as (keyof Ontology)[];

/** Parse and validate ontology YAML text; returns the ontology and any errors. */
export function parseOntology(text: string): { ontology: Ontology; errors: string[] } {
  const errors: string[] = [];
  const ontology: Ontology = { trunks: [], entryTypes: [], relations: [], proofKinds: [] };
  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return { ontology, errors: [`ontology: invalid YAML: ${(err as Error).message}`] };
  }
  const obj = (doc ?? {}) as Record<string, unknown>;
  for (const key of ONTOLOGY_KEYS) {
    const v = obj[key];
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x !== '')) {
      errors.push(`ontology: '${key}' must be a non-empty list of strings`);
    } else {
      ontology[key] = v as string[];
    }
  }
  return { ontology, errors };
}

export function loadOntology(trackedRootAbs: string): { ontology: Ontology; errors: string[] } {
  const file = join(trackedRootAbs, ONTOLOGY_FILE);
  if (!existsSync(file)) return { ontology: DEFAULT_ONTOLOGY, errors: [] };
  return parseOntology(readFileSync(file, 'utf-8'));
}
