/**
 * review-finalize — Steps 7b.5, 7c and 8, all deterministic.
 *
 * The model reports what each reviewer returned; this module then
 *
 *   - persists each reviewer's harness transcript + verdict under
 *     `.ai-sdlc/` through the sanctioned helper script (AISDLC-599: the
 *     coordinator persists, reviewers cannot write under `.ai-sdlc/**`),
 *   - emits one transcript leaf per reviewer that really ran (RFC-0042,
 *     AISDLC-573 nonce binding, AISDLC-616 ledger iteration), and
 *   - aggregates the verdicts into the gate decision.
 *
 * @module next-step/review-finalize
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { aggregateVerdicts } from '../steps/08-aggregate-verdicts.js';
import type { AggregatedVerdict, ReviewerFinding, ReviewerVerdict, Severity } from '../types.js';
import { writeRunFile } from './init.js';
import type { NextStepContext, NextStepState } from './types.js';

/** What the model reports for one reviewer. */
export interface ReviewerReport {
  /** Agent that ran (`code-reviewer-codex`, ...). The role name is accepted too. */
  agent: string;
  /** Harness agent id returned by the Agent tool for THIS reviewer. */
  agentId?: string;
  approved: boolean;
  findings?: ReviewerFinding[];
  summary?: string;
}

const SEVERITIES: readonly Severity[] = ['critical', 'major', 'minor', 'suggestion'];

function asReport(raw: unknown, fallbackAgent?: string): ReviewerReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const agent = typeof r.agent === 'string' ? r.agent : fallbackAgent;
  if (!agent) return null;
  const nested =
    r.verdict && typeof r.verdict === 'object' ? (r.verdict as Record<string, unknown>) : r;
  const findings = Array.isArray(nested.findings)
    ? (nested.findings as unknown[]).flatMap((f) => {
        if (!f || typeof f !== 'object') return [];
        const o = f as Record<string, unknown>;
        const severity = SEVERITIES.includes(o.severity as Severity)
          ? (o.severity as Severity)
          : 'suggestion';
        return [
          {
            severity,
            message: typeof o.message === 'string' ? o.message : String(o.message ?? ''),
            ...(typeof o.file === 'string' ? { file: o.file } : {}),
            ...(typeof o.line === 'number' ? { line: o.line } : {}),
          } satisfies ReviewerFinding,
        ];
      })
    : [];
  return {
    agent,
    ...(typeof r.agentId === 'string' && r.agentId !== '' ? { agentId: r.agentId } : {}),
    approved: nested.approved === true,
    findings,
    ...(typeof nested.summary === 'string' ? { summary: nested.summary } : {}),
  };
}

/**
 * Accept `{reviewers:[...]}`, a bare array, or an object keyed by agent name.
 * Throws on text that is not JSON.
 */
export function parseReviewReports(text: string): ReviewerReport[] {
  const parsed: unknown = JSON.parse(text);
  const list: unknown[] = [];
  if (Array.isArray(parsed)) {
    list.push(...parsed);
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.reviewers)) {
      list.push(...o.reviewers);
    } else {
      for (const [agent, v] of Object.entries(o)) {
        const r = asReport(v, agent);
        if (r) list.push(r);
      }
    }
  }
  return list.flatMap((x) => {
    const r = asReport(x);
    return r ? [r] : [];
  });
}

/**
 * Recover a reviewer's harness agent id from the `SubagentStart` markers when
 * the model did not report it. Refuses to guess: more than one distinct id for
 * the role (another task's reviewer, an earlier round) returns `null`.
 */
export function resolveAgentIdFromMarkers(worktreePath: string, agent: string): string | null {
  const roots = [worktreePath];
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const main = dirname(resolve(worktreePath, common));
    if (!roots.includes(main)) roots.push(main);
  } catch {
    // not a git checkout (tests): worktree only
  }
  const bare = (t: unknown): string =>
    String(t ?? '')
      .split(':')
      .pop() ?? '';
  const found = new Set<string>();
  for (const root of roots) {
    const dir = join(root, '.ai-sdlc', 'subagent-sessions');
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          agentType?: string;
          agentId?: string;
        };
        if (bare(m.agentType) === agent && m.agentId) found.add(m.agentId);
      } catch {
        // skip unreadable marker
      }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

export type ReviewFinalizeResult =
  | { ok: true; verdict: AggregatedVerdict; warnings: string[] }
  /** `recoverable`: nothing was persisted yet, so re-sending a corrected report is safe. */
  | { ok: false; reason: string; recoverable?: boolean };

function zeroCounts(): Record<Severity, number> {
  return { critical: 0, major: 0, minor: 0, suggestion: 0 };
}

/** The gate decision when no reviewer was selected (empty diff): APPROVED, zero findings. */
export function approvedWithoutReviewers(harnessNote: string): AggregatedVerdict {
  return {
    approved: true,
    counts: zeroCounts(),
    decision: 'APPROVED',
    verdicts: [],
    harnessNote,
    summary: 'No reviewers were selected for this diff; gate approved with zero findings.',
  };
}

