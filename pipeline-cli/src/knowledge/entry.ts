/**
 * Knowledge entry schema (RFC-0053 section A) and its validator.
 *
 * An entry is a markdown file with YAML frontmatter. Fields: id, trunk, type,
 * value, confidence, authority, scope, source, observed, decay, relations,
 * supersedes, contentHash. `contentHash` is the sha256 hex of `value`.
 * Agent-written entries (`writtenBy: agent`) are capped at authority
 * `inferred`, confidence 0.85, and must carry a `reverify` note (OQ-3).
 */
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Ontology } from './ontology.js';

export const SCOPES = ['internal', 'universal', 'protected'] as const;
export const AUTHORITIES = ['inferred', 'specialist', 'canonical'] as const;
export const DECAYS = ['volatile', 'seasonal', 'durable', 'evergreen'] as const;
export const AGENT_CONFIDENCE_CAP = 0.85;

export type Scope = (typeof SCOPES)[number];

export interface KnowledgeRelation {
  type: string;
  target: string;
}

export interface KnowledgeEntry {
  id: string;
  trunk: string;
  type: string;
  value: string;
  confidence: number;
  authority: string;
  scope: string;
  source: string;
  observed: string;
  decay: string;
  relations: KnowledgeRelation[];
  supersedes?: string;
  contentHash: string;
  writtenBy?: string;
  reverify?: string;
  /** Markdown body after the frontmatter. */
  body: string;
}

const REQUIRED_FIELDS = [
  'id',
  'trunk',
  'type',
  'value',
  'confidence',
  'authority',
  'scope',
  'source',
  'observed',
  'decay',
  'contentHash',
] as const;

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a file into raw frontmatter fields and body. Returns null when no frontmatter. */
export function parseEntryFile(
  text: string,
): { fields: Record<string, unknown>; body: string } | { error: string } {
  const m = FRONTMATTER_RE.exec(text.replace(/^\uFEFF/, ''));
  if (!m) return { error: 'missing YAML frontmatter' };
  let fields: unknown;
  try {
    fields = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return { error: `invalid frontmatter YAML: ${(err as Error).message}` };
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'frontmatter must be a mapping' };
  }
  return { fields: fields as Record<string, unknown>, body: m[2] };
}

/** Validate raw fields against the schema + ontology. Returns the error list. */
export function validateEntryFields(fields: Record<string, unknown>, ontology: Ontology): string[] {
  const errors: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    if (fields[f] === undefined || fields[f] === null || fields[f] === '') {
      errors.push(`missing required field '${f}'`);
    }
  }
  const str = (k: string): string | undefined =>
    typeof fields[k] === 'string' ? (fields[k] as string) : undefined;

  const confidence = fields.confidence;
  if (confidence !== undefined && confidence !== null) {
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
      errors.push(`confidence must be a number between 0 and 1 (got ${String(confidence)})`);
    }
  }

  const enumChecks: [string, readonly string[], string][] = [
    ['trunk', ontology.trunks, 'trunk'],
    ['type', ontology.entryTypes, 'entry type'],
    ['authority', AUTHORITIES, 'authority'],
    ['scope', SCOPES, 'scope'],
    ['decay', DECAYS, 'decay'],
  ];
  for (const [key, allowed, label] of enumChecks) {
    const v = str(key);
    const raw = fields[key];
    if (raw !== undefined && raw !== null && raw !== '' && v === undefined) {
      errors.push(`${label} must be a string (got ${typeof raw})`);
    } else if (v !== undefined && !allowed.includes(v)) {
      errors.push(`unknown ${label} '${v}' (allowed: ${allowed.join(', ')})`);
    }
  }

  const relations = fields.relations;
  if (relations !== undefined && relations !== null) {
    if (!Array.isArray(relations)) {
      errors.push("'relations' must be a list of {type, target}");
    } else {
      for (const r of relations) {
        const rel = r as Partial<KnowledgeRelation> | null;
        if (!rel || typeof rel.type !== 'string' || typeof rel.target !== 'string') {
          errors.push("each relation must have string 'type' and 'target'");
        } else if (!ontology.relations.includes(rel.type)) {
          errors.push(
            `unknown relation type '${rel.type}' (allowed: ${ontology.relations.join(', ')})`,
          );
        }
      }
    }
  }

  const value = str('value');
  const hash = str('contentHash');
  if (value !== undefined && hash !== undefined && hash !== hashValue(value)) {
    errors.push('contentHash does not match sha256 of value');
  }

  if (fields.writtenBy === 'agent') {
    if (fields.authority !== undefined && fields.authority !== 'inferred') {
      errors.push(`agent-written entry must have authority 'inferred' (got '${fields.authority}')`);
    }
    if (typeof confidence === 'number' && confidence > AGENT_CONFIDENCE_CAP) {
      errors.push(
        `agent-written entry confidence must not exceed ${AGENT_CONFIDENCE_CAP} (got ${confidence})`,
      );
    }
    if (!str('reverify')) {
      errors.push("agent-written entry requires a 'reverify' note");
    }
  }
  return errors;
}

export function toEntry(fields: Record<string, unknown>, body: string): KnowledgeEntry {
  return {
    id: String(fields.id),
    trunk: String(fields.trunk),
    type: String(fields.type),
    value: String(fields.value),
    confidence: Number(fields.confidence),
    authority: String(fields.authority),
    scope: String(fields.scope),
    source: String(fields.source),
    observed: String(fields.observed),
    decay: String(fields.decay),
    relations: Array.isArray(fields.relations) ? (fields.relations as KnowledgeRelation[]) : [],
    supersedes: typeof fields.supersedes === 'string' ? fields.supersedes : undefined,
    contentHash: String(fields.contentHash),
    writtenBy: typeof fields.writtenBy === 'string' ? fields.writtenBy : undefined,
    reverify: typeof fields.reverify === 'string' ? fields.reverify : undefined,
    body,
  };
}
