/**
 * Drop this task's earlier attestation chore commits (AISDLC-999).
 *
 * A retried ship leaves the previous attempt's `chore: sign attestation` and
 * `chore: commit pending transcript leaves` commits in the stack; re-signing on
 * top of them yields an envelope whose subject sha is no longer in history.
 * This routine removes them non-interactively (a scripted sequence editor, so
 * nothing ever waits on a person) and puts the leaf files they carried back in
 * the index so the caller can commit them once, on top of the real work.
 *
 * Identification rule (shared with scripts/squash-attestation-chores.sh and
 * ai-sdlc-plugin/scripts/drop-attestation-chores.sh): a commit is ours when its
 * subject is one of the two chore subjects AND it touches only attestation or
 * transcript-leaf paths. A chore-looking commit touching anything else is never
 * dropped: the routine refuses.
 *
 * @module attestation/drop-chores
 */

import { reviewsLedgerRelativePath } from './reviews-ledger.js';

/** Result of one git call. */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in the task worktree. */
export type GitFn = (args: readonly string[]) => Promise<GitResult>;

const CHORE_SUBJECT_RES: readonly RegExp[] = [
  /^chore(\(.*\))?: (sign|auto-sign) (v5 |review )?attestation/,
  /^chore: commit pending transcript leaves/,
];

/** True when `subject` is one of the chore subjects this routine owns. */
export function isAttestationChoreSubject(subject: string): boolean {
  return CHORE_SUBJECT_RES.some((re) => re.test(subject));
}

/** True when `file` is a path an attestation chore commit may touch. */
export function isAttestationChorePath(file: string, taskId?: string): boolean {
  if (file.startsWith('.ai-sdlc/attestations/')) return true;
  if (file === '.ai-sdlc/transcript-leaves.jsonl') return true;
  if (file.startsWith('.ai-sdlc/transcript-leaves/')) return true;
  return taskId !== undefined && file === reviewsLedgerRelativePath(taskId);
}

export type DropChoresResult =
  | { kind: 'none' }
  | { kind: 'dropped'; dropped: string[]; restored: string[] }
  | { kind: 'refused'; sha: string; paths: string[] }
  | { kind: 'failed'; reason: string };

export interface DropChoresOptions {
  /** Target branch the stack is measured against (`main`). */
  target: string;
  /** Task id; lets the task's own review ledger count as an allowed path. */
  taskId?: string;
}

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/**
 * Drop earlier attestation chore commits from the stack above
 * `merge-base(HEAD, origin/<target>)`. Leaf and ledger files they carried are
 * restored (staged, uncommitted); envelopes are not, because the signer
 * re-creates them against the new HEAD.
 */
export async function dropAttestationChores(
  git: GitFn,
  opts: DropChoresOptions,
): Promise<DropChoresResult> {
  const mb = await git(['merge-base', 'HEAD', `origin/${opts.target}`]);
  const base = mb.status === 0 ? mb.stdout.trim() : '';
  if (base === '') return { kind: 'none' };

  const log = await git(['log', '--reverse', '--format=%H%x09%s', `${base}..HEAD`]);
  if (log.status !== 0) return { kind: 'failed', reason: `git log failed: ${log.stderr.trim()}` };

  const candidates: string[] = [];
  for (const l of lines(log.stdout)) {
    const [sha, ...rest] = l.split('\t');
    if (sha === undefined || sha === '') continue;
    if (isAttestationChoreSubject(rest.join('\t'))) candidates.push(sha);
  }
  if (candidates.length === 0) return { kind: 'none' };

  const restore = new Set<string>();
  for (const sha of candidates) {
    const files = await git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha]);
    if (files.status !== 0) return { kind: 'failed', reason: `diff-tree failed for ${sha}` };
    const paths = lines(files.stdout);
    const other = paths.filter((p) => !isAttestationChorePath(p, opts.taskId));
    if (other.length > 0) return { kind: 'refused', sha, paths: other };
    for (const p of paths) if (!p.startsWith('.ai-sdlc/attestations/')) restore.add(p);
  }

  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0 || status.stdout.trim() !== '') {
    return { kind: 'failed', reason: 'the worktree has uncommitted changes' };
  }

  // Scripted sequence editor: removes the candidates' pick lines from the todo
  // list. Seven hex characters prefix-match any abbreviation git writes.
  const alt = candidates.map((s) => s.slice(0, 7)).join('|');
  const editor = `sh -c 'grep -v -E "^(pick|p) (${alt})" "$1" > "$1.new"; mv "$1.new" "$1"' sh`;
  const rebase = await git([
    '-c',
    `sequence.editor=${editor}`,
    '-c',
    'core.editor=true',
    'rebase',
    '--interactive',
    '--empty=drop',
    base,
  ]);
  if (rebase.status !== 0) {
    await git(['rebase', '--abort']);
    return { kind: 'failed', reason: `dropping the chore commits failed: ${rebase.stderr.trim()}` };
  }

  const restored: string[] = [];
  for (const file of restore) {
    const exists = await git(['cat-file', '-e', `${head}:${file}`]);
    if (exists.status !== 0) continue;
    const co = await git(['checkout', head, '--', file]);
    if (co.status === 0) restored.push(file);
  }
  return { kind: 'dropped', dropped: candidates, restored };
}
