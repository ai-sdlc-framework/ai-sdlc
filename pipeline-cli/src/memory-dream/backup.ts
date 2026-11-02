/**
 * Daily backup of the agent memory folder outside the repo (AISDLC-1131).
 *
 * A plain directory copy to `~/.ai-sdlc/memory-backups/<repo-id>/<YYYY-MM-DD>/`,
 * at most one per day, keeping the newest fourteen.
 *
 * @module memory-dream/backup
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { INDEX_FILE } from './notes.js';

export const BACKUP_KEEP = 14;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** Stable per-repo id: folder name plus a short hash of the absolute path. */
export function repoIdFor(projectDir: string): string {
  const abs = resolve(projectDir);
  return `${basename(abs)}-${createHash('sha256').update(abs).digest('hex').slice(0, 8)}`;
}

export function backupRootFor(projectDir: string, home: string = homedir()): string {
  return join(home, '.ai-sdlc', 'memory-backups', repoIdFor(projectDir));
}

function listBackups(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root)
        .filter((d) => DATE_DIR.test(d))
        .sort()
    : [];
}

export interface BackupResult {
  status: 'copied' | 'already-today' | 'no-memory';
  dir?: string;
  pruned: string[];
}

export function backupMemory(opts: {
  memoryDir: string;
  projectDir: string;
  home?: string;
  now: Date;
  keep?: number;
}): BackupResult {
  if (!existsSync(opts.memoryDir) || readdirSync(opts.memoryDir).length === 0) {
    return { status: 'no-memory', pruned: [] };
  }
  const root = backupRootFor(opts.projectDir, opts.home);
  const dir = join(root, opts.now.toISOString().slice(0, 10));
  if (existsSync(dir)) return { status: 'already-today', dir, pruned: [] };
  cpSync(opts.memoryDir, dir, { recursive: true });
  const all = listBackups(root);
  const drop = all.slice(0, Math.max(0, all.length - (opts.keep ?? BACKUP_KEEP)));
  for (const d of drop) rmSync(join(root, d), { recursive: true, force: true });
  return { status: 'copied', dir, pruned: drop };
}

/** One-line warning when MEMORY.md is missing but a backup exists; else null. */
export function memoryBackupHint(opts: {
  memoryDir: string;
  projectDir: string;
  home?: string;
}): string | null {
  if (existsSync(join(opts.memoryDir, INDEX_FILE))) return null;
  const root = backupRootFor(opts.projectDir, opts.home);
  const newest = listBackups(root).pop();
  if (!newest) return null;
  return `warning: ${join(opts.memoryDir, INDEX_FILE)} is missing but a memory backup exists at ${join(root, newest)}; restore it with cp -R, or rebuild with: cli-memory-dream recover --from-transcripts <projects-dir>`;
}
