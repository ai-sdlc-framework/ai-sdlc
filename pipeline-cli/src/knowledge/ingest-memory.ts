/**
 * Auto-memory trunk ingest adapter (RFC-0053 OQ-6, AISDLC-783).
 *
 * The Claude auto-memory folder keeps its format and stays the harness's write target. Every
 * note is projected into a `memory` trunk entry at `scope: protected` (written under the
 * protected root, never the tracked root). Authority follows the note type: `user` and
 * `feedback` are `specialist` with the operator as source, `project` and `reference` are
 * `inferred`. The note file is the citation. A note that disappears from the folder (for example
 * after a dream swap) has its entry marked superseded, never deleted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { readMemoryFolder, stemOf, type Note } from '../memory-dream/notes.js';
import { dump } from '../util/yaml.js';
import { now } from '../clock.js';
import { loadKnowledgeConfig } from './config.js';
import { loadOntology } from './ontology.js';
import { hashValue, parseEntryFile, validateEntryFields } from './entry.js';
import { slugify } from './ingest-sections.js';
import type { Ontology } from './ontology.js';
import { estimateTokens, type QueryHit } from './retrieval/types.js';

export const MEMORY_TRUNK = 'memory';
export const OPERATOR_SOURCE = 'operator';

export interface MemoryIngestOptions {
  projectDir: string;
  memoryDir: string;
  protectedRootAbs: string;
  ontology: Ontology;
  observed: string;
}

export interface MemoryIngestResult {
  created: number;
  updated: number;
  unchanged: number;
  superseded: number;
  skipped: number;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function memoryAuthority(type: string): 'specialist' | 'inferred' {
  return type === 'user' || type === 'feedback' ? 'specialist' : 'inferred';
}

export function memoryEntryId(file: string): string {
  return `memory-${slugify(stemOf(file))}`;
}

function memoryValue(n: Note): string {
  return oneLine(`${n.name}: ${n.description} ${n.body}`);
}

/** The ledger key parts (id and contentHash) of a memory note. */
export function memoryNoteKey(n: Note): { id: string; contentHash: string; tokens: number } {
  const value = memoryValue(n);
  return {
    id: memoryEntryId(n.file),
    contentHash: hashValue(value),
    tokens: estimateTokens(value),
  };
}

function citation(o: MemoryIngestOptions, file: string): string {
  const abs = join(o.memoryDir, file);
  const rel = relative(o.projectDir, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

function noteFields(n: Note, o: MemoryIngestOptions): Record<string, unknown> {
  const authority = memoryAuthority(n.type);
  const { contentHash } = memoryNoteKey(n);
  const fields: Record<string, unknown> = {
    id: memoryEntryId(n.file),
    trunk: MEMORY_TRUNK,
    type: 'fact',
    value: memoryValue(n),
    confidence: authority === 'specialist' ? 0.8 : 0.6,
    authority,
    scope: 'protected',
    source: citation(o, n.file),
    observed: o.observed,
    decay: n.type === 'project' ? 'seasonal' : 'durable',
    relations: [],
    contentHash,
  };
  if (authority === 'specialist') fields.proof = OPERATOR_SOURCE;
  return fields;
}

function writeEntry(path: string, fields: Record<string, unknown>, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${dump(fields)}---\n\n${body}${body ? '\n' : ''}`);
}

/** Ingest (or re-ingest) the memory folder into the `memory` trunk of the protected root. */
export function ingestMemoryTrunk(o: MemoryIngestOptions): MemoryIngestResult {
  const result: MemoryIngestResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    superseded: 0,
    skipped: 0,
  };
  const dir = join(o.protectedRootAbs, MEMORY_TRUNK);
  const live = new Set<string>();
  for (const n of readMemoryFolder(o.memoryDir).notes) {
    if (n.problems.length > 0) {
      result.skipped++;
      continue;
    }
    const fields = noteFields(n, o);
    const errors = validateEntryFields(fields, o.ontology);
    if (errors.length > 0) throw new Error(`${String(fields.id)}: ${errors.join('; ')}`);
    live.add(`${String(fields.id)}.md`);
    const path = join(dir, `${String(fields.id)}.md`);
    if (existsSync(path)) {
      const prior = parseEntryFile(readFileSync(path, 'utf-8'));
      if (
        'fields' in prior &&
        prior.fields.contentHash === fields.contentHash &&
        prior.fields.status !== 'superseded'
      ) {
        result.unchanged++;
        continue;
      }
      if ('fields' in prior) {
        fields.supersedes = `${String(fields.id)}@${String(prior.fields.contentHash)}`;
      }
      result.updated++;
    } else {
      result.created++;
    }
    writeEntry(path, fields, n.body.trim());
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !live.has(x))) {
      const path = join(dir, f);
      const prior = parseEntryFile(readFileSync(path, 'utf-8'));
      if (!('fields' in prior) || prior.fields.status === 'superseded') continue;
      writeEntry(path, { ...prior.fields, status: 'superseded' }, prior.body.trim());
      result.superseded++;
    }
  }
  return result;
}

/** Hits to record in the session ledger for notes the harness recall path surfaced. */
export function harnessRecallHits(memoryDir: string, files: string[]): QueryHit[] {
  const wanted = new Set(files);
  return readMemoryFolder(memoryDir)
    .notes.filter((n) => wanted.has(n.file) && n.problems.length === 0)
    .map((n) => ({ ...memoryNoteKey(n), score: 1, citations: [n.file] }));
}

/** Resolve the protected root and ontology for a project and ingest `memoryDir`. */
export function ingestMemoryForProject(
  projectDir: string,
  memoryDir: string,
  observed: string,
): MemoryIngestResult {
  const config = loadKnowledgeConfig(projectDir);
  const abs = (p: string): string => (isAbsolute(p) ? p : join(projectDir, p));
  return ingestMemoryTrunk({
    projectDir,
    memoryDir,
    protectedRootAbs: abs(config.protectedRoot),
    ontology: loadOntology(abs(config.trackedRoot)).ontology,
    observed,
  });
}

/**
 * Re-ingest hook for the dream's apply and undo, run under the dream lock. Opt-in: it only acts
 * once the memory trunk exists, so a project that never ingested memory is untouched.
 */
export function reingestAfterSwap(projectDir: string): (liveDir: string) => void {
  return (liveDir) => {
    const config = loadKnowledgeConfig(projectDir);
    const root = isAbsolute(config.protectedRoot)
      ? config.protectedRoot
      : join(projectDir, config.protectedRoot);
    if (!existsSync(join(root, MEMORY_TRUNK))) return;
    ingestMemoryForProject(projectDir, liveDir, now().toISOString().slice(0, 10));
  };
}
