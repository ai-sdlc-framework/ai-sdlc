/**
 * Replay corpus (RFC-0050 B4): which reviewed commits can be replayed, and the
 * label each carries.
 *
 * The corpus stores task ids, roles, commit ids and labels. It never stores a
 * diff, a prompt, a response or a finding: the diff is produced from git at
 * replay time.
 *
 * @module usage/replay-corpus
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReviewLedgerRecord, ReviewLedgerRole } from '../attestation/reviews-ledger.js';
import { commitExists, isCommitId, mergeBaseOf, type Git } from './replay-git.js';

export type ReplayLabel = 'known-defect' | 'clean';

export const REPLAY_ROLES = ['code', 'test', 'security', 'correctness'] as const;
export type ReplayRole = (typeof REPLAY_ROLES)[number];

export interface CorpusItem {
  taskId: string;
  role: ReplayRole;
  commitSha: string;
  mergeBase: string;
  label: ReplayLabel;
  /** Review iteration the commit was reviewed at. */
  iteration: number;
}

export const SKIP_REASONS = [
  'not-resolved',
  'not-first-pass-clean',
  'duplicate',
  'invalid-record',
  'unreachable',
  'empty-diff',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface CorpusFile {
  schemaVersion: 'v1';
  generatedAt: string;
  baseRef: string;
  items: CorpusItem[];
  skipped: Record<SkipReason, number>;
}

export interface LabelledCandidate {
  taskId: string;
  role: ReplayRole;
  commitSha: string;
  label: ReplayLabel;
  iteration: number;
}

export function emptySkipCounts(): Record<SkipReason, number> {
  return Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
}

/** Shape of a task id taken from the ledger or the corpus. */
export const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*$/;

export function isValidTaskId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && TASK_ID_PATTERN.test(v);
}

function isReplayRole(v: unknown): v is ReplayRole {
  return (REPLAY_ROLES as readonly unknown[]).includes(v);
}

function blocking(r: ReviewLedgerRecord): boolean {
  return (r.findings ?? []).some((f) => f.severity === 'critical' || f.severity === 'major');
}

function validRecord(r: ReviewLedgerRecord): boolean {
  return (
    !!r &&
    isValidTaskId(r.taskId) &&
    typeof r.iteration === 'number' &&
    Number.isInteger(r.iteration) &&
    r.iteration >= 1 &&
    isReplayRole(r.role as ReviewLedgerRole) &&
    isCommitId(r.commitSha) &&
    (r.verdict === 'approved' || r.verdict === 'rejected')
  );
}

/**
 * Label every reviewed commit in the ledger records.
 *
 * `known-defect`: that role recorded a critical or major finding at that
 * iteration, and a later iteration of the task was approved (every reviewer
 * approved, with no critical or major finding). `clean`: that role approved at
 * iteration 1 with no critical or major finding. Anything else is skipped and
 * counted.
 */
export function labelRecords(records: readonly ReviewLedgerRecord[]): {
  candidates: LabelledCandidate[];
  skipped: Record<SkipReason, number>;
} {
  const skipped = emptySkipCounts();
  const byTask = new Map<string, ReviewLedgerRecord[]>();
  for (const r of records) {
    if (!validRecord(r)) {
      skipped['invalid-record']++;
      continue;
    }
    const list = byTask.get(r.taskId);
    if (list) list.push(r);
    else byTask.set(r.taskId, [r]);
  }

  const candidates: LabelledCandidate[] = [];
  const seen = new Set<string>();
  for (const taskId of [...byTask.keys()].sort()) {
    const list = byTask.get(taskId) as ReviewLedgerRecord[];
    // Iterations where every reviewer approved and none blocked.
    const approvedIterations = new Set<number>();
    for (const it of new Set(list.map((r) => r.iteration))) {
      const at = list.filter((r) => r.iteration === it);
      if (at.every((r) => r.verdict === 'approved' && !blocking(r))) approvedIterations.add(it);
    }
    const ordered = [...list].sort(
      (a, b) => a.iteration - b.iteration || a.role.localeCompare(b.role),
    );
    for (const r of ordered) {
      const key = `${taskId}\u0000${r.role}\u0000${r.commitSha}`;
      if (seen.has(key)) {
        skipped.duplicate++;
        continue;
      }
      seen.add(key);
      let label: ReplayLabel | undefined;
      if (blocking(r)) {
        const laterApproved = [...approvedIterations].some((it) => it > r.iteration);
        if (laterApproved) label = 'known-defect';
        else {
          skipped['not-resolved']++;
          continue;
        }
      } else if (r.iteration === 1 && r.verdict === 'approved') {
        label = 'clean';
      }
      if (!label) {
        skipped['not-first-pass-clean']++;
        continue;
      }
      candidates.push({
        taskId,
        role: r.role as ReplayRole,
        commitSha: r.commitSha,
        label,
        iteration: r.iteration,
      });
    }
  }
  return { candidates, skipped };
}

