/**
 * One PR snapshot per dispatch wake (AISDLC-959).
 *
 * `createSnapshotRunner` wraps the `gh` command runner. The four consumers
 * (human-attention, mark-ready, land-eligible, reconcile) each ask for `gh pr list
 * --state open`; the wrapper answers all of them from one list call that asks for the
 * union of their fields, and answers `gh pr view <n> --json statusCheckRollup` from the
 * same snapshot. The snapshot is stored under the board. While the webhook receiver is
 * up (its `events/` directory exists), a later wake reuses it when no event record is
 * newer than the snapshot and it is under `SNAPSHOT_MAX_AGE_MS` old; otherwise it is
 * refreshed. A lost delivery therefore costs latency, never correctness.
 *
 * A per-PR fingerprint (head sha, newest event id, check rollup digest) lets land-eligible
 * skip a PR it refused last time until the fingerprint changes or the refusal is old.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { now as clock } from '../clock.js';
import type { CommandResult, CommandRunner } from './types.js';

/** A snapshot, and a recorded refusal, older than this is read again. */
export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

/** Every field any consumer of the list reads. */
export const SNAPSHOT_FIELDS = [
  'number',
  'title',
  'body',
  'headRefName',
  'headRefOid',
  'createdAt',
  'isDraft',
  'mergeStateStatus',
  'autoMergeRequest',
  'files',
  'isCrossRepository',
  'author',
  'statusCheckRollup',
] as const;

interface Snapshot {
  fetchedAt: string;
  prs: Record<string, unknown>[];
}

const snapshotPath = (boardDir: string): string => path.join(boardDir, 'pr-snapshot.json');
const fingerprintPath = (boardDir: string): string => path.join(boardDir, 'pr-fingerprints.json');
const eventsDir = (boardDir: string): string => path.join(boardDir, 'events');

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', 'utf-8');
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/** Event record names: `<repo>#<pr>@<sha>:<kind>:<delivery>.json`, URI encoded. */
function eventEntries(boardDir: string): { pr: number | null; id: string; mtimeMs: number }[] {
  const dir = eventsDir(boardDir);
  if (!existsSync(dir)) return [];
  const out: { pr: number | null; id: string; mtimeMs: number }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let key: string;
    try {
      key = decodeURIComponent(f.slice(0, -'.json'.length));
    } catch {
      continue;
    }
    const m = /#(\d+|none)@/.exec(key);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path.join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    out.push({ pr: m && m[1] !== 'none' ? Number(m[1]) : null, id: key, mtimeMs });
  }
  return out;
}

/** The newest event id recorded for a PR; empty when none. */
export function latestEventId(boardDir: string, pr: number): string {
  const mine = eventEntries(boardDir).filter((e) => e.pr === pr);
  mine.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
  return mine.length > 0 ? mine[mine.length - 1]!.id : '';
}

/** True when the receiver has run and no event record is newer than `sinceMs`. */
function quietSince(boardDir: string, sinceMs: number): boolean {
  if (!existsSync(eventsDir(boardDir))) return false;
  return eventEntries(boardDir).every((e) => e.mtimeMs <= sinceMs);
}

/** Head sha, newest event id and a digest of the check rollup. */
export function prFingerprint(
  boardDir: string,
  p: { number: number; headRefOid?: string; statusCheckRollup?: unknown },
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(p.statusCheckRollup ?? null))
    .digest('hex')
    .slice(0, 16);
  return `${p.headRefOid ?? ''}|${latestEventId(boardDir, p.number)}|${digest}`;
}

interface Refusal {
  fingerprint: string;
  at: string;
}

/** True when `pr` was refused with this same fingerprint less than 15 minutes ago. */
export function refusalStillValid(
  boardDir: string,
  pr: number,
  fingerprint: string,
  now: Date = clock(),
): boolean {
  const r = readJson<Record<string, Refusal>>(fingerprintPath(boardDir))?.[String(pr)];
  if (!r || r.fingerprint !== fingerprint) return false;
  return now.getTime() - Date.parse(r.at) < SNAPSHOT_MAX_AGE_MS;
}