export async function finalizeReview(
  ctx: NextStepContext,
  state: NextStepState,
  reports: ReviewerReport[],
): Promise<ReviewFinalizeResult> {
  const review = state.review;
  if (!review) return { ok: false, reason: 'review-finalize called with no review round in state' };
  const warnings: string[] = [];
  const verdicts: ReviewerVerdict[] = [];
  const wtAiSdlc = join(state.worktreePath, '.ai-sdlc');

  // Resolve every reviewer's harness agent id BEFORE touching disk, so a reporting slip
  // (a missing id) is fixable by re-sending the report with no half-persisted state.
  const agentIds = new Map<string, string>();
  for (const sp of review.spawned) {
    const report = reports.find((r) => r.agent === sp.agent || r.agent === sp.reviewer);
    if (!report) continue;
    const id = report.agentId ?? resolveAgentIdFromMarkers(state.worktreePath, sp.agent);
    if (!id) {
      return {
        ok: false,
        recoverable: true,
        reason:
          `Step 7b.5: no harness agent id for ${sp.agent}; report the agentId the Agent tool ` +
          `returned for this reviewer (ambiguous or missing SubagentStart markers).`,
      };
    }
    agentIds.set(sp.agent, id);
  }

  for (const sp of review.spawned) {
    const report = reports.find((r) => r.agent === sp.agent || r.agent === sp.reviewer);
    if (!report) {
      // A reviewer that never reported cannot approve: fail the gate loudly.
      verdicts.push({
        agentId: sp.agent,
        harness: sp.harness,
        approved: false,
        findings: [
          {
            severity: 'critical',
            message: `reviewer ${sp.agent} returned no verdict to the coordinator`,
          },
        ],
        summary: 'no verdict reported',
      });
      continue;
    }
    verdicts.push({
      agentId: sp.agent,
      harness: sp.harness,
      approved: report.approved,
      findings: report.findings ?? [],
      ...(report.summary !== undefined ? { summary: report.summary } : {}),
    });

    // 7b.5 — persist transcript + verdict (coordinator side).
    const agentId = agentIds.get(sp.agent)!;
    const verdictScratch = writeRunFile(
      ctx,
      `verdict-${sp.agent}.json`,
      JSON.stringify({
        approved: report.approved,
        findings: report.findings ?? [],
        summary: report.summary ?? '',
      }),
    );
    const persist = await ctx.runner(
      'bash',
      [
        join(ctx.pluginScriptsDir, 'persist-reviewer-artifacts.sh'),
        '--worktree',
        state.worktreePath,
        '--task-id',
        state.taskId,
        '--reviewer',
        sp.agent,
        '--agent-id',
        agentId,
        '--verdict-file',
        verdictScratch,
      ],
      { cwd: ctx.workDir, allowFailure: true },
    );
    if (persist.code !== 0) {
      return {
        ok: false,
        reason: `Step 7b.5: persist-reviewer-artifacts failed for ${sp.agent}: ${(persist.stderr || persist.stdout).trim()}`,
      };
    }

    // 7c — one transcript leaf per reviewer that really ran.
    const transcript = join(wtAiSdlc, 'transcripts', state.taskIdLower, `${sp.agent}.jsonl`);
    const verdictFile = join(wtAiSdlc, 'verdicts', `${sp.agent}-${state.taskIdLower}.json`);
    if (!ctx.exists(transcript) || !ctx.exists(verdictFile)) {
      warnings.push(
        `Step 7c: transcript or verdict missing for ${sp.agent} after persistence; leaf not emitted (the v6 sign step will block)`,
      );
      continue;
    }
    const emit = await ctx.runner(
      'node',
      [
        join(ctx.cliBinDir, 'cli-attestation.mjs'),
        'emit-leaf',
        '--repo-root',
        state.worktreePath,
        '--task-id',
        state.taskId,
        '--reviewer',
        sp.agent,
        '--transcript-path',
        transcript,
        '--verdict-path',
        verdictFile,
        '--head-sha',
        review.headSha,
        '--harness',
        sp.harness,
        '--model',
        sp.leafModel,
        '--nonce',
        review.nonce,
        '--iteration',
        String(state.iteration),
      ],
      { cwd: ctx.workDir, allowFailure: true },
    );
    if (emit.code !== 0) {
      warnings.push(
        `Step 7c: emit-leaf for ${sp.agent} exited non-zero (${emit.stderr.trim()}); the v6-default sign step will block (AI_SDLC_V5_LEGACY=1 falls back to v5)`,
      );
    }
  }

  const verdict = await aggregateRound(verdicts, review.harnessNote);
  writeRunFile(ctx, 'aggregate.json', JSON.stringify(verdict, null, 2));
  return { ok: true, verdict, warnings };
}

/**
 * Aggregate one round's verdicts. An empty list (the classifier selected no
 * reviewer for an empty diff) is APPROVED with zero findings; the generic
 * aggregator would otherwise read "no approvals" as a rejection.
 */
export async function aggregateRound(
  verdicts: ReviewerVerdict[],
  harnessNote: string,
): Promise<AggregatedVerdict> {
  if (verdicts.length === 0) return approvedWithoutReviewers(harnessNote);
  return aggregateVerdicts({ verdicts, harnessNote });
}
