/**
 * Judgment-layer inputs for Stage A and Stage B.
 *
 * Stage A and Stage B are synchronous, so the judgment layer is consulted first and its
 * answers are handed to them (`StageAInput.judged`, `StageBInput.signals`). With no
 * runner, or when the layer abstains, escalates or fails, nothing is returned and the
 * stages run exactly as they did before the layer existed.
 *
 * @module decisions/judged
 */

import { existsSync, readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import {
  decisionDuplicateDefinition,
  decisionPillarsDefinition,
  decisionReversibilityDefinition,
  decisionStageBSignalsDefinition,
  type DecisionText,
  type ExemplarRef,
  type StageBSignals,
} from '@ai-sdlc/reference';

import type { JudgmentRunner } from '../judgment/runner.js';
import type { Decision } from './decision-record.js';
import { resolveDecisionExemplarsPath, type DecisionExemplar } from './decision-exemplars.js';
import {
  assessReversibility,
  detectDuplicates,
  deriveAffectedPillars,
  normaliseSummary,
  normalisedSimilarity,
  type StageAJudgments,
} from './stage-a.js';

/** Edit-distance similarity from which a pair is put to the judgment (below the 0.85 flag). */
export const DUPLICATE_SHORTLIST_MIN_SIMILARITY = 0.5;

/** Most pairs put to the judgment in one request. */
export const DUPLICATE_SHORTLIST_MAX = 5;

/** Most exemplars sent as context for the Stage B signals. */
export const STAGE_B_EXEMPLAR_LIMIT = 8;

export interface JudgeOptions {
  /** Kind of the work item. Only `'backlog'` may decide in the permissive direction. */
  sourceKind?: string;
}

function decisionText(decision: Decision): DecisionText {
  return {
    summary: decision.spec.summary,
    ...(decision.spec.body ? { body: decision.spec.body } : {}),
    options: (decision.spec.options ?? []).map((o) => ({ id: o.id, description: o.description })),
  };
}

/** The pairs the edit-distance pass shortlists for the duplicate judgment. */
export function shortlistDuplicates(
  decision: Decision,
  openDecisions: readonly Decision[],
): { id: string; summary: string; similarity: number }[] {
  const target = normaliseSummary(decision.spec.summary);
  return openDecisions
    .filter((o) => o.metadata.id !== decision.metadata.id)
    .map((o) => ({
      id: o.metadata.id,
      summary: o.spec.summary,
      similarity: normalisedSimilarity(target, normaliseSummary(o.spec.summary)),
    }))
    .filter((c) => c.similarity >= DUPLICATE_SHORTLIST_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
    .slice(0, DUPLICATE_SHORTLIST_MAX);
}

/**
 * Ask the judgment layer the three Stage A questions. Returns `undefined` when there is
 * no runner or nothing came back as an `act` outcome.
 */
export async function judgeStageA(
  decision: Decision,
  openDecisions: readonly Decision[],
  runner: JudgmentRunner | undefined,
  opts: JudgeOptions = {},
): Promise<StageAJudgments | undefined> {
  if (!runner) return undefined;
  const text = decisionText(decision);
  const run = {
    sourceKind: opts.sourceKind,
    taskId: decision.metadata.id,
  };

  // An explicit `reversible` field always wins, so there is nothing to ask.
  const reversibilityAsked = decision.spec.reversible === undefined;
  const shortlist = shortlistDuplicates(decision, openDecisions);
  const keywordDuplicate = detectDuplicates(decision, [...openDecisions]);

  const [reversibility, pillars, duplicate] = await Promise.all([
    reversibilityAsked
      ? runner(decisionReversibilityDefinition, text, {
          ...run,
          incumbent: assessReversibility(decision),
        })
      : undefined,
    runner(decisionPillarsDefinition, text, { ...run, incumbent: deriveAffectedPillars(decision) }),
    shortlist.length > 0
      ? runner(
          decisionDuplicateDefinition,
          {
            summary: text.summary,
            ...(text.body ? { body: text.body } : {}),
            candidates: shortlist.map((c) => ({ id: c.id, summary: c.summary })),
          },
          { ...run, incumbent: keywordDuplicate },
        )
      : undefined,
  ]);

  const judged: StageAJudgments = {};
  if (reversibility?.kind === 'act') judged.reversibility = reversibility.decision;
  if (pillars?.kind === 'act') judged.pillars = pillars.decision;
  if (duplicate?.kind === 'act' && duplicate.decision.duplicateOf !== null) {
    const id = duplicate.decision.duplicateOf;
    const pair = shortlist.find((c) => c.id === id);
    if (pair) judged.duplicate = { candidateId: id, similarity: pair.similarity };
  }
  return Object.keys(judged).length > 0 ? judged : undefined;
}

// ── Stage B signals ──────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Read the exemplar history as references the judgment can use. Accepts the curated
 * list of promoted exemplars as well as the seeded `exemplars:` map. A missing or
 * unreadable file yields no exemplars.
 */
export function readExemplarRefs(repoRoot: string, path?: string): ExemplarRef[] {
  const file = resolveDecisionExemplarsPath(repoRoot, path);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = yamlLoad(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { exemplars?: unknown }).exemplars)
      ? (parsed as { exemplars: unknown[] }).exemplars
      : [];
  const refs: ExemplarRef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown> & Partial<DecisionExemplar>;
    const id = str(e.id);
    // Seeded shape: type + summary + rationale. Promoted shape: polarity + inputText.
    const summary = str(e.summary) ?? str(e.inputText);
    if (!id || !summary) continue;
    const label =
      str(e.type) ??
      (e.polarity === 'positive'
        ? 'true-positive'
        : e.polarity === 'negative'
          ? 'false-positive'
          : 'unlabelled');
    const rationale = str(e.rationale) ?? str(e.promotionRationale) ?? str(e.reasoning);
    refs.push({ id, label, summary, ...(rationale ? { rationale } : {}) });
  }
  return refs;
}

const words = (s: string): Set<string> =>
  new Set(
    normaliseSummary(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );

/** The exemplars sharing the most words with the decision, most similar first. */
export function selectRelevantExemplars(
  decision: Decision,
  exemplars: readonly ExemplarRef[],
  limit = STAGE_B_EXEMPLAR_LIMIT,
): ExemplarRef[] {
  const target = words(`${decision.spec.summary} ${decision.spec.body ?? ''}`);
  return exemplars
    .map((e) => {
      const w = words(e.summary);
      let shared = 0;
      for (const t of w) if (target.has(t)) shared += 1;
      return { e, score: w.size === 0 ? 0 : shared / w.size };
    })
    .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id))
    .slice(0, limit)
    .map((x) => x.e);
}

/**
 * Ask the judgment layer for the two Stage B signals. Returns `undefined` when there is
 * no runner or the outcome is not `act`, in which case both signals stay at 0.5.
 */
export async function judgeStageBSignals(
  decision: Decision,
  repoRoot: string,
  runner: JudgmentRunner | undefined,
  opts: JudgeOptions & { exemplarsPath?: string } = {},
): Promise<StageBSignals | undefined> {
  if (!runner) return undefined;
  const exemplars = selectRelevantExemplars(
    decision,
    readExemplarRefs(repoRoot, opts.exemplarsPath),
  );
  const outcome = await runner(
    decisionStageBSignalsDefinition,
    { ...decisionText(decision), exemplars },
    {
      sourceKind: opts.sourceKind,
      taskId: decision.metadata.id,
      incumbent: { novelty: 0.5, exemplarSimilarity: 0.5 },
    },
  );
  return outcome.kind === 'act' ? outcome.decision : undefined;
}
