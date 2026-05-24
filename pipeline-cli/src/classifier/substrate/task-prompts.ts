/**
 * Per-task-type prompt templates for the shared classifier substrate
 * (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * One template per task type. Each template renders to a single string
 * the LLM invoker passes through to the model. Templates ask the model to
 * emit STRICT JSON in the substrate's standard shape:
 *
 *   {
 *     "classification": "<one-of-allowed-values>",
 *     "confidence": <number in [0,1]>,
 *     "reasoning": "<one or two sentences>"
 *   }
 *
 * The substrate's response parser (`parseLlmResponse` in `classify.ts`)
 * validates that shape; classification-value validation is per-task-type
 * since each task has its own allowed set.
 *
 * **Why this lives in code rather than a YAML asset**: prompt templates
 * are versioned, type-checked, and live next to the contract they
 * implement. A YAML asset would let operators drift prompts away from
 * the substrate's parser expectations — that's a footgun, not a feature.
 * Per-org tuning is via threshold + model overrides in
 * `capture-config.yaml` / `decisions-config.yaml`, not raw prompt edits.
 *
 * @module classifier/substrate/task-prompts
 */

import type { ClassifierInput, ClassifierTaskType } from './types.js';

// ── Allowed classifications per task type ────────────────────────────────────

/**
 * For each task type, the closed set of valid `classification` strings
 * the substrate accepts back. The LLM is told these in the prompt; the
 * parser rejects responses outside the set (treated as fall-open
 * low-confidence). Centralised here so callers can validate themselves
 * + so the parser can defend the contract.
 */
export const ALLOWED_CLASSIFICATIONS: Readonly<Record<ClassifierTaskType, readonly string[]>> =
  Object.freeze({
    'capture-triage': Object.freeze([
      'quick-fix-task',
      'new-feature-issue',
      'scope-extension',
      "won't-fix",
      'tbd',
    ] as const),
    'capture-severity': Object.freeze(['low', 'medium', 'high', 'critical'] as const),
    'pr-comment-is-capture': Object.freeze(['is-capture', 'not-capture'] as const),
    'dor-answer-is-new-concern': Object.freeze([
      'clarification',
      'new-concern',
      'ambiguous',
    ] as const),
    // For decision-recommendation, the allowed set is the caller-supplied
    // option-id list — passed via `input.context.optionIds` at call time.
    // We use the empty list here as a sentinel: the substrate's validator
    // consults `input.context.optionIds` when this task type is in play.
    'decision-recommendation': Object.freeze([] as const),
  });

// ── System-instruction header (shared across all task types) ─────────────────

const SYSTEM_HEADER = `You are a precise classifier. You must respond with valid JSON only — no preamble, no markdown fences, no commentary. The JSON shape is:

{
  "classification": "<one-of-allowed-values>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one or two sentences explaining the choice>"
}

Confidence must reflect your true uncertainty. A value of 0.5 means "could go either way". A value above 0.7 means "I am clearly confident". Do not inflate confidence to seem decisive.

If the input is too ambiguous to classify cleanly, set confidence below 0.5 and pick the best guess. The caller will route low-confidence outputs to a human reviewer; you do NOT need to refuse — you need to be calibrated.`;

// ── Per-task-type templates ──────────────────────────────────────────────────

function buildCaptureTriagePrompt(input: ClassifierInput): string {
  const allowed = ALLOWED_CLASSIFICATIONS['capture-triage'].join(' | ');
  return `${SYSTEM_HEADER}

TASK: Triage a captured finding from an AI-SDLC framework user.

Allowed classifications: ${allowed}

Definitions:
  - quick-fix-task     — small, well-scoped change that fits in one PR
  - new-feature-issue  — material new capability requiring its own Issue
  - scope-extension    — extends an existing in-flight task's acceptance criteria
  - won't-fix          — out of scope, won't be addressed
  - tbd                — genuinely ambiguous; needs operator triage

CAPTURED FINDING:
"""
${input.text}
"""

${renderContext(input.context)}Output the JSON now.`;
}

function buildCaptureSeverityPrompt(input: ClassifierInput): string {
  const allowed = ALLOWED_CLASSIFICATIONS['capture-severity'].join(' | ');
  return `${SYSTEM_HEADER}

TASK: Infer the severity of a captured finding.

Allowed classifications: ${allowed}

Definitions:
  - low      — nice-to-have, no real risk
  - medium   — should fix soon; non-blocking
  - high     — meaningful risk if not addressed
  - critical — outage / security / data-loss risk

CAPTURED FINDING:
"""
${input.text}
"""

${renderContext(input.context)}Output the JSON now.`;
}

