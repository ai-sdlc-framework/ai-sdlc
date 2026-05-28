/**
 * RFC-0035 Phase 10 — Research subagent integration (AISDLC-294).
 *
 * The research subagent is a §8.2 on-demand decision-support element. When
 * Stage C completes a decision but the LLM confidence falls below a
 * configurable threshold (default `0.6`, MUST be less than the Stage C
 * auto-apply threshold so the "low-confidence" band lives strictly below
 * "auto-apply") the framework MAY invoke a research subagent that runs an
 * async investigation (e.g. "compare how Kubernetes / Argo / Buildkite
 * handle X") and posts findings into the decision view.
 *
 * ### Contract — invoker-injected, like the classifier substrate
 *
 * The framework does NOT bake in a transport. Production callers
 * (`/ai-sdlc execute`, orchestrator-tick) wire an invoker that spawns a
 * Claude Code subagent / shells out to `claude -p` / etc.; tests inject
 * a deterministic stub. The Decision Catalog only owns:
 *
 *   1. The CONFIDENCE GATE (`shouldInvokeResearchSubagent`) — pure
 *      function over Stage C output + config.
 *   2. The INVOCATION CONTRACT (`ResearchSubagentInvoker`) — what the
 *      caller passes in.
 *   3. The PERSISTENCE LAYER (`writeResearchArtifact`) — findings land
 *      in `.ai-sdlc/_decisions/research/<DEC-id>-<ISO-ts>.md` so the
 *      support surface can render them without touching the event log
 *      schema (OQ-1: event types are additive-only; research findings
 *      don't need a new event type — they're an on-demand sidecar).
 *   4. SUBSCRIPTION LEDGER INTEGRATION (`runResearchSubagent`) — the
 *      RFC-0010 ledger writer is invoked once per call so the operator's
 *      subscription quota is debited. Aligns with the classifier
 *      substrate's existing `SubscriptionLedgerWriter` contract.
 *
 * ### Why not a new DecisionEvent type?
 *
 * Per OQ-1 (event-sourcing data model) the event-type enum is additive-
 * only. Adding `research-requested` / `research-completed` would expand
 * the schema surface that downstream projectors must handle. Research is
 * an on-demand decision-support augmentation (RFC §8.2), not a state-
 * altering event in the decision's lifecycle (it does not change the
 * lifecycle, recommendation, or routing). The sidecar approach keeps the
 * event log minimal and lets the surface render the augmentation as a
 * collapsible section.
 *
 * ### Acceptance Criteria
 *
 * - AC#1 Confidence gate (`shouldInvokeResearchSubagent`) fires when
 *   Stage C confidence < configurable threshold; threshold defaults to
 *   `0.6` and is overridable via `decisions-config.yaml:
 *   researchSubagentConfidenceThreshold`.
 * - AC#5 Per-call SubscriptionLedger writer hook (RFC-0010 §14.6) — the
 *   ledger is debited once per invocation; tests inject a counter.
 *
 * @module decisions/research-subagent
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SubscriptionLedgerEntry,
  SubscriptionLedgerWriter,
} from '../classifier/substrate/index.js';

import type { Decision, StageCOutput } from './decision-record.js';
import type { DecisionsConfig } from './decisions-config.js';

// ── Confidence threshold ─────────────────────────────────────────────────────

/**
 * Default research-subagent confidence floor. When Stage C reports a
 * recommendation with `confidence < 0.6` the recommendation is "weak
 * enough" that operator-facing research is justified. Set strictly below
 * the Stage C auto-apply threshold (`0.7` per `STAGE_C_DEFAULT_CONFIDENCE_THRESHOLD`)
 * so the bands don't overlap.
 */
export const RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Resolve the effective research-subagent confidence threshold from a
 * loaded `decisions-config.yaml`. Mirrors `resolveStageCThreshold()` —
 * non-finite + out-of-range values fall back to the default with a
 * stderr warning.
 */
