/**
 * Reads the `knowledge.*` keys of `.ai-sdlc/context.yaml` (RFC-0053 Configuration).
 * Missing file or missing keys fall back to the stated defaults.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from '../util/yaml.js';

export const DEFAULT_TRACKED_ROOT = '.ai-sdlc/knowledge';
export const DEFAULT_PROTECTED_ROOT = '.ai-sdlc/knowledge-protected';
export const CONTEXT_CONFIG_PATH = '.ai-sdlc/context.yaml';

export interface KnowledgeConfig {
  trackedRoot: string;
  protectedRoot: string;
  /** Optional raw data-room root (RFC-0053 OQ-7), indexed read-only at scope protected. Unset by default. */
  dataRoomRoot: string | null;
  /** Source-path prefixes that mark client / data-room material. */
  dataRoomRoots: string[];
  /** Client identifiers whose presence in an entry marks it as likely protected. */
  clientIdentifiers: string[];
  /** Promotion proof allowlist (RFC-0053 OQ-3): command id -> argv. Empty = no command proofs. */
  allowlistedCommands: Record<string, string[]>;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

export function loadKnowledgeConfig(projectRoot: string): KnowledgeConfig {
  const config: KnowledgeConfig = {
    trackedRoot: DEFAULT_TRACKED_ROOT,
    protectedRoot: DEFAULT_PROTECTED_ROOT,
    dataRoomRoot: null,
    dataRoomRoots: [],
    clientIdentifiers: [],
    allowlistedCommands: {},
  };
  const file = join(projectRoot, CONTEXT_CONFIG_PATH);
  if (!existsSync(file)) return config;
  const doc = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA });
  const knowledge = (doc as { knowledge?: Record<string, unknown> } | null)?.knowledge;
  if (!knowledge || typeof knowledge !== 'object') return config;
  if (typeof knowledge.trackedRoot === 'string' && knowledge.trackedRoot !== '') {
    config.trackedRoot = knowledge.trackedRoot;
  }
  if (typeof knowledge.protectedRoot === 'string' && knowledge.protectedRoot !== '') {
    config.protectedRoot = knowledge.protectedRoot;
  }
  if (typeof knowledge.dataRoomRoot === 'string' && knowledge.dataRoomRoot !== '') {
    config.dataRoomRoot = knowledge.dataRoomRoot;
  }
  const classification = knowledge.classification as Record<string, unknown> | undefined;
  config.dataRoomRoots = stringList(classification?.dataRoomRoots);
  config.clientIdentifiers = stringList(classification?.clientIdentifiers);
  const cmds = (knowledge.promotion as Record<string, unknown> | undefined)?.commands;
  if (cmds && typeof cmds === 'object' && !Array.isArray(cmds)) {
    for (const [id, argv] of Object.entries(cmds)) {
      const list = stringList(argv);
      if (list.length > 0) config.allowlistedCommands[id] = list;
    }
  }
  return config;
}

export const DEFAULT_RETRIEVAL_ADAPTER = 'sqlite';
export const DEFAULT_RETRIEVAL_INDEX_PATH = '.ai-sdlc/context-index.db';

export interface RetrievalConfig {
  adapter: string;
  indexPath: string;
}

/** Reads `retrieval.adapter` and `retrieval.indexPath` (RFC-0053 Configuration). */
export function loadRetrievalConfig(projectRoot: string): RetrievalConfig {
  const config: RetrievalConfig = {
    adapter: DEFAULT_RETRIEVAL_ADAPTER,
    indexPath: DEFAULT_RETRIEVAL_INDEX_PATH,
  };
  const file = join(projectRoot, CONTEXT_CONFIG_PATH);
  if (!existsSync(file)) return config;
  const doc = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA });
  const retrieval = (doc as { retrieval?: Record<string, unknown> } | null)?.retrieval;
  if (!retrieval || typeof retrieval !== 'object') return config;
  if (typeof retrieval.adapter === 'string' && retrieval.adapter !== '') {
    config.adapter = retrieval.adapter;
  }
  if (typeof retrieval.indexPath === 'string' && retrieval.indexPath !== '') {
    config.indexPath = retrieval.indexPath;
  }
  return config;
}