/** Remember a refusal (`fingerprint` set) or forget it (`undefined`). */
export function recordRefusal(
  boardDir: string,
  pr: number,
  fingerprint: string | undefined,
  now: Date = clock(),
): void {
  const all = readJson<Record<string, Refusal>>(fingerprintPath(boardDir)) ?? {};
  if (fingerprint === undefined) {
    if (!(String(pr) in all)) return;
    delete all[String(pr)];
  } else {
    all[String(pr)] = { fingerprint, at: now.toISOString() };
  }
  writeJson(fingerprintPath(boardDir), all);
}

function listArgs(args: readonly string[]): { draftOnly: boolean; fields: string[] } | undefined {
  if (args[0] !== 'pr' || args[1] !== 'list') return undefined;
  const state = args[args.indexOf('--state') + 1];
  if (args.indexOf('--state') < 0 || state !== 'open') return undefined;
  const j = args.indexOf('--json');
  if (j < 0 || args.includes('--search') || args.includes('--head') || args.includes('--author')) {
    return undefined;
  }
  return { draftOnly: args.includes('--draft'), fields: (args[j + 1] ?? '').split(',') };
}

/**
 * Wrap `run` so every open-PR list in one wake shares one snapshot. A command that
 * changes a PR (`gh pr ready`, `gh pr merge`, ...) drops the stored snapshot.
 */
export function createSnapshotRunner(
  run: CommandRunner,
  opts: { boardDir: string; now?: () => Date },
): CommandRunner {
  const now = opts.now ?? clock;
  let memo: Snapshot | undefined;
  let failure: CommandResult | undefined;

  const load = (cwd: string | undefined): Snapshot | undefined => {
    if (memo) return memo;
    if (failure) return undefined;
    const stored = readJson<Snapshot>(snapshotPath(opts.boardDir));
    const fetched = stored ? Date.parse(stored.fetchedAt) : NaN;
    if (
      stored &&
      Array.isArray(stored.prs) &&
      Number.isFinite(fetched) &&
      now().getTime() - fetched < SNAPSHOT_MAX_AGE_MS &&
      quietSince(opts.boardDir, fetched)
    ) {
      memo = stored;
      return memo;
    }
    const r = run(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', '100', '--json', SNAPSHOT_FIELDS.join(',')],
      cwd === undefined ? {} : { cwd },
    );
    let prs: unknown;
    try {
      prs = r.status === 0 ? JSON.parse(r.stdout) : undefined;
    } catch {
      prs = undefined;
    }
    if (!Array.isArray(prs)) {
      failure = r.status === 0 ? { status: 1, stdout: '', stderr: 'unreadable output' } : r;
      return undefined;
    }
    memo = { fetchedAt: now().toISOString(), prs: prs as Record<string, unknown>[] };
    writeJson(snapshotPath(opts.boardDir), memo);
    return memo;
  };

  return (file, args, options) => {
    if (file !== 'gh') return run(file, args, options);
    const list = listArgs(args);
    if (list) {
      const snap = load(options?.cwd);
      if (!snap) return failure ?? { status: 1, stdout: '', stderr: 'no snapshot' };
      const rows = snap.prs
        .filter((p) => !list.draftOnly || p['isDraft'] === true)
        .map((p) => Object.fromEntries(list.fields.map((f) => [f, p[f]])));
      return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (
      args[0] === 'pr' &&
      args[1] === 'view' &&
      args[3] === '--json' &&
      args[4] === 'statusCheckRollup'
    ) {
      const snap = memo ?? load(options?.cwd);
      const hit = snap?.prs.find((p) => String(p['number']) === args[2]);
      if (hit && hit['statusCheckRollup'] !== undefined) {
        return {
          status: 0,
          stdout: JSON.stringify({ statusCheckRollup: hit['statusCheckRollup'] }),
          stderr: '',
        };
      }
    } else if (args[0] === 'pr' && args[1] !== 'view' && args[1] !== 'checks') {
      // The PR is about to change: the stored snapshot no longer describes it.
      memo = undefined;
      try {
        unlinkSync(snapshotPath(opts.boardDir));
      } catch {
        /* none stored */
      }
    }
    return run(file, args, options);
  };
}