export function resolveResearchSubagentThreshold(loaded: DecisionsConfig): number {
  const raw = loaded.researchSubagentConfidenceThreshold;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD;
  }
  if (raw <= 0 || raw >= 1) {
    process.stderr.write(
      `[research-subagent] decisions-config.yaml: researchSubagentConfidenceThreshold=${raw} is out of (0,1) — falling back to default ${RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD}\n`,
    );
    return RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD;
  }
  return raw;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export interface ShouldInvokeResearchSubagentInput {
  /** Stage C output for the decision. `null` when Stage C never fired. */
  stageC: StageCOutput | null;
  /** Effective threshold (call `resolveResearchSubagentThreshold` first). */
  threshold: number;
}

export interface ShouldInvokeResearchSubagentResult {
  invoke: boolean;
  /**
   * Reason when `invoke: false`. One of:
   *   - 'stage-c-missing'         — Stage C never fired; no signal to gate on.
   *   - 'stage-c-error'           — Stage C errored (fall-open); operator-facing
   *                                 research won't add signal — surface the error.
   *   - 'above-threshold'         — Stage C confidence ≥ threshold; recommendation
   *                                 is already strong enough to act on.
   *   - 'recommendation-missing'  — Stage C produced no recommendation (e.g.
   *                                 pending sentinel from fall-open invoker).
   */
  skipReason?: 'stage-c-missing' | 'stage-c-error' | 'above-threshold' | 'recommendation-missing';
  /** The confidence value used for the gate (when one was available). */
  observedConfidence?: number;
}

/**
 * Decide whether the framework SHOULD spawn the research subagent for a
 * given Stage C output. Pure function — no I/O, no LLM calls. The caller
 * (CLI / orchestrator) acts on the boolean.
 *
 * Gating rules (in order):
 *   1. Stage C never fired → SKIP (`stage-c-missing`). The catalog hasn't
 *      asked the LLM yet; research is premature.
 *   2. Stage C errored → SKIP (`stage-c-error`). The signal is noise;
 *      surface the error instead of paying for research that can't be
 *      grounded.
 *   3. Stage C has no recommendation → SKIP (`recommendation-missing`).
 *   4. Confidence ≥ threshold → SKIP (`above-threshold`). Recommendation
 *      is strong enough.
 *   5. Otherwise → INVOKE.
 */
export function shouldInvokeResearchSubagent(
  input: ShouldInvokeResearchSubagentInput,
): ShouldInvokeResearchSubagentResult {
  if (input.stageC === null) {
    return { invoke: false, skipReason: 'stage-c-missing' };
  }
  if (input.stageC.error) {
    return { invoke: false, skipReason: 'stage-c-error' };
  }
  const rec = input.stageC.recommendation;
  if (!rec || typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) {
    return { invoke: false, skipReason: 'recommendation-missing' };
  }
  if (rec.confidence >= input.threshold) {
    return { invoke: false, skipReason: 'above-threshold', observedConfidence: rec.confidence };
  }
  return { invoke: true, observedConfidence: rec.confidence };
}

// ── Invoker contract ─────────────────────────────────────────────────────────

/**
 * Input passed to the research subagent. The subagent gets the full
 * decision context (problem, options, current Stage C recommendation) so
 * it can frame the research relative to what the framework already
 * suspects.
 */
export interface ResearchSubagentInput {
  decisionId: string;
  /** Decision summary (one-line problem). */
  summary: string;
  /** Decision body (markdown — full problem statement). */
  body?: string;
  /** Option list — `id: description` pairs. */
  options: Array<{ id: string; description: string }>;
  /** Stage C's current recommendation (the one we're skeptical of). */
  recommendation: {
    optionId: string;
    confidence: number;
    rationale: string;
  };
  /**
   * Operator-supplied research framing — overrides the default "compare
   * how widely-deployed systems handle X" prompt. Free-form text.
   */
  framing?: string;
}

/**
 * Response from the research subagent. The findings are markdown text
 * that the support surface renders verbatim. The `tokens` block drives
 * the SubscriptionLedger debit (AC#5) — production invokers populate it
 * from the LLM provider's reported usage.
 */
export interface ResearchSubagentResponse {
  /**
   * Markdown body — the surface renders this under "## Research findings"
   * on the decision view. Should include a citation list if external
   * sources were consulted.
   */
  findingsMarkdown: string;
  /** Model identifier (e.g. `claude-sonnet-4-5`). Drives ledger.model. */
  model: string;
  /** Input + output tokens — drive ledger debit. Zero is allowed (caching, retries). */
  inputTokens?: number;
  outputTokens?: number;
}

