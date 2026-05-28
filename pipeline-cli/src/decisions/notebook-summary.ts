/**
 * RFC-0035 Phase 10 — NotebookLM-style decision summary (AISDLC-294).
 *
 * Generates a short, NotebookLM-style executive summary for a decision —
 * the "if you only read three sentences, read these" digest. Designed for
 * non-trivial branching decisions where the operator wants a fast read
 * before opening the full support surface.
 *
 * ### Feature-flag gated (AC#3)
 *
 * NotebookLM summaries cost an extra LLM call per decision; the feature
 * is OFF by default and gated on `AI_SDLC_DECISION_NOTEBOOK_SUMMARIES`.
 * Truthy values (`1`/`true`/`yes`/`on`/`experimental`): ON. Falsy values
 * (unset/empty/`0`/`false`/`no`/`off`/`disabled`): OFF.
 *
 * Mirrors the `AI_SDLC_DECISION_CATALOG` predicate's truthy parsing for
 * cross-flag operator UX consistency — but ships OFF-by-default because
 * the surface adds cost (extra LLM call) and is not load-bearing for
 * v1 catalog operation.
 *
 * ### Invoker contract
 *
 * Like the research subagent, the framework owns the gate + persistence
 * but injects the transport. Production wires Claude / Haiku / Codex /
 * etc.; tests inject a deterministic stub.
 *
 * @module decisions/notebook-summary
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SubscriptionLedgerEntry,
  SubscriptionLedgerWriter,
} from '../classifier/substrate/index.js';

import type { Decision, StageCOutput } from './decision-record.js';

// ── Feature flag ─────────────────────────────────────────────────────────────

export const DECISION_NOTEBOOK_SUMMARIES_FLAG = 'AI_SDLC_DECISION_NOTEBOOK_SUMMARIES' as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'experimental', 'enabled']);

/**
 * Whether the NotebookLM summary surface is enabled.
 *
 * OFF by default (the surface is optional; v1 catalog operation does not
 * require it). Truthy values turn it on.
 */
export function isNotebookSummariesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DECISION_NOTEBOOK_SUMMARIES_FLAG];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function notebookSummariesDisabledMessage(): string {
  return (
    `[cli-decisions] feature flag ${DECISION_NOTEBOOK_SUMMARIES_FLAG} is off; ` +
    `NotebookLM-style summaries are disabled. Set ${DECISION_NOTEBOOK_SUMMARIES_FLAG}=on to enable.`
  );
}

// ── Invoker contract ─────────────────────────────────────────────────────────

export interface NotebookSummaryInput {
  decisionId: string;
  summary: string;
  body?: string;
  options: Array<{ id: string; description: string }>;
  /** Stage C recommendation (when available — included for grounding). */
  recommendation?: {
    optionId: string;
    confidence: number;
    rationale: string;
  };
}

