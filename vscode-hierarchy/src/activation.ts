/**
 * Per-window activation record. Each extension host writes
 * `<repo>/.ai-sdlc/dispatch/vscode-hierarchy-windows/<pid>.json` for every roster it
 * watches, so `ai-sdlc doctor` can tell which build a window activated and which
 * folders it has open (stale-after-reinstall and nested-workspace diagnosis, AISDLC-1118).
 */

import path from 'node:path';

export const WINDOWS_DIR_RELATIVE = path.join('.ai-sdlc', 'dispatch', 'vscode-hierarchy-windows');

export interface ActivationRecord {
  pid: number;
  version: string;
  activatedAt: string;
  folders: string[];
}

/** File slice used for the record. */
export interface RecordFs {
  write(file: string, text: string): void;
  remove(file: string): void;
}

export function recordFileFor(repoRoot: string, pid: number): string {
  return path.join(repoRoot, WINDOWS_DIR_RELATIVE, `${pid}.json`);
}

export function buildRecord(
  pid: number,
  version: string,
  folders: string[],
  at: Date,
): ActivationRecord {
  return { pid, version, activatedAt: at.toISOString(), folders: [...folders] };
}

export function writeRecords(
  repoRoots: string[],
  record: ActivationRecord,
  fs: RecordFs,
): string[] {
  const written: string[] = [];
  for (const root of repoRoots) {
    const file = recordFileFor(root, record.pid);
    try {
      fs.write(file, JSON.stringify(record));
      written.push(file);
    } catch {
      /* a read-only checkout must not break terminal opening */
    }
  }
  return written;
}

export function removeRecords(files: string[], fs: RecordFs): void {
  for (const f of files) {
    try {
      fs.remove(f);
    } catch {
      /* already gone */
    }
  }
}