function buildPrCommentIsCapturePrompt(input: ClassifierInput): string {
  const allowed = ALLOWED_CLASSIFICATIONS['pr-comment-is-capture'].join(' | ');
  return `${SYSTEM_HEADER}

TASK: Decide whether a PR review comment is a "capture" — that is, a finding worth indexing into the long-term capture corpus (vs. a transient inline-fix conversation that resolves in the PR thread itself).

Allowed classifications: ${allowed}

Heuristics:
  - is-capture     — comment describes a concern that survives the PR (architectural concern, follow-up task, design question, scope question, future risk)
  - not-capture    — comment is purely about THIS PR's diff (typo, style nit, "rename this", "please add a test for X" where the operator will just do it)

PR COMMENT:
"""
${input.text}
"""

${renderContext(input.context)}Output the JSON now.`;
}

function buildDorAnswerIsNewConcernPrompt(input: ClassifierInput): string {
  const allowed = ALLOWED_CLASSIFICATIONS['dor-answer-is-new-concern'].join(' | ');
  return `${SYSTEM_HEADER}

TASK: Classify a single segment of an operator's answer to a DoR (Definition of Ready) clarification question. The framework reuses this signal to decide whether to extract the segment as a new capture record (per RFC-0024 OQ-11).

Allowed classifications: ${allowed}

Definitions:
  - clarification — answers the asked question; no new concern raised
  - new-concern   — surfaces something the question did NOT ask about; should be auto-extracted as a capture
  - ambiguous     — could be either; surface to operator for confirmation

ANSWER SEGMENT:
"""
${input.text}
"""

${renderContext(input.context)}Output the JSON now.`;
}

function buildDecisionRecommendationPrompt(input: ClassifierInput): string {
  // For decision-recommendation, the allowed set is caller-supplied via
  // input.context.optionIds. We render the option list inline so the LLM
  // sees both ids and descriptions.
  const optionIds = extractOptionIds(input.context);
  const optionDescriptions = extractOptionDescriptions(input.context);
  const allowedList = optionIds.length > 0 ? optionIds.join(' | ') : '<no options supplied>';

  return `${SYSTEM_HEADER}

TASK: Recommend an option from the supplied decision-option list (RFC-0035 Stage C). You are NOT making the decision — the operator is. Your job is to pick the option you'd recommend so the operator can quickly accept or override.

Allowed classifications (option ids): ${allowedList}

DECISION SUMMARY:
"""
${input.text}
"""

OPTIONS:
${renderOptionsBlock(optionIds, optionDescriptions)}

${renderContext(input.context, ['optionIds', 'optionDescriptions'])}Output the JSON now.`;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Build the full LLM prompt for the given task type. Pure — no I/O.
 * Throws when `taskType` is not one of the 5 supported values (TypeScript
 * exhaustiveness check catches this at compile time but we keep the
 * runtime guard for safety in JS callers).
 */
export function buildPrompt(taskType: ClassifierTaskType, input: ClassifierInput): string {
  switch (taskType) {
    case 'capture-triage':
      return buildCaptureTriagePrompt(input);
    case 'capture-severity':
      return buildCaptureSeverityPrompt(input);
    case 'pr-comment-is-capture':
      return buildPrCommentIsCapturePrompt(input);
    case 'dor-answer-is-new-concern':
      return buildDorAnswerIsNewConcernPrompt(input);
    case 'decision-recommendation':
      return buildDecisionRecommendationPrompt(input);
    default: {
      // Exhaustiveness guard — if a new task type is added without
      // updating this switch, TypeScript flags it (and this line also
      // surfaces it at runtime for JS callers).
      const _never: never = taskType;
      throw new Error(`buildPrompt: unsupported task type "${String(_never)}"`);
    }
  }
}

/**
 * Validate that an LLM-returned `classification` string is in the allowed
 * set for the task type. For `decision-recommendation`, consults
 * `input.context.optionIds`. Returns `true` when valid; `false` when not.
 */
export function isAllowedClassification(
  taskType: ClassifierTaskType,
  classification: string,
  input: ClassifierInput,
): boolean {
  if (taskType === 'decision-recommendation') {
    const optionIds = extractOptionIds(input.context);
    return optionIds.includes(classification);
  }
  const allowed = ALLOWED_CLASSIFICATIONS[taskType];
  return (allowed as readonly string[]).includes(classification);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderContext(
  context: Record<string, unknown> | undefined,
  excludeKeys: readonly string[] = [],
): string {
  if (!context) return '';
  const entries = Object.entries(context).filter(([k]) => !excludeKeys.includes(k));
  if (entries.length === 0) return '';
  const lines = entries.map(([k, v]) => `  ${k}: ${stringifyContextValue(v)}`);
  return `\nCONTEXT:\n${lines.join('\n')}\n\n`;
}

function stringifyContextValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function extractOptionIds(context: Record<string, unknown> | undefined): string[] {
  if (!context) return [];
  const raw = context.optionIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function extractOptionDescriptions(
  context: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!context) return {};
  const raw = context.optionDescriptions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function renderOptionsBlock(ids: string[], descriptions: Record<string, string>): string {
  if (ids.length === 0) return '  (no options supplied)';
  return ids.map((id) => `  - ${id}: ${descriptions[id] ?? '<no description>'}`).join('\n');
}
