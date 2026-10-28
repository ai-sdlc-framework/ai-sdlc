/**
 * Reviewer-set replay (`cli-usage replay --set staged`, RFC-0052 section 6, AISDLC-677).
 *
 * Replays the known-defect and clean corpus through the staged set and compares it, per
 * case, with the gating set's recorded outcome. The corpus label is derived from the
 * gating reviewers' own ledger rows (a known-defect commit was blocked by a gating
 * reviewer, a clean commit was approved on the first pass), so the gating outcome per case
 * is that label. The replay itself reuses `runReplay`, which writes nothing to the reviews
 * ledger, transcript leaves, verdicts or attestations; the only extra output is the
 * results file this module shapes, written outside `.ai-sdlc`.
 *
 * @module usage/replay-set
 */

import type { CorpusItem } from './replay-corpus.js';
import type { ModelScore, ReplayOutcome, ReplayResults } from './replay-run.js';

export const REPLAY_SETS = ['staged'] as const;
export type ReplaySet = (typeof REPLAY_SETS)[number];

export interface SetCase {
  taskId: string;
  commitSha: string;
  label: 'known-defect' | 'clean';
  /** The gating set's outcome, inferred from the label. */
  gating: 'block' | 'approve';
  staged: ReplayOutcome;
  agree: boolean;
}

export interface SetReplayResults {
  schemaVersion: 'v1';
  set: ReplaySet;
  runId: string;
  generatedAt: string;
  candidate: string;
  stoppedBy: ReplayResults['stoppedBy'];
  itemsReplayed: number;
  skippedUnreachable: number;
  staged: ModelScore;
  /** Items only the staged set blocked / only the gating set blocked, among scored cases. */
  stagedOnlyBlocks: number;
  gatingOnlyBlocks: number;
  cases: SetCase[];
}

/** One corpus item per commit (a known-defect label wins), as the code remit that carries the diff. */
export function setReplayItems(items: readonly CorpusItem[]): CorpusItem[] {
  const byCommit = new Map<string, CorpusItem>();
  for (const it of items) {
    const key = `${it.taskId}::${it.commitSha}`;
    const cur = byCommit.get(key);
    if (!cur || (cur.label === 'clean' && it.label === 'known-defect')) {
      byCommit.set(key, { ...it, role: 'code' });
    }
  }
  return [...byCommit.values()];
}

export function toSetResults(set: ReplaySet, r: ReplayResults): SetReplayResults {
  const cases: SetCase[] = r.items.map((i) => {
    const gating = i.label === 'known-defect' ? 'block' : 'approve';
    const staged = i.outcomes[r.candidate] ?? 'error';
    return {
      taskId: i.taskId,
      commitSha: i.commitSha,
      label: i.label,
      gating,
      staged,
      agree: staged === gating,
    };
  });
  const scored = cases.filter((c) => c.staged !== 'error');
  return {
    schemaVersion: 'v1',
    set,
    runId: r.runId,
    generatedAt: r.generatedAt,
    candidate: r.candidate,
    stoppedBy: r.stoppedBy,
    itemsReplayed: r.itemsReplayed,
    skippedUnreachable: r.skippedUnreachable,
    staged: r.scores[0] as ModelScore,
    stagedOnlyBlocks: scored.filter((c) => c.staged === 'block' && c.gating === 'approve').length,
    gatingOnlyBlocks: scored.filter((c) => c.staged === 'approve' && c.gating === 'block').length,
    cases,
  };
}

function pct(rate: number | null, part: number, whole: number): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(0)}% (${part}/${whole})`;
}

export function renderSetResults(r: SetReplayResults): string {
  const s = r.staged;
  const gDefects = r.cases.filter((c) => c.label === 'known-defect' && c.staged !== 'error').length;
  const gClean = r.cases.filter((c) => c.label === 'clean' && c.staged !== 'error').length;
  const lines = [
    `Reviewer-set replay: ${r.set} vs gating set, ${r.itemsReplayed} commit(s) replayed, ` +
      `${r.skippedUnreachable} skipped (commit no longer reachable).`,
    `staged: recall ${pct(s.recall, s.knownDefect.blocked, s.knownDefect.items)}, ` +
      `false-block ${pct(s.falseBlockRate, s.clean.blocked, s.clean.items)}` +
      (s.errors ? `, ${s.errors} error(s) not scored` : ''),
    `gating: recall ${pct(gDefects ? 1 : null, gDefects, gDefects)}, ` +
      `false-block ${pct(gClean ? 0 : null, 0, gClean)} (inferred from the corpus labels)`,
    `Blocked only by staged: ${r.stagedOnlyBlocks}; blocked only by the gating set: ${r.gatingOnlyBlocks}.`,
  ];
  for (const c of r.cases.filter((x) => !x.agree)) {
    lines.push(
      `differs: ${c.taskId} @ ${c.commitSha.slice(0, 8)} (${c.label}) gating ${c.gating}, staged ${c.staged}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
