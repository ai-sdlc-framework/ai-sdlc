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
import { basename, isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { readMemoryFolder, stemOf, type Note } from '../memory-dream/notes.js';
import { now } from '../clock.js';
import { loadKnowledgeConfig } from './config.js';
import { DATA_ROOM_SOURCE_PREFIX } from './data-room.js';
import { hashValue, validateEntryFields } from './entry.js';
import {
  backendSelection,
  openKnowledgeStore,
  storeOntology,
  type KnowledgeBackendSelection,
  type KnowledgeStore,
  type WriteResult,
} from './knowledge-store.js';
import {
  countIngestWrite,
  emptyIngestCounts,
  ingestEntry,
  type IngestWriteCounts,
} from './ingest-write.js';
import { resolveKnowledgePrincipal, systemPrincipalDeps } from './principal.js';
import { slugify } from './ingest-sections.js';
import type { Ontology } from './ontology.js';
import { estimateTokens, type QueryHit } from './retrieval/types.js';

export const MEMORY_TRUNK = 'memory';
export const OPERATOR_SOURCE = 'operator';

export interface MemoryIngestOptions extends KnowledgeBackendSelection {
  projectDir: string;
  memoryDir: string;
  protectedRootAbs: string;
  /** The tracked root: the knowledge log every store write appends to sits next to it. */
  trackedRootAbs: string;
  ontology: Ontology;
  observed: string;
  /** Who ingests; recorded in the local knowledge log (AISDLC-1420). */
  principal: string;
  /** A store already open on this backend and both roots; default opens one. */
  store?: KnowledgeStore;
}

export interface MemoryIngestResult extends IngestWriteCounts {
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

function writeEntry(
  store: KnowledgeStore,
  path: string,
  fields: Record<string, unknown>,
  body: string,
  o: { principal: string; exists: boolean },
): Promise<WriteResult> {
  return ingestEntry(
    store,
    { fields, body: `\n${body}${body ? '\n' : ''}` },
    { scope: 'protected', path, ...o },
  );
}

/** Ingest (or re-ingest) the memory folder into the `memory` trunk of the protected root. */
export async function ingestMemoryTrunk(
  o: MemoryIngestOptions,
  report: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<MemoryIngestResult> {
  const result: MemoryIngestResult = {
    ...emptyIngestCounts(),
    unchanged: 0,
    superseded: 0,
    skipped: 0,
  };
  const store =
    o.store ??
    openKnowledgeStore(
      {
        backend: o.backend,
        backendModule: o.backendModule,
        backendOptions: o.backendOptions,
        trackedRoot: o.trackedRootAbs,
        protectedRoot: o.protectedRootAbs,
      },
      o.projectDir,
    );
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
    const path = join(MEMORY_TRUNK, `${String(fields.id)}.md`);
    const prior = store.get(String(fields.id), { scope: 'protected', path });
    if (
      prior &&
      prior.fields.contentHash === fields.contentHash &&
      prior.fields.status !== 'superseded'
    ) {
      result.unchanged++;
      continue;
    }
    if (prior) {
      fields.supersedes = `${String(fields.id)}@${String(prior.fields.contentHash)}`;
    }
    const r = await writeEntry(store, path, fields, n.body.trim(), {
      principal: o.principal,
      exists: prior !== null,
    });
    countIngestWrite(result, r, report);
  }
  for (const prior of store.list({ scope: 'protected', trunk: MEMORY_TRUNK })) {
    if (live.has(basename(prior.path)) || prior.fields.status === 'superseded') continue;
    // Data-room captures share the memory trunk but are not notes (AISDLC-1425).
    if (String(prior.fields.source ?? '').startsWith(DATA_ROOM_SOURCE_PREFIX)) continue;
    const r = await writeEntry(
      store,
      prior.path,
      { ...prior.fields, status: 'superseded' },
      prior.body.trim(),
      { principal: o.principal, exists: true },
    );
    if (r.status === 'applied') result.superseded++;
    else countIngestWrite(result, r, report);
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
  principal: string = agentPrincipal(projectDir),
): Promise<MemoryIngestResult> {
  const config = loadKnowledgeConfig(projectDir);
  const abs = (p: string): string => (isAbsolute(p) ? p : join(projectDir, p));
  const store = openKnowledgeStore(
    {
      ...backendSelection(config),
      trackedRoot: abs(config.trackedRoot),
      protectedRoot: abs(config.protectedRoot),
    },
    projectDir,
  );
  return ingestMemoryTrunk({
    ...backendSelection(config),
    projectDir,
    memoryDir,
    protectedRootAbs: abs(config.protectedRoot),
    trackedRootAbs: abs(config.trackedRoot),
    ontology: storeOntology(store, abs(config.trackedRoot)).ontology,
    observed,
    principal,
    store,
  });
}

/** The principal of an ingest no person started (a dream swap): the agent of this process. */
function agentPrincipal(projectDir: string): string {
  return resolveKnowledgePrincipal(process.env, systemPrincipalDeps('agent', projectDir));
}

/**
 * Re-ingest hook for the dream's apply and undo, run under the dream lock. Opt-in: it only acts
 * once the memory trunk holds entries, so a project that never ingested memory is untouched.
 * The store answers that question, never a filesystem probe, so a non-files backend (DEC-0427)
 * is re-ingested too; a backend that cannot be opened throws `KnowledgeBackendError`. A
 * rejected write sets exit code 1.
 */
export function reingestAfterSwap(projectDir: string): (liveDir: string) => Promise<void> {
  return async (liveDir) => {
    const config = loadKnowledgeConfig(projectDir);
    const store = openKnowledgeStore(
      {
        ...backendSelection(config),
        protectedRoot: isAbsolute(config.protectedRoot)
          ? config.protectedRoot
          : join(projectDir, config.protectedRoot),
      },
      projectDir,
    );
    if (store.list({ scope: 'protected', trunk: MEMORY_TRUNK }).length === 0) return;
    const r = await ingestMemoryForProject(projectDir, liveDir, now().toISOString().slice(0, 10));
    // The swap already happened; a rejected re-ingest leaves the store behind the folder, so
    // the dream command exits non-zero (each rejection is already on stderr).
    if (r.rejected > 0) process.exitCode = 1;
  };
}