export interface BuildCorpusInput {
  records: readonly ReviewLedgerRecord[];
  git: Git;
  repoRoot: string;
  baseRef: string;
  now: Date;
}

/** Build the corpus: label the records, then drop commits git cannot reach. */
export async function buildCorpus(input: BuildCorpusInput): Promise<CorpusFile> {
  const { candidates, skipped } = labelRecords(input.records);
  const items: CorpusItem[] = [];
  for (const c of candidates) {
    if (!(await commitExists(input.git, input.repoRoot, c.commitSha))) {
      skipped.unreachable++;
      continue;
    }
    const base = await mergeBaseOf(input.git, input.repoRoot, c.commitSha, input.baseRef);
    if (!base) {
      skipped.unreachable++;
      continue;
    }
    if (base === c.commitSha) {
      // The commit is already on the base ref, so there is no diff to review.
      skipped['empty-diff']++;
      continue;
    }
    items.push({ ...c, mergeBase: base });
  }
  return {
    schemaVersion: 'v1',
    generatedAt: input.now.toISOString(),
    baseRef: input.baseRef,
    items,
    skipped,
  };
}

/** Write a JSON file atomically, creating the parent directory. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function writeCorpus(path: string, corpus: CorpusFile): void {
  writeJsonAtomic(path, corpus);
}

/** Read and validate a corpus file. Returns an error message when it is unusable. */
export function readCorpus(path: string): CorpusFile | string {
  if (!existsSync(path)) {
    return `No replay corpus at ${path}; run "replay-corpus build" first.`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `The replay corpus at ${path} is not valid JSON.`;
  }
  const c = raw as Partial<CorpusFile> | null;
  if (!c || c.schemaVersion !== 'v1' || !Array.isArray(c.items)) {
    return `The replay corpus at ${path} has an unexpected shape.`;
  }
  const items: CorpusItem[] = [];
  for (const i of c.items as CorpusItem[]) {
    if (
      i &&
      isReplayRole(i.role) &&
      (i.label === 'known-defect' || i.label === 'clean') &&
      isCommitId(i.commitSha) &&
      isCommitId(i.mergeBase) &&
      isValidTaskId(i.taskId)
    ) {
      items.push({
        taskId: i.taskId,
        role: i.role,
        commitSha: i.commitSha,
        mergeBase: i.mergeBase,
        label: i.label,
        iteration: typeof i.iteration === 'number' ? i.iteration : 1,
      });
    }
  }
  return {
    schemaVersion: 'v1',
    generatedAt: String(c.generatedAt ?? ''),
    baseRef: String(c.baseRef ?? ''),
    items,
    skipped: { ...emptySkipCounts(), ...(c.skipped ?? {}) },
  };
}

export function renderCorpusSummary(corpus: CorpusFile, path: string): string {
  const known = corpus.items.filter((i) => i.label === 'known-defect').length;
  const clean = corpus.items.length - known;
  const skipped = SKIP_REASONS.map((r) => `${r}=${corpus.skipped[r]}`).join(' ');
  return (
    `Replay corpus: ${corpus.items.length} item(s) (known-defect ${known}, clean ${clean}).\n` +
    `Skipped: ${skipped}\n` +
    `Wrote ${path}\n`
  );
}
