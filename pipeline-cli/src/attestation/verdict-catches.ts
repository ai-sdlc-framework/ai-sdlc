/**
 * RFC-0061 OQ-4b: the derived catch report. Compiled from GitHub status history on demand; no
 * ledger file is written.
 *
 * @module attestation/verdict-catches
 */

export const VERDICT_CONTEXT = 'ai-sdlc/review-verdict';
export const V6_CONTEXT = 'ai-sdlc/attestation';
export const PR_READY_CONTEXT = 'ai-sdlc/pr-ready';

export interface StatusEntry {
  context: string;
  state: string;
  description?: string | null;
}

export interface HeadHistory {
  headSha: string;
  pullRequest: number;
  /** Statuses newest first (the GitHub order). */
  statuses: StatusEntry[];
  /** Conclusion of the `ai-sdlc/pr-ready` check run, when one exists. */
  prReadyCheckConclusion?: string | null;
}

export interface CatchRow {
  kind: 'catch' | 'disagreement';
  headSha: string;
  pullRequest: number;
  reason: string;
}

const latest = (h: HeadHistory, context: string): StatusEntry | undefined =>
  h.statuses.find((s) => s.context === context);

/** The reason code is the first token of the status description. */
export function reasonCode(description: string | null | undefined): string {
  return (description ?? '').trim().split(/\s+/)[0]?.replace(/:$/, '') || 'unknown';
}

export function compileCatches(heads: readonly HeadHistory[]): CatchRow[] {
  const rows: CatchRow[] = [];
  for (const h of heads) {
    const verdict = latest(h, VERDICT_CONTEXT);
    if (!verdict) continue;
    const code = reasonCode(verdict.description);
    // The shadow posts `success` for every outcome (AISDLC-1192); the reason code carries the
    // verdict. Legacy `failure`/`error` states from before that change still count as failed.
    const legacyFailed = verdict.state === 'failure' || verdict.state === 'error';
    const posted = verdict.state === 'success';
    const codeOk = code === 'ok' || code.startsWith('ok-carried');
    const verdictOk = posted && codeOk;
    const verdictFailed = legacyFailed || (posted && !codeOk);
    const prReady =
      latest(h, PR_READY_CONTEXT)?.state === 'success' || h.prReadyCheckConclusion === 'success';
    const reason = code;
    if (verdictFailed && prReady) {
      rows.push({ kind: 'catch', headSha: h.headSha, pullRequest: h.pullRequest, reason });
    }
    const v6 = latest(h, V6_CONTEXT);
    if (v6 && (v6.state === 'success' || v6.state === 'failure' || v6.state === 'error')) {
      if ((v6.state === 'success') !== verdictOk && (verdictOk || verdictFailed)) {
        rows.push({
          kind: 'disagreement',
          headSha: h.headSha,
          pullRequest: h.pullRequest,
          reason: `verdict ${verdictOk ? 'pass' : 'fail'} (${reason}), v6 ${v6.state}`,
        });
      }
    }
  }
  return rows;
}

export function formatCatches(rows: readonly CatchRow[]): string {
  if (rows.length === 0) return 'no catches or disagreements\n';
  return (
    rows.map((r) => `${r.kind}\tPR #${r.pullRequest}\t${r.headSha}\t${r.reason}`).join('\n') + '\n'
  );
}

export type GhJson = (path: string) => Promise<unknown>;

/** Collect status history for every PR head updated since `since` (ISO date). */
export async function collectHistory(
  repository: string,
  since: string | undefined,
  ghJson: GhJson,
): Promise<HeadHistory[]> {
  const cutoff = since ? Date.parse(since) : 0;
  const prs = (await ghJson(
    `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
  )) as Array<{ number: number; updated_at: string; head: { sha: string } }>;
  const out: HeadHistory[] = [];
  for (const pr of prs) {
    if (Date.parse(pr.updated_at) < cutoff) continue;
    const statuses = (await ghJson(
      `repos/${repository}/commits/${pr.head.sha}/statuses?per_page=100`,
    )) as StatusEntry[];
    const runs = (await ghJson(
      `repos/${repository}/commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(PR_READY_CONTEXT)}`,
    )) as { check_runs?: Array<{ conclusion: string | null }> };
    out.push({
      headSha: pr.head.sha,
      pullRequest: pr.number,
      statuses,
      prReadyCheckConclusion: runs.check_runs?.[0]?.conclusion ?? null,
    });
  }
  return out;
}