export interface NotebookSummaryResponse {
  /**
   * Markdown body — short executive summary. Should fit in a Slack/TUI
   * sidebar (3-5 sentences, ≤ 60 lines markdown).
   */
  summaryMarkdown: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type NotebookSummaryInvoker = (
  input: NotebookSummaryInput,
) => Promise<NotebookSummaryResponse>;

// ── Persistence (single-file overwrite per decision) ─────────────────────────

export interface WriteNotebookSummaryInput {
  workDir: string;
  decisionId: string;
  summaryMarkdown: string;
  model?: string;
  now?: Date;
}

export interface WriteNotebookSummaryResult {
  path: string;
  timestamp: string;
}

/**
 * Persist a NotebookLM-style summary at
 * `<work-dir>/.ai-sdlc/_decisions/summaries/<DEC-id>.md`.
 *
 * Single-file per decision (overwrite-on-update) — the summary is a
 * derived view of the current decision state, not a historical record.
 * Older versions are not retained; re-run when the decision evolves.
 */
export function writeNotebookSummary(input: WriteNotebookSummaryInput): WriteNotebookSummaryResult {
  const ts = (input.now ?? new Date()).toISOString();
  const dir = join(input.workDir, '.ai-sdlc', '_decisions', 'summaries');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${input.decisionId}.md`);

  const headerLines: string[] = [
    `<!-- RFC-0035 Phase 10 (AISDLC-294) — NotebookLM-style summary -->`,
    `<!-- decision: ${input.decisionId} -->`,
    `<!-- generated: ${ts} -->`,
  ];
  if (input.model) headerLines.push(`<!-- model: ${input.model} -->`);

  const body = `${headerLines.join('\n')}\n\n${input.summaryMarkdown.trimEnd()}\n`;
  writeFileSync(path, body, 'utf8');
  return { path, timestamp: ts };
}

export interface NotebookSummaryArtifact {
  path: string;
  summaryMarkdown: string;
}

/**
 * Read the persisted summary for a decision id, if any. Returns `null`
 * when no summary has been generated.
 */
export function readNotebookSummary(
  workDir: string,
  decisionId: string,
): NotebookSummaryArtifact | null {
  const path = join(workDir, '.ai-sdlc', '_decisions', 'summaries', `${decisionId}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const stripped = raw.replace(/^(?:<!--[^]*?-->\s*)+/, '').trimStart();
  return { path, summaryMarkdown: stripped };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface RunNotebookSummaryInput {
  decision: Decision;
  invoker: NotebookSummaryInvoker;
  workDir: string;
  ledgerWriter?: SubscriptionLedgerWriter;
  now?: Date;
  /** Override the env-var feature-flag check (tests). */
  forceEnabled?: boolean;
}

export interface RunNotebookSummaryResult {
  generated: boolean;
  /**
   * Reason when `generated: false`:
   *   - 'disabled'      — feature flag is off (AC#3 default).
   *   - 'invoker-error' — the invoker threw.
   */
  skipReason?: 'disabled' | 'invoker-error';
  artifact?: WriteNotebookSummaryResult;
  response?: NotebookSummaryResponse;
  ledgerEntry?: SubscriptionLedgerEntry;
}

/**
 * Compose feature-flag gate + invoker + persistence + ledger debit.
 *
 * Like `runResearchSubagent`, errors are returned as result values rather
 * than thrown — the caller renders an error banner on the surface.
 */
export async function runNotebookSummary(
  input: RunNotebookSummaryInput,
): Promise<RunNotebookSummaryResult> {
  const enabled = input.forceEnabled ?? isNotebookSummariesEnabled();
  if (!enabled) return { generated: false, skipReason: 'disabled' };

  const evaluation = input.decision.status.evaluation as { stageC?: StageCOutput } | undefined;
  const stageC = evaluation?.stageC;
  const invokerInput: NotebookSummaryInput = {
    decisionId: input.decision.metadata.id,
    summary: input.decision.spec.summary,
    ...(input.decision.spec.body ? { body: input.decision.spec.body } : {}),
    options: input.decision.spec.options.map((o) => ({
      id: o.id,
      description: o.description,
    })),
    ...(stageC?.recommendation
      ? {
          recommendation: {
            optionId: stageC.recommendation.optionId,
            confidence: stageC.recommendation.confidence,
            rationale: stageC.recommendation.rationale,
          },
        }
      : {}),
  };

  let response: NotebookSummaryResponse;
  try {
    response = await input.invoker(invokerInput);
  } catch {
    return { generated: false, skipReason: 'invoker-error' };
  }

  const artifact = writeNotebookSummary({
    workDir: input.workDir,
    decisionId: input.decision.metadata.id,
    summaryMarkdown: response.summaryMarkdown,
    model: response.model,
    ...(input.now ? { now: input.now } : {}),
  });

  let ledgerEntry: SubscriptionLedgerEntry | undefined;
  if (input.ledgerWriter) {
    ledgerEntry = {
      timestamp: artifact.timestamp,
      taskType: 'decision-recommendation',
      model: response.model,
      inputTokens: Math.max(0, Math.floor(response.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(response.outputTokens ?? 0)),
    };
    try {
      await input.ledgerWriter(ledgerEntry);
    } catch {
      // ignore — see substrate convention.
    }
  }

  return {
    generated: true,
    artifact,
    response,
    ...(ledgerEntry ? { ledgerEntry } : {}),
  };
}
