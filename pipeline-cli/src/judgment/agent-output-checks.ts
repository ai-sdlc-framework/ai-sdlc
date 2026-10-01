/**
 * Advisory judgments on agent output: `dev.ac-coverage` (after the developer
 * return is parsed) and `review.finding-grounding` (before verdict aggregation).
 *
 * Both are tighten-only and advisory. They annotate and notify; they never change
 * a verdict, a finding, a severity, the reviewer set or the attestation. With the
 * layer disabled (no provider, or the judgment's mode is `off`) nothing runs and
 * nothing is read from disk.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  acCoverageJudgment,
  canonicalJson,
  evaluateJudgment,
  extractExcerpt,
  findingGroundingJudgment,
  GROUNDING_FLAGGED,
  resolveJudgmentProvider,
  type EvaluateJudgmentContext,
  type GroundingItem,
  type JudgmentEvaluationRecord,
  type JudgmentProvider,
} from '@ai-sdlc/reference';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import type { AcCoverageResult, FindingGroundingAnnotation, ReviewerVerdict } from '../types.js';

/** Wiring Step 6 needs to run `dev.ac-coverage`. */
export interface AcCoverageHook {
  ctx: EvaluateJudgmentContext;
  acceptanceCriteria: string[];
  /** Lazily produces the diff against the merge base; called only when the layer is on. */
  getDiff: () => Promise<string | undefined>;
}

/** Wiring Step 8 needs to run `review.finding-grounding`. */
export interface FindingGroundingHook {
  ctx: EvaluateJudgmentContext;
  /** Worktree checked out at the reviewed commit. */
  worktreePath: string;
  /** Test injection: returns a file's text at the reviewed commit, or undefined when absent. */
  readFile?: (file: string) => string | undefined;
}

function configuredMode(ctx: EvaluateJudgmentContext, id: string): string {
  return ctx.config.judgments[id]?.mode ?? ctx.config.defaults.mode;
}

/** True when a provider is configured and the judgment is not switched off. */
function layerOn(ctx: EvaluateJudgmentContext, id: string): boolean {
  return !!ctx.config.provider && configuredMode(ctx, id) !== 'off';
}

