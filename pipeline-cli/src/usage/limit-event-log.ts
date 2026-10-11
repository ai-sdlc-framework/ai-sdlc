/**
 * Append-only, idempotent log of limit observations (`limit-events.jsonl`),
 * shared by the Claude Code and Codex ingesters.
 *
 * Every event carries a dedup key. The read-check-append runs under the usage
 * directory lock, so concurrent ingesters, a backfill, or a crash between the
 * append and the cursor write never record the same observation twice.
 */

import { appendFileSync, closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const LIMIT_EVENTS_FILE = 'limit-events.jsonl';
const LIMIT_EVENTS_READ_CAP = 8 * 1024 * 1024;

export type UsageLockRunner = <T>(dir: string, fn: () => T) => T;

export class LimitEventLog<T extends object> {
  constructor(
    private readonly dir: string,
    private readonly withLock: UsageLockRunner,
    /** Dedup key of an event. Lines written by other harnesses must key differently or return undefined. */
    private readonly keyOf: (event: T) => string | undefined,
  ) {}

  private load(): Set<string> {
    const known = new Set<string>();
    const path = join(this.dir, LIMIT_EVENTS_FILE);
    try {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(LIMIT_EVENTS_READ_CAP);
        const n = readSync(fd, buf, 0, LIMIT_EVENTS_READ_CAP, 0);
        for (const line of buf.subarray(0, n).toString('utf-8').split('\n')) {
          try {
            const key = this.keyOf(JSON.parse(line) as T);
            if (key !== undefined) known.add(key);
          } catch {
            // skip a corrupt line
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // no file yet
    }
    return known;
  }

  /** Append the events not already recorded; returns how many were new. */
  append(events: T[]): number {
    if (events.length === 0) return 0;
    return this.withLock(this.dir, () => {
      const known = this.load();
      const fresh: T[] = [];
      for (const e of events) {
        const k = this.keyOf(e);
        if (k === undefined || known.has(k)) continue;
        known.add(k);
        fresh.push(e);
      }
      if (fresh.length === 0) return 0;
      appendFileSync(
        join(this.dir, LIMIT_EVENTS_FILE),
        fresh.map((e) => `${JSON.stringify(e)}\n`).join(''),
        { encoding: 'utf-8', mode: 0o600 },
      );
      return fresh.length;
    });
  }
}
