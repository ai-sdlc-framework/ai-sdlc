/**
 * `cli-context sync` and `cli-context status` (AISDLC-1459, DEC-0444 option a).
 *
 * A backend that implements the optional `KnowledgeStore.sync()` refreshes the replica that
 * `list()` reads; this module then rebuilds the retrieval index (the DEC-0430 sync contract)
 * and records the outcome in a stamp file the session-start hook reads (AISDLC-1460). A
 * backend without `sync()`/`status()` (the files backend) reports `supported: false`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now } from '../clock.js';
import { loadKnowledgeConfig } from './config.js';
import { openKnowledgeStore, type KnowledgeStore } from './knowledge-store.js';
import { rebuildIndex } from './retrieval/service.js';

/** Project-relative stamp file; `.ai-sdlc/state/` is in the runtime gitignore list. */
export const SYNC_STAMP_PATH = '.ai-sdlc/state/knowledge-sync.json';

/** The outcome of the last `cli-context sync` run. */
export interface SyncStamp {
  /** ISO time the run finished. */
  at: string;
  ok: boolean;
  pulled?: number;
  pushed?: number;
  /** Entries in the rebuilt index. */
  indexed?: number;
  error?: string;
}

export type SyncResult = { ok: true; supported: false } | ({ supported: true } & SyncStamp);

export type StatusResult =
  | { ok: true; supported: false }
  | {
      ok: true;
      supported: true;
      queued: number;
      rejected: number;
      lastSyncAt?: string;
      lastError?: string;
      /** The stamp of the last `cli-context sync` run, or null when none ran. */
      lastSync: SyncStamp | null;
    };

export interface SyncDeps {
  store?: KnowledgeStore;
  rebuild?: (projectRoot: string) => Promise<number>;
}

function openStore(projectRoot: string, deps: SyncDeps): KnowledgeStore {
  return deps.store ?? openKnowledgeStore(loadKnowledgeConfig(projectRoot), projectRoot);
}

export function readSyncStamp(projectRoot: string): SyncStamp | null {
  const file = join(projectRoot, SYNC_STAMP_PATH);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SyncStamp;
  } catch {
    return null;
  }
}

function writeSyncStamp(projectRoot: string, stamp: SyncStamp): void {
  const file = join(projectRoot, SYNC_STAMP_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stamp)}\n`);
}

/**
 * Run the backend sync, then rebuild the index, and record the outcome in the stamp file.
 * A sync or rebuild error is recorded (`ok: false`) and returned, never thrown.
 */
export async function runKnowledgeSync(
  projectRoot: string,
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const store = openStore(projectRoot, deps);
  if (typeof store.sync !== 'function') return { ok: true, supported: false };
  let stamp: Omit<SyncStamp, 'at'>;
  try {
    const { pulled, pushed } = await store.sync();
    const indexed = await (deps.rebuild ?? rebuildIndex)(projectRoot);
    stamp = { ok: true, pulled, pushed, indexed };
  } catch (err) {
    stamp = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const full: SyncStamp = { at: now().toISOString(), ...stamp };
  writeSyncStamp(projectRoot, full);
  return { supported: true, ...full };
}

/**
 * The backend `status()` merged with the stamp file: the stamp's time and error, when a
 * `cli-context sync` ran, take precedence over the backend's own `lastSyncAt`/`lastError`.
 */
export async function knowledgeSyncStatus(
  projectRoot: string,
  deps: SyncDeps = {},
): Promise<StatusResult> {
  const store = openStore(projectRoot, deps);
  if (typeof store.status !== 'function') return { ok: true, supported: false };
  const s = await store.status();
  const stamp = readSyncStamp(projectRoot);
  const lastSyncAt = stamp?.at ?? s.lastSyncAt;
  const lastError = stamp ? stamp.error : s.lastError;
  return {
    ok: true,
    supported: true,
    queued: s.queued,
    rejected: s.rejected,
    ...(lastSyncAt !== undefined && { lastSyncAt }),
    ...(lastError !== undefined && { lastError }),
    lastSync: stamp,
  };
}
