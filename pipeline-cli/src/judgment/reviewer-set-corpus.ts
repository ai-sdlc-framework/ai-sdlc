/**
 * Converts the append-only reviews ledger into a labelled corpus for
 * `cli-judgment eval review.reviewer-set`.
 *
 * One corpus line per PR (task). The label is deliberately conservative: a PR
 * disagrees with a merged-set selection when the code reviewer, the test reviewer
 * (or the merged correctness reviewer, which covers both remits) recorded a critical
 * or major finding on the FIRST pass. First-pass findings are the signal: by merge
 * time every reviewer has flipped to approved, so later iterations say nothing.
 *
 * The ledger stores no diff, so the judgment input for each PR is resolved by a
 * caller-supplied function (the CLI uses `git diff` against the recorded commit).
 */

import { execFileSync } from 'node:child_process';
import type { ReviewerSetInput, ReviewerSetLabel } from '@ai-sdlc/reference';
import type { ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import { parseUnifiedDiff } from '../classifier/classifier.js';
import type { CorpusItem } from './eval.js';

const CODE_OR_TEST_ROLES: ReadonlySet<string> = new Set(['code', 'test', 'correctness']);
const BLOCKING: ReadonlySet<string> = new Set(['critical', 'major']);

export interface ReviewedPr {
  taskId: string;
  prNumber: number | null;
  /** Commit the first-pass review ran against. */
  commitSha: string;
}

export interface ReviewerSetLabelDetail extends ReviewerSetLabel {
  taskId: string;
  prNumber: number | null;
}

export interface LedgerCorpusResult {
  items: CorpusItem[];
  /** Tasks left out, with the reason. */
  skipped: { taskId: string; reason: string }[];
}

const isFirstPassCodeOrTest = (r: ReviewLedgerRecord): boolean =>
  r.iteration === 1 && CODE_OR_TEST_ROLES.has(r.role);

/** True when a first-pass code, test or correctness record blocked: not approved, or critical/major. */
export function hasFirstPassBlockingFinding(records: readonly ReviewLedgerRecord[]): boolean {
  return records.some(
    (r) =>
      isFirstPassCodeOrTest(r) &&
      (r.verdict !== 'approved' ||
        (Array.isArray(r.findings) && r.findings.some((f) => BLOCKING.has(f.severity)))),
  );
}

/** True when a first-pass code/test record has no readable findings list: it is never labelled. */
function hasMalformedFirstPass(records: readonly ReviewLedgerRecord[]): boolean {
  return records.some((r) => isFirstPassCodeOrTest(r) && !Array.isArray(r.findings));
}

/** Build the judgment input from a unified diff. */
export function reviewerSetInputFromDiff(diff: string): ReviewerSetInput {
  return { changedFiles: parseUnifiedDiff(diff).paths, diff };
}

/**
 * Convert ledger records to corpus items. `resolveInput` supplies the diff-derived input
 * for a PR; returning `undefined` skips the PR.
 */
export function ledgerToReviewerSetCorpus(
  records: readonly ReviewLedgerRecord[],
  resolveInput: (pr: ReviewedPr) => ReviewerSetInput | undefined,
): LedgerCorpusResult {
  const byTask = new Map<string, ReviewLedgerRecord[]>();
  for (const r of records) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }
  const items: CorpusItem[] = [];
  const skipped: LedgerCorpusResult['skipped'] = [];
  for (const [taskId, group] of byTask) {
    const first = group.filter(isFirstPassCodeOrTest);
    if (first.length === 0) {
      skipped.push({ taskId, reason: 'no first-pass code or test review recorded' });
      continue;
    }
    const anchor = first[0];
    const input = resolveInput({
      taskId,
      prNumber: anchor.prNumber ?? null,
      commitSha: anchor.commitSha,
    });
    if (!input) {
      skipped.push({ taskId, reason: 'diff unavailable' });
      continue;
    }
    const blocking = hasFirstPassBlockingFinding(group);
    if (!blocking && hasMalformedFirstPass(group)) {
      // An approved record with no readable findings cannot show the PR was clean.
      skipped.push({ taskId, reason: 'first-pass record has no readable findings' });
      continue;
    }
    const label: ReviewerSetLabelDetail = {
      separateReviewBlocking: blocking,
      taskId,
      prNumber: anchor.prNumber ?? null,
    };
    items.push({ input, label });
  }
  return { items, skipped };
}

/** Serialise corpus items as the JSONL `cli-judgment eval --corpus` reads. */
export function corpusToJsonl(items: readonly CorpusItem[]): string {
  return items.map((i) => JSON.stringify({ input: i.input, label: i.label })).join('\n') + '\n';
}

/** A ref that cannot be read as an option: non-empty and not starting with `-`. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-');
}

/** Default resolver: `git diff <base>...<commit>` in the repo; undefined on any failure. */
export function gitDiffInputResolver(
  repoRoot: string,
  baseRef = 'origin/main',
): (pr: ReviewedPr) => ReviewerSetInput | undefined {
  return (pr) => {
    if (!/^[0-9a-f]{7,40}$/i.test(pr.commitSha) || !isSafeRef(baseRef)) return undefined;
    try {
      const diff = execFileSync(
        'git',
        ['diff', '--end-of-options', `${baseRef}...${pr.commitSha}`],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      return diff.trim() === '' ? undefined : reviewerSetInputFromDiff(diff);
    } catch {
      return undefined;
    }
  };
}
