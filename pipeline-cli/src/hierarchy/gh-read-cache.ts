import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { eventEntries } from './pr-snapshot.js';
import type { CommandResult, CommandRunner } from './types.js';

/**
 * AISDLC-1380: cache of `gh` reads whose answer cannot change between dispatch passes (the
 * login, a run id's jobs, a job id's annotations) or only changes with its key (a sha). The
 * in-memory layer is scoped to one runner so two runners in one process never share an answer.
 *
 * AISDLC-1440: once {@link useGhReadCacheDir} names the board, answers are also stored on disk
 * under `<board>/gh-cache/`, so the reconcile child, the dispatch tick and `cli-hierarchy status`
 * (separate processes) share them. A failed read is stored too, for at most
 * {@link GH_NEGATIVE_TTL_MS}, so an expected 404 or a flaky read is not retried every tick.
 * A read made with `{ events: true }` is also stale once a webhook event record is newer than it.
 */
const caches = new WeakMap<CommandRunner, Map<string, Entry>>();

interface Entry {
  at: number;
  value: CommandResult;
}

interface DiskStore {
  dir: string;
  boardDir: string;
}

let disk: DiskStore | undefined;

/** Share cached reads across processes through `<boardDir>/gh-cache/`; `undefined` turns it off. */
export function useGhReadCacheDir(boardDir: string | undefined): void {
  disk = boardDir ? { dir: path.join(boardDir, 'gh-cache'), boardDir } : undefined;
}

/** How long a failed read (404, expected failure, flaky network) is reused. */
export const GH_NEGATIVE_TTL_MS = 2 * 60_000;

/** How long a mutable-but-slow read (main's sha, the newest docs-bump run, repo settings) is reused. */
export const GH_READ_TTL_MS = 5 * 60_000;

export interface CachedGhOptions {
  cwd?: string;
  /** Stale once a webhook event record is newer than the stored answer (AISDLC-1440). */
  events?: boolean;
}

function diskFile(store: DiskStore, key: string, args: readonly string[]): string {
  const h = createHash('sha256').update(key).update('\0').update(args.join('\0')).digest('hex');
  return path.join(store.dir, `${h.slice(0, 32)}.json`);
}

function readDisk(file: string): Entry | undefined {
  try {
    const e = JSON.parse(readFileSync(file, 'utf-8')) as Entry;
    return typeof e.at === 'number' && typeof e.value?.status === 'number' ? e : undefined;
  } catch {
    return undefined;
  }
}

function writeDisk(file: string, e: Entry): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(e));
    renameSync(tmp, file);
  } catch {
    /* a cache that cannot be written only costs a call */
  }
}

/** Newest webhook event record time, or undefined when the receiver has not run. */
function newestEventMs(boardDir: string): number | undefined {
  try {
    let newest = 0;
    for (const e of eventEntries(boardDir)) newest = Math.max(newest, e.mtimeMs);
    return newest;
  } catch {
    return undefined;
  }
}

/**
 * Run `gh <args>` through `run`, reusing an answer for `key` for `ttlMs` (default: forever) when
 * it succeeded, or for the shorter of `ttlMs` and {@link GH_NEGATIVE_TTL_MS} when it failed.
 */
export function cachedGh(
  run: CommandRunner,
  key: string,
  args: readonly string[],
  opts: CachedGhOptions,
  ttlMs: number = Infinity,
  now: () => number = Date.now,
): CommandResult {
  let m = caches.get(run);
  if (!m) caches.set(run, (m = new Map()));
  const store = disk;
  const fresh = (e: Entry | undefined): e is Entry => {
    if (!e) return false;
    const ttl = e.value.status === 0 ? ttlMs : Math.min(ttlMs, GH_NEGATIVE_TTL_MS);
    if (now() - e.at >= ttl) return false;
    if (opts.events && store) {
      const newest = newestEventMs(store.boardDir);
      if (newest !== undefined && newest > e.at) return false;
    }
    return true;
  };
  const mem = m.get(key);
  if (fresh(mem)) return mem.value;
  const file = store ? diskFile(store, key, args) : undefined;
  const stored = file ? readDisk(file) : undefined;
  if (fresh(stored)) {
    m.set(key, stored);
    return stored.value;
  }
  const r = run('gh', args, opts.cwd === undefined ? {} : { cwd: opts.cwd });
  const entry = { at: now(), value: r };
  m.set(key, entry);
  if (file) writeDisk(file, entry);
  return r;
}
