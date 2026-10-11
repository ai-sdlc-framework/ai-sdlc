/**
 * `memory-dream apply` and `undo` (AISDLC-729).
 *
 * Apply swaps the reviewed output folder in for the live folder, keeps the
 * previous versions (at least three), carries over notes that sessions added
 * or changed while the dream ran, and takes a lock so two applies cannot
 * interleave. Undo swaps the newest previous version back in.
 *
 * @module memory-dream/apply
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { now } from '../clock.js';
import { metaPathFor, type RunMeta } from './run.js';
import { INDEX_FILE, formatIndexLine, parseIndex, parseNote, readMemoryFolder } from './notes.js';

export const MIN_KEEP = 3;

export interface ApplyResult {
  liveDir: string;
  previousVersion: string;
  carriedOver: string[];
  pruned: string[];
}

export interface UndoResult {
  liveDir: string;
  restoredFrom: string;
  currentSavedAs: string;
}

export const versionsDirFor = (liveDir: string): string => `${liveDir}.dream-versions`;
const lockPathFor = (liveDir: string): string => `${liveDir}.dream.lock`;

function withLock<T>(liveDir: string, fn: () => T): T {
  const lock = lockPathFor(liveDir);
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `another apply or undo is running (lock ${lock}); remove it only if no such process exists`,
        { cause: e },
      );
    }
    throw e;
  }
  try {
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

function stamp(now: Date): string {
  return `v-${now.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')}`;
}

function listVersions(liveDir: string): string[] {
  const dir = versionsDirFor(liveDir);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith('v-'))
        .sort()
    : [];
}

function prune(liveDir: string, keep: number): string[] {
  const all = listVersions(liveDir);
  const drop = all.slice(0, Math.max(0, all.length - Math.max(keep, MIN_KEEP)));
  for (const v of drop) rmSync(join(versionsDirFor(liveDir), v), { recursive: true, force: true });
  return drop;
}

/** Swaps `incoming` in for `liveDir`, saving the old live folder as a version. */
function swap(liveDir: string, incoming: string, now: Date): string {
  const versions = versionsDirFor(liveDir);
  mkdirSync(versions, { recursive: true });
  let saved = join(versions, stamp(now));
  for (let n = 1; existsSync(saved); n++) {
    saved = join(versions, `${stamp(now)}-${String(n).padStart(2, '0')}`);
  }
  renameSync(liveDir, saved);
  try {
    renameSync(incoming, liveDir);
  } catch (e) {
    renameSync(saved, liveDir);
    throw e;
  }
  return saved;
}

export function applyDream(opts: { outputDir: string; keep?: number; now?: Date }): ApplyResult {
  const at = opts.now ?? now();
  const metaPath = metaPathFor(opts.outputDir);
  if (!existsSync(opts.outputDir) || !existsSync(metaPath)) {
    throw new Error(`not a dream output folder (or already applied): ${opts.outputDir}`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as RunMeta;
  const liveDir = meta.inputDir;
  return withLock(liveDir, () => {
    const live = readMemoryFolder(liveDir);
    const changed = live.notes.filter((n) => meta.snapshot[n.file] !== n.hash);
    const outIndexPath = join(opts.outputDir, INDEX_FILE);
    const outIndexText = existsSync(outIndexPath) ? readFileSync(outIndexPath, 'utf-8') : '';
    const indexed = new Set(parseIndex(outIndexText).map((e) => e.file));
    const liveEntries = new Map(live.index.map((e) => [e.file, e]));
    const extra: string[] = [];
    for (const n of changed) {
      writeFileSync(join(opts.outputDir, n.file), n.raw);
      rmSync(join(opts.outputDir, 'archive', n.file), { force: true });
      if (!indexed.has(n.file)) {
        const e = liveEntries.get(n.file);
        extra.push(
          e ? e.line : formatIndexLine(parseNote(n.file, n.raw).name, n.file, n.description),
        );
      }
    }
    if (extra.length > 0) {
      const base =
        outIndexText === '' || outIndexText.endsWith('\n') ? outIndexText : `${outIndexText}\n`;
      writeFileSync(outIndexPath, `${base}${extra.join('\n')}\n`);
    }
    const saved = swap(liveDir, opts.outputDir, at);
    const pruned = prune(liveDir, opts.keep ?? MIN_KEEP);
    return { liveDir, previousVersion: saved, carriedOver: changed.map((n) => n.file), pruned };
  });
}

export function undoDream(opts: { liveDir: string; now?: Date }): UndoResult {
  const at = opts.now ?? now();
  return withLock(opts.liveDir, () => {
    const versions = listVersions(opts.liveDir);
    const latest = versions[versions.length - 1];
    if (!latest) throw new Error(`no previous version to restore for ${opts.liveDir}`);
    const from = join(versionsDirFor(opts.liveDir), latest);
    const savedAs = swap(opts.liveDir, from, at);
    return { liveDir: opts.liveDir, restoredFrom: from, currentSavedAs: savedAs };
  });
}