/** Invoker contract — production wires Claude Code subagent; tests inject. */
export type ResearchSubagentInvoker = (
  input: ResearchSubagentInput,
) => Promise<ResearchSubagentResponse>;

// ── Persistence layer ────────────────────────────────────────────────────────

export interface WriteResearchArtifactInput {
  workDir: string;
  decisionId: string;
  /** Findings markdown body (subagent response). */
  findingsMarkdown: string;
  /** ISO-8601 timestamp; defaults to now (tests pin for determinism). */
  now?: Date;
  /** Optional model tag — prepended to the artifact as a header comment. */
  model?: string;
  /** Optional confidence value that triggered the research (for audit). */
  observedConfidence?: number;
}

export interface WriteResearchArtifactResult {
  path: string;
  /** ISO-8601 timestamp that was embedded in the filename. */
  timestamp: string;
}

/**
 * Persist research findings to `<work-dir>/.ai-sdlc/_decisions/research/<DEC>-<ISO>.md`.
 *
 * The filename embeds the ISO timestamp (with `:` replaced by `-` for
 * filesystem portability) so multiple research invocations on the same
 * decision are preserved in chronological order. The support surface
 * lists them newest-first.
 */
export function writeResearchArtifact(
  input: WriteResearchArtifactInput,
): WriteResearchArtifactResult {
  const ts = (input.now ?? new Date()).toISOString();
  const safeTs = ts.replace(/:/g, '-').replace(/\..+$/, 'Z');
  const dir = join(input.workDir, '.ai-sdlc', '_decisions', 'research');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${input.decisionId}-${safeTs}.md`);

  const headerLines: string[] = [
    `<!-- RFC-0035 Phase 10 (AISDLC-294) — research subagent findings -->`,
    `<!-- decision: ${input.decisionId} -->`,
    `<!-- generated: ${ts} -->`,
  ];
  if (input.model) headerLines.push(`<!-- model: ${input.model} -->`);
  if (input.observedConfidence !== undefined) {
    headerLines.push(`<!-- observedStageCConfidence: ${input.observedConfidence.toFixed(3)} -->`);
  }
  const body = `${headerLines.join('\n')}\n\n${input.findingsMarkdown.trimEnd()}\n`;
  writeFileSync(path, body, 'utf8');
  return { path, timestamp: ts };
}

export interface ResearchArtifact {
  /** Absolute path on disk. */
  path: string;
  /** Embedded ISO-8601 timestamp (parsed from filename). */
  timestamp: string;
  /** Markdown body (HTML comments stripped from the header). */
  findingsMarkdown: string;
}

/**
 * Read all research artifacts for a decision id, newest-first.
 *
 * Returns an empty list when the directory does not exist (no research
 * has run yet). Malformed filenames (no embedded timestamp) are sorted
 * to the bottom rather than dropped — keeps the surface auditable.
 */
export function readResearchArtifacts(workDir: string, decisionId: string): ResearchArtifact[] {
  const dir = join(workDir, '.ai-sdlc', '_decisions', 'research');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `${decisionId}-`;
  const out: ResearchArtifact[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const tsMatch = name.slice(prefix.length, -'.md'.length);
    // The filename's `:` was replaced with `-` — best-effort restore for
    // sort ordering. We don't re-parse to a Date; lex order on the safe
    // form sorts identically to chronological order.
    const timestamp = tsMatch || statSync(path).mtime.toISOString();
    // Strip leading HTML comment block (header) from the rendered body.
    const stripped = raw.replace(/^(?:<!--[^]*?-->\s*)+/, '').trimStart();
    out.push({ path, timestamp, findingsMarkdown: stripped });
  }
  // Sort newest-first via descending lex order on the safe-ts substring.
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out;
}

// ── Runner — wires invoker + ledger + persistence ────────────────────────────

export interface RunResearchSubagentInput {
  decision: Decision;
  stageC: StageCOutput | null;
  /** Resolved threshold. */
  threshold: number;
  /** Injected invoker. Required — there is no default. */
  invoker: ResearchSubagentInvoker;
  /** Project root for artifact persistence. */
  workDir: string;
  /** Optional operator framing override (free-form prompt augmentation). */
  framing?: string;
  /**
   * RFC-0010 §14.6 SubscriptionLedger writer (AC#5). When supplied, the
   * runner debits the ledger once per successful invocation. Test stubs
   * pass a counter to assert AC-5 plumbing.
   */
  ledgerWriter?: SubscriptionLedgerWriter;
  /** Pin `now` for tests. */
  now?: Date;
}

export interface RunResearchSubagentResult {
  invoked: boolean;
  /**
   * Reason when `invoked: false`. Mirrors `shouldInvokeResearchSubagent`'s
   * gate plus the explicit `disabled` reason for the feature-flag path.
   */
  skipReason?:
    | 'stage-c-missing'
    | 'stage-c-error'
    | 'above-threshold'
    | 'recommendation-missing'
    | 'invoker-error';
  /** Artifact written to disk (when `invoked: true`). */
  artifact?: WriteResearchArtifactResult;
  /** Mirror of the invoker response (when `invoked: true`). */
  response?: ResearchSubagentResponse;
  /** Confidence value that drove the gate (for audit). */
  observedConfidence?: number;
  /** Ledger entry written (when `invoked: true` AND `ledgerWriter` supplied). */
  ledgerEntry?: SubscriptionLedgerEntry;
}

/**
 * Compose `shouldInvokeResearchSubagent` + invoker + `writeResearchArtifact` +
 * SubscriptionLedger debit into one call.
 *
 * Failure modes:
 *   - Gate skip → `invoked: false`, `skipReason` populated.
 *   - Invoker throws → `invoked: false`, `skipReason: 'invoker-error'`. The
 *     error is propagated as a return value (not re-thrown) so callers
 *     don't have to wrap; surface should render an error banner instead
 *     of a findings block.
 */
export async function runResearchSubagent(
  input: RunResearchSubagentInput,
): Promise<RunResearchSubagentResult> {
  const gate = shouldInvokeResearchSubagent({
    stageC: input.stageC,
    threshold: input.threshold,
  });
  if (!gate.invoke) {
    return {
      invoked: false,
      ...(gate.skipReason ? { skipReason: gate.skipReason } : {}),
      ...(gate.observedConfidence !== undefined
        ? { observedConfidence: gate.observedConfidence }
        : {}),
    };
  }

  // stageC is non-null when the gate said invoke; narrow for TS.
  const stageC = input.stageC!;
  const invokerInput: ResearchSubagentInput = {
    decisionId: input.decision.metadata.id,
    summary: input.decision.spec.summary,
    ...(input.decision.spec.body ? { body: input.decision.spec.body } : {}),
    options: input.decision.spec.options.map((o) => ({
      id: o.id,
      description: o.description,
    })),
    recommendation: {
      optionId: stageC.recommendation.optionId,
      confidence: stageC.recommendation.confidence,
      rationale: stageC.recommendation.rationale,
    },
    ...(input.framing ? { framing: input.framing } : {}),
  };

  let response: ResearchSubagentResponse;
  try {
    response = await input.invoker(invokerInput);
  } catch {
    return {
      invoked: false,
      skipReason: 'invoker-error',
      ...(gate.observedConfidence !== undefined
        ? { observedConfidence: gate.observedConfidence }
        : {}),
    };
  }

  const artifact = writeResearchArtifact({
    workDir: input.workDir,
    decisionId: input.decision.metadata.id,
    findingsMarkdown: response.findingsMarkdown,
    ...(input.now ? { now: input.now } : {}),
    model: response.model,
    ...(gate.observedConfidence !== undefined
      ? { observedConfidence: gate.observedConfidence }
      : {}),
  });

  // AC#5 — ledger debit. Failures swallowed (matches substrate convention).
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
      // Per substrate convention, ledger write failures should not break
      // the research run. The artifact is still on disk and the operator
      // can inspect it.
    }
  }

  return {
    invoked: true,
    artifact,
    response,
    ...(gate.observedConfidence !== undefined
      ? { observedConfidence: gate.observedConfidence }
      : {}),
    ...(ledgerEntry ? { ledgerEntry } : {}),
  };
}