/** Run `dev.ac-coverage`. Never throws; undefined means nothing to report. */
export async function runAcCoverage(hook: AcCoverageHook): Promise<AcCoverageResult | undefined> {
  try {
    const { ctx } = hook;
    if (!layerOn(ctx, acCoverageJudgment.id) || hook.acceptanceCriteria.length === 0) {
      return undefined;
    }
    const diff = await hook.getDiff();
    if (!diff) return undefined;
    const outcome = await evaluateJudgment(
      acCoverageJudgment,
      { acceptanceCriteria: hook.acceptanceCriteria, diff },
      ctx,
    );
    if (outcome.kind === 'act') return outcome.decision;
    if (outcome.kind === 'escalate' && outcome.partial?.criteria) {
      const criteria = outcome.partial.criteria;
      return { criteria, uncovered: criteria.filter((c) => c.likelyUncovered).length };
    }
    if (outcome.kind === 'abstain' && outcome.reason === 'state-too-large') {
      return { criteria: [], uncovered: 0, abstainReason: 'state-too-large' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Diff of HEAD against the merge base with the integration branch. */
export async function getMergeBaseDiff(opts: {
  workDir: string;
  worktreePath: string;
  runner?: Runner;
}): Promise<string | undefined> {
  const runner = opts.runner ?? defaultRunner;
  const target = resolveTargetBranch(opts.workDir);
  const res = await runner('git', ['diff', `origin/${target}...HEAD`], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  return res.code === 0 ? res.stdout : undefined;
}

/** Read a file inside the worktree; undefined when missing, a directory, or outside it. */
function readWorktreeFile(worktreePath: string, file: string): string | undefined {
  try {
    const root = resolve(worktreePath);
    const abs = resolve(root, file);
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function tokenEstimate(value: unknown): number {
  return canonicalJson(value).length / 4;
}

/** Greedy packing of items into as few requests as the state budget allows. */
function batchItems(items: GroundingItem[], provider: JudgmentProvider | undefined) {
  const budget = provider?.capabilities.maxStateTokens ?? Number.POSITIVE_INFINITY;
  const batches: GroundingItem[][] = [];
  let current: GroundingItem[] = [];
  let used = 0;
  for (const item of items) {
    const cost =
      tokenEstimate(findingGroundingJudgment.buildState({ items: [item] })) +
      tokenEstimate(findingGroundingJudgment.questions({ items: [item] })) +
      16;
    if (current.length > 0 && used + cost > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function pickProvider(ctx: EvaluateJudgmentContext): JudgmentProvider | undefined {
  try {
    const name = ctx.config.provider;
    if (!name) return undefined;
    return ctx.getProvider
      ? ctx.getProvider(name)
      : resolveJudgmentProvider(name, ctx.config.providerOptions, ctx.config.model);
  } catch {
    return undefined;
  }
}

/** Log record for the in-code location check (no provider is called). */
async function recordLocationCheck(
  ctx: EvaluateJudgmentContext,
  enforce: boolean,
  annotations: FindingGroundingAnnotation[],
): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const rec: JudgmentEvaluationRecord = {
    ts: now().toISOString(),
    judgmentId: findingGroundingJudgment.id,
    version: findingGroundingJudgment.version,
    consumerLabel: ctx.consumerLabel ?? findingGroundingJudgment.id,
    questionSetHash: null,
    stateHash: null,
    provider: null,
    providerModelKey: null,
    modelVersion: null,
    mode: enforce ? 'enforce' : 'shadow',
    answers: null,
    thresholds: null,
    outcome: enforce
      ? {
          kind: 'escalate',
          to: 'operator',
          reason: `${annotations.length} review finding${annotations.length === 1 ? '' : 's'} cite code that was not found`,
          partial: { annotations },
        }
      : { kind: 'abstain', reason: 'shadow' },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: false,
    costUsd: null,
    cacheHit: false,
    ...(ctx.sourceKind ? { sourceKind: ctx.sourceKind } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  };
  for (const sink of ctx.sinks ?? []) {
    try {
      await sink.record(rec);
    } catch {
      // a sink failure never changes the result
    }
  }
}

/**
 * Run `review.finding-grounding` over every finding that cites a file and line.
 * Runs only when both `agent-output` and `code-diff` egress are allowed. Never
 * throws; undefined means nothing to report. Findings are never modified.
 */
export async function runFindingGrounding(
  verdicts: ReviewerVerdict[],
  hook: FindingGroundingHook,
): Promise<FindingGroundingAnnotation[] | undefined> {
  try {
    const { ctx } = hook;
    const id = findingGroundingJudgment.id;
    if (!layerOn(ctx, id)) return undefined;
    const allowed = ctx.config.egressAllow;
    if (!allowed.includes('agent-output') || !allowed.includes('code-diff')) return undefined;
    const enforce = configuredMode(ctx, id) === 'enforce';
    const read = hook.readFile ?? ((f: string) => readWorktreeFile(hook.worktreePath, f));

    const missing: FindingGroundingAnnotation[] = [];
    const items: GroundingItem[] = [];
    for (const v of verdicts) {
      (v.findings ?? []).forEach((f, findingIndex) => {
        if (!f.file || typeof f.line !== 'number') return;
        const text = read(f.file);
        const excerpt = text === undefined ? undefined : extractExcerpt(text, f.line);
        if (!excerpt) {
          missing.push({
            agentId: String(v.agentId),
            findingIndex,
            file: f.file,
            line: f.line,
            relation: 'location-not-found',
          });
          return;
        }
        items.push({
          id: `finding-${items.length}`,
          agentId: String(v.agentId),
          findingIndex,
          claim: f.message,
          file: f.file,
          line: f.line,
          ...excerpt,
        });
      });
    }
    if (missing.length === 0 && items.length === 0) return undefined;

    if (missing.length > 0) await recordLocationCheck(ctx, enforce, missing);

    const annotations: FindingGroundingAnnotation[] = enforce ? [...missing] : [];
    for (const batch of batchItems(items, pickProvider(ctx))) {
      const outcome = await evaluateJudgment(findingGroundingJudgment, { items: batch }, ctx);
      if (outcome.kind === 'act') annotations.push(...outcome.decision.annotations);
      else if (outcome.kind === 'escalate' && outcome.partial?.annotations) {
        annotations.push(...outcome.partial.annotations);
      }
    }
    return annotations.length > 0 ? annotations : undefined;
  } catch {
    return undefined;
  }
}

/** True when an annotation is worth surfacing to the operator. */
export function isFlaggedAnnotation(a: FindingGroundingAnnotation): boolean {
  return GROUNDING_FLAGGED.includes(a.relation);
}

const MAX_CRITERION_CHARS = 120;

/**
 * "Judgment notes (advisory)" PR-body section, or an empty string when there is
 * nothing to report.
 */
export function composeJudgmentNotes(opts: {
  acCoverage?: AcCoverageResult;
  groundingAnnotations?: FindingGroundingAnnotation[];
  acceptanceCriteria?: string[];
}): string {
  const lines: string[] = [];
  for (const c of opts.acCoverage?.criteria ?? []) {
    if (!c.likelyUncovered) continue;
    const text = (opts.acceptanceCriteria?.[c.index] ?? '').replace(/\s+/g, ' ').trim();
    const shown =
      text.length > MAX_CRITERION_CHARS ? `${text.slice(0, MAX_CRITERION_CHARS)}...` : text;
    lines.push(
      `- Acceptance criterion ${c.index + 1} may not be covered by the diff` +
        `${shown ? `: ${shown}` : ''} (coverage probability ${c.probability.toFixed(2)})`,
    );
  }
  for (const a of opts.groundingAnnotations ?? []) {
    if (!isFlaggedAnnotation(a)) continue;
    const what =
      a.relation === 'location-not-found'
        ? 'cites a location that was not found'
        : a.relation === 'contradicts'
          ? 'is contradicted by the cited code'
          : 'is unrelated to the cited code';
    lines.push(`- A ${a.agentId} finding at ${a.file}:${a.line} ${what}`);
  }
  if (lines.length === 0) return '';
  return (
    '## Judgment notes (advisory)\n' +
    'Automated checks flagged the items below. They are informational and did not change the review verdict.\n\n' +
    `${lines.join('\n')}\n`
  );
}
