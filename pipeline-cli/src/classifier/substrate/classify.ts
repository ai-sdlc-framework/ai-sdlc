/**
 * Public `classify()` entry point — the shared classifier substrate's
 * single API surface (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Resolves per-task config → builds the LLM prompt → invokes the LLM →
 * parses the response → writes a corpus entry → optionally accounts the
 * subscription cost → returns the decision.
 *
 * **Failure modes**:
 *   - Invoker throws (network, timeout, budget exhaustion) → returns a
 *     `pending` sentinel decision with confidence 0. The caller can
 *     treat this as "low-confidence" (auto-route to operator).
 *   - LLM returns invalid JSON / wrong shape / disallowed classification
 *     → same: `pending` sentinel, confidence 0. Records a `pending`
 *     corpus entry with the raw classification for post-mortem review.
 *
 * **Why fall-open**: per the architectural pattern shared with the
 * conditional-review classifier (RFC-0010 §12.3), "fall open" on the
 * classifier layer means routing to the human — the safe failure mode.
 * The substrate never silently SKIPS work the operator would have wanted
 * to see; low confidence + operator routing is the protective default.
 *
 * @module classifier/substrate/classify
 */

import { randomUUID } from 'node:crypto';

import { appendCorpusEntry } from './corpus.js';
import { loadSubstrateConfig } from './config.js';
import { buildPrompt, isAllowedClassification } from './task-prompts.js';
import type {
  CalibrationCorpusEntry,
  ClassifierDecision,
  ClassifierInput,
  ClassifierTaskType,
  ClassifyOpts,
  LlmInvocationResponse,
  SubscriptionLedgerEntry,
} from './types.js';

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Classify a single input against the named task-type prompt. Public API
 * — this is what AC-1 names. All callers (OQ-2 capture-triage, OQ-3
 * PR-comment, OQ-5 severity, OQ-11 DoR clarification, RFC-0035 Stage C
 * decision-recommendation) go through here.
 *
 * The substrate resolves config (threshold + model), invokes the LLM,
 * captures a calibration corpus entry, and returns the decision. The
 * caller decides what to do with the decision based on
 * `metBehindThreshold` — auto-apply when true, route to operator when
 * false. The operator-route path then calls `recordOperatorOverride()`
 * on override (AC-6) or relies on the silence sweeper (AC-7) for the
 * positive path.
 *
 * @param input    Free-form input — see `ClassifierInput`.
 * @param taskType One of the 5 task types — see `ClassifierTaskType`.
 * @param opts     Per-call overrides + dependency injection.
 *
 * @returns A `ClassifierDecision`. Never throws — failure modes return a
 *          `pending` sentinel so callers don't need a try/catch wrapper.
 */
export async function classify(
  input: ClassifierInput,
  taskType: ClassifierTaskType,
  opts: ClassifyOpts = {},
): Promise<ClassifierDecision> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  // AISDLC-275 AC-4: pass `agentRole` so per-agent threshold overrides
  // apply ahead of per-task / global config. The per-call `opts.threshold`
  // (set below) still wins overall — that's the substrate's documented
  // resolution order.
  const config = loadSubstrateConfig(taskType, repoRoot, opts.agentRole);
  const effectiveThreshold = opts.threshold ?? config.threshold;
  const model = opts.model ?? config.model;

  const prompt = buildPrompt(taskType, input);

  let llmResponse: LlmInvocationResponse | null = null;
  let parseError: string | null = null;
  let invokerError: string | null = null;

  if (!opts.invoker) {
    invokerError = 'no invoker supplied';
  } else {
    try {
      llmResponse = await opts.invoker.invoke({
        model,
        prompt,
        taskType,
        maxOutputTokens: 1024,
      });
    } catch (err) {
      invokerError = err instanceof Error ? err.message : String(err);
    }
  }

  // Validate the response shape + classification membership. A response
  // that fails validation is treated like an invoker failure — `pending`
  // sentinel + corpus capture of what we got back (so operators can
  // post-mortem prompts that consistently confuse the LLM).
  let classification = 'pending';
  let confidence = 0;
  let reasoning = '';

  if (llmResponse) {
    const validation = validateResponse(llmResponse, taskType, input);
    if (validation.ok) {
      classification = validation.classification;
      confidence = validation.confidence;
      reasoning = validation.reasoning;
    } else {
      parseError = validation.reason;
      // Preserve what we got for the corpus entry so operators can see
      // the LLM's mis-shaped output.
      classification = String(llmResponse.classification ?? 'pending');
      confidence = 0;
      reasoning =
        typeof llmResponse.reasoning === 'string'
          ? llmResponse.reasoning
          : `(invalid response: ${validation.reason})`;
    }
  } else if (invokerError) {
    reasoning = `(invoker error: ${invokerError})`;
  }

  const metBehindThreshold =
    typeof confidence === 'number' &&
    confidence >= effectiveThreshold &&
    !parseError &&
    !invokerError;

  // ── Corpus capture ──────────────────────────────────────────────────────
  let corpusEntryId: string | null = null;
  if (!opts.skipCorpus) {
    const entry: CalibrationCorpusEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      taskType,
      input,
      model,
      classification,
      confidence,
      reasoning,
      threshold: effectiveThreshold,
      metBehindThreshold,
      polarity: 'pending',
    };
    try {
      appendCorpusEntry(repoRoot, entry, opts.corpusDir);
      corpusEntryId = entry.id;
    } catch {
      // Corpus write failure should not break the classifier. The
      // operator surfaces filesystem issues separately; the
      // classification itself is still valid.
      corpusEntryId = null;
    }
  }

  // ── Ledger account ──────────────────────────────────────────────────────
  if (opts.ledgerWriter && llmResponse) {
    const ledgerEntry: SubscriptionLedgerEntry = {
      timestamp: new Date().toISOString(),
      taskType,
      model,
      inputTokens: Math.max(0, Math.floor(llmResponse.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(llmResponse.outputTokens ?? 0)),
    };
    try {
      await opts.ledgerWriter(ledgerEntry);
    } catch {
      // Ledger write failure should not break the classifier (same
      // reasoning as corpus write).
    }
  }

  return {
    classification,
    confidence,
    reasoning,
    metBehindThreshold,
    effectiveThreshold,
    corpusEntryId,
    model,
  };
}

// ── Response validation ──────────────────────────────────────────────────────

type ValidationResult =
  | { ok: true; classification: string; confidence: number; reasoning: string }
  | { ok: false; reason: string };

function validateResponse(
  raw: LlmInvocationResponse,
  taskType: ClassifierTaskType,
  input: ClassifierInput,
): ValidationResult {
  if (typeof raw.classification !== 'string' || raw.classification.length === 0) {
    return { ok: false, reason: 'missing-classification' };
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    return { ok: false, reason: 'invalid-confidence' };
  }
  if (raw.confidence < 0 || raw.confidence > 1) {
    return { ok: false, reason: 'confidence-out-of-range' };
  }
  if (typeof raw.reasoning !== 'string') {
    return { ok: false, reason: 'missing-reasoning' };
  }
  if (!isAllowedClassification(taskType, raw.classification, input)) {
    return { ok: false, reason: `disallowed-classification:${raw.classification}` };
  }
  return {
    ok: true,
    classification: raw.classification,
    confidence: raw.confidence,
    reasoning: raw.reasoning,
  };
}
