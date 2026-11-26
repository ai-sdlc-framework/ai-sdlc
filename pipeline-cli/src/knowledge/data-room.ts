/**
 * Data room (RFC-0053 OQ-7, AISDLC-787). `knowledge.dataRoomRoot` is a raw, read-only root
 * (possibly a sibling repository). Its documents are indexed at `scope: protected` with
 * authority taken from the document kind; this module only ever READS the root. Facts taken
 * from a document are captured as protected entries in the protected root with a citation.
 * Export and sharing paths drop the protected partition by scope alone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { loadKnowledgeConfig } from './config.js';
import { hashValue, type KnowledgeEntry } from './entry.js';
import { openKnowledgeStore, type KnowledgeBackendSelection } from './knowledge-store.js';

export type DocumentKind = 'signed' | 'plan' | 'deck' | 'document';

export interface DocumentAuthority {
  kind: DocumentKind;
  authority: 'canonical' | 'specialist';
  confidence: number;
}

const DECK_EXT = new Set(['.ppt', '.pptx', '.key']);
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml']);
const MAX_VALUE_CHARS = 2000;

/** `source` prefix of every data-room entry; the memory re-ingest sweep skips these. */
export const DATA_ROOM_SOURCE_PREFIX = 'data-room:';

/** Authority by document kind: signed 0.95 canonical, plans 0.85, decks and other documents 0.7. */
export function classifyDocument(relPath: string): DocumentAuthority {
  const name = basename(relPath).toLowerCase();
  const ext = extname(name);
  if (
    /(^|[^a-z])(signed|executed|countersigned|contract|agreement|nda|msa|sow)([^a-z]|$)/.test(name)
  ) {
    return { kind: 'signed', authority: 'canonical', confidence: 0.95 };
  }
  if (DECK_EXT.has(ext) || /(^|[^a-z])(deck|slides?|pitch)([^a-z]|$)/.test(name)) {
    return { kind: 'deck', authority: 'specialist', confidence: 0.7 };
  }
  if (/(^|[^a-z])(plan|roadmap|budget|proposal|forecast)([^a-z]|$)/.test(name)) {
    return { kind: 'plan', authority: 'specialist', confidence: 0.85 };
  }
  return { kind: 'document', authority: 'specialist', confidence: 0.7 };
}

function listDocuments(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...listDocuments(full));
    else if (d.isFile() && TEXT_EXT.has(extname(d.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

/** Index-time view of the data room: read-only, in memory, always `scope: protected`. */
export function readDataRoomEntries(rootAbs: string, observed = '1970-01-01'): KnowledgeEntry[] {
  return listDocuments(rootAbs).map((file) => {
    const rel = relative(rootAbs, file).split('\\').join('/');
    const text = readFileSync(file, 'utf-8');
    const value = text.replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE_CHARS) || rel;
    const a = classifyDocument(rel);
    return {
      id: `dr-${hashValue(rel).slice(0, 16)}`,
      trunk: 'memory',
      type: 'fact',
      value,
      confidence: a.confidence,
      authority: a.authority,
      scope: 'protected',
      source: `${DATA_ROOM_SOURCE_PREFIX}${rel}`,
      observed:
        observed === '1970-01-01' ? statSync(file).mtime.toISOString().slice(0, 10) : observed,
      decay: 'durable',
      relations: [],
      contentHash: hashValue(value),
      body: '',
    };
  });
}

export interface CaptureInput {
  id: string;
  value: string;
  trunk?: string;
  type?: string;
  /** Path of the source document, relative to the data-room root. */
  sourceDoc: string;
  observed: string;
}

/**
 * Capture a fact from a document as a protected entry in the protected root, citing the
 * document. Agent-written, so authority is capped at inferred (RFC-0053 OQ-3). Writes only
 * under the protected root, never the data room. The entry lands at the store default
 * `<trunk>/<id>.md`, the layout `validateKnowledge` requires (AISDLC-1425).
 */
export function captureFact(
  sel: KnowledgeBackendSelection,
  protectedRootAbs: string,
  input: CaptureInput,
): string {
  const fields = {
    id: input.id,
    trunk: input.trunk ?? 'memory',
    type: input.type ?? 'fact',
    value: input.value,
    confidence: 0.7,
    authority: 'inferred',
    scope: 'protected',
    source: `${DATA_ROOM_SOURCE_PREFIX}${input.sourceDoc}`,
    observed: input.observed,
    decay: 'durable',
    relations: [],
    contentHash: hashValue(input.value),
    writtenBy: 'agent',
    reverify: `Re-check against ${input.sourceDoc} in the data room`,
  };
  const { path } = openKnowledgeStore({ ...sel, protectedRoot: protectedRootAbs }).put(
    { fields, body: `Source: ${input.sourceDoc}\n` },
    { scope: 'protected' },
  );
  return join(protectedRootAbs, path);
}

/** `cli-context capture`: resolve the project's knowledge config and capture into its protected root. */
export function captureFactForProject(projectDir: string, input: CaptureInput): string {
  const config = loadKnowledgeConfig(projectDir);
  const protectedAbs = isAbsolute(config.protectedRoot)
    ? config.protectedRoot
    : join(projectDir, config.protectedRoot);
  return captureFact(config, protectedAbs, input);
}

/** Export and sharing paths: the protected partition is excluded by scope alone. */
export function exportableEntries<T extends { scope: string }>(entries: T[]): T[] {
  return entries.filter((e) => e.scope.trim().toLowerCase() !== 'protected');
}
