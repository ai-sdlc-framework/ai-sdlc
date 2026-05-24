/**
 * Shared classifier substrate — type definitions (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * The substrate is the framework-level keystone for OQ-2 (auto-triage),
 * OQ-3 (PR-comment auto-classify), OQ-5 (severity inference), OQ-11
 * (DoR-clarification classifier), and RFC-0035 Phase 5 (Stage C LLM
 * classifier). All 5 surfaces share one Haiku-class classifier, one
 * confidence threshold (default 0.7), one calibration corpus, and one
 * operator-override capture path. Implementing this ONCE prevents 4-5
 * duplicate pipelines and gives the calibration loop a single corpus.
 *
 * **Design**: the substrate is harness-agnostic — it accepts an
 * `LlmInvoker` interface (mirrors `SubagentSpawner` from RFC-0012). Real
 * deployments wire in an Anthropic Haiku adapter; tests inject a
 * `FakeLlmInvoker` with scripted responses. Keeping the LLM call behind
 * a thin interface keeps the substrate hermetic + harness-portable
 * (Codex, Claude SDK, Anthropic API, mock).
 *
 * @module classifier/substrate/types
 */

// ── Task types ───────────────────────────────────────────────────────────────

/**
 * The 5 task types the substrate serves. Each has its own prompt template
 * (resolved at runtime by the substrate via `task-prompts.ts`) but they
 * all flow through the SAME `classify()` entry point and write to the
 * SAME corpus aggregator — that's the architectural payoff.
 *
 * Per RFC-0024 §15 OQ resolutions:
 *   - `capture-triage`            — OQ-2: agent-supplied triage classification
 *                                    (`quick-fix-task` | `new-feature-issue` |
 *                                    `scope-extension` | `won't-fix` | `tbd`).
 *   - `capture-severity`          — OQ-5: severity inference when not supplied
 *                                    (`low` | `medium` | `high` | `critical`).
 *   - `pr-comment-is-capture`     — OQ-3: "is this PR review comment a capture?"
 *                                    Binary yes/no (`is-capture` | `not-capture`).
 *   - `dor-answer-is-new-concern` — OQ-11: DoR clarification-answer segmentation
 *                                    (`clarification` | `new-concern` | `ambiguous`).
 *   - `decision-recommendation`   — RFC-0035 Stage C: recommend an option from
 *                                    the decision's option list (returns the
 *                                    option id as classification).
 */
export type ClassifierTaskType =
  | 'capture-triage'
  | 'capture-severity'
  | 'pr-comment-is-capture'
  | 'dor-answer-is-new-concern'
  | 'decision-recommendation';

/** All task types as a readonly tuple — exported for runtime iteration. */
export const ALL_TASK_TYPES: readonly ClassifierTaskType[] = Object.freeze([
  'capture-triage',
  'capture-severity',
  'pr-comment-is-capture',
  'dor-answer-is-new-concern',
  'decision-recommendation',
] as const);

// ── Public input + output ────────────────────────────────────────────────────

/**
 * Free-form input to the classifier. The substrate doesn't interpret these
 * fields semantically — it stitches them into the task-type prompt template.
 *
 * `text` is the primary signal (the capture finding, the PR comment body,
 * the DoR answer segment, the decision-option list). `context` is optional
 * metadata that prompts may include (PR title, repo name, surrounding
 * comment thread, etc.) — kept loose because each task type's prompt
 * shape differs.
 *
 * Callers from OQ-3 (PR comments) typically populate `text` with the
 * comment body and `context.author`, `context.prTitle`. RFC-0035 Stage C
 * callers populate `text` with the decision summary and
 * `context.options` with the option list. The substrate is callsite-
 * agnostic; the prompt template handles the per-task contract.
 */
export interface ClassifierInput {
  /** Primary signal — the text the classifier evaluates. */
  text: string;
  /** Optional structured context the prompt may include. */
  context?: Record<string, unknown>;
}

/**
 * Per-call overrides + dependency injection. None are required — sensible
 * defaults apply.
 *
 * `threshold` overrides the global 0.7 default for this single call
 * (e.g. a security reviewer wanting stricter classification can pass
 * 0.85). `invoker` overrides the global LLM adapter (tests inject a
 * `FakeLlmInvoker`). `repoRoot` overrides the cwd-walk default used to
 * locate `capture-config.yaml` / `decisions-config.yaml`. `corpusDir`
 * overrides the corpus write path (tests use a tmpdir).
 */
export interface ClassifyOpts {
  /** Per-call confidence threshold override (default: per-org config or 0.7). */
  threshold?: number;
  /** LLM invoker injection (tests + alternative harnesses). */
  invoker?: LlmInvoker;
  /** Project root for config resolution. */
  repoRoot?: string;
  /** Corpus directory override (defaults to `.ai-sdlc/classifier-corpus/`). */
  corpusDir?: string;
  /**
   * The model identifier (e.g. `'claude-haiku-4-5'`). When omitted, the
   * substrate consults per-org config; when no config is found, defaults
   * to `'claude-haiku-4-5'` (the Haiku-class default per task spec).
   */
  model?: string;
  /**
   * SubscriptionLedger writer — called once per classification with the
   * token costs the invoker reported. Optional because tests don't always
   * care; production callers wire a real ledger writer.
   */
  ledgerWriter?: SubscriptionLedgerWriter;
  /**
   * When true, the substrate does NOT append a calibration corpus entry
   * for this call. Useful when the caller wants to dry-run a
   * classification (e.g. a TUI preview) without polluting the corpus.
   * Default: false (corpus capture is on).
   */
  skipCorpus?: boolean;
  /**
   * Optional agent-role identifier used for per-agent threshold lookup
   * (RFC-0024 OQ-2 / OQ-5 — AISDLC-275 AC-4). When the config block
   * defines `classifier.perAgentRole[<role>].threshold`, that value takes
   * precedence over per-task / global thresholds (but per-call
   * `opts.threshold` still wins overall). Free-form string so the
   * substrate doesn't pin to capture-side `AgentRole`; callers from
   * other surfaces (RFC-0035 Stage C) can pass their own role
   * identifiers.
   */
  agentRole?: string;
}

/**
 * Result of `classify()`. The `classification` field's domain depends on
 * `taskType`; the substrate does not constrain it (each task type has its
 * own valid set; callers validate against their own enum).
 *
 * `confidence` is the LLM's self-reported confidence in [0, 1]. The
 * caller compares against `threshold` to decide auto-apply vs queue-for-
 * operator. `reasoning` is the LLM's short explanation — surfaced in
 * TUI / PR comments as the "AI rationale" hover.
 *
 * `metBehindThreshold` is a derived boolean — true iff `confidence >=
 * effectiveThreshold`. Callers can use it directly or recompute; we
 * expose both fields so the contract is unambiguous.
 *
 * `effectiveThreshold` is the threshold that was actually applied (per-
 * call override > per-org config > 0.7 default). Surfaced so audit logs
 * + TUI can show "AI suggested X with confidence 0.62, threshold was 0.7".
 *
 * `corpusEntryId` is the id of the corpus entry written (or `null` when
 * `skipCorpus: true`). Callers use this id with `recordOperatorOverride()`
 * to mark a later operator override as a negative exemplar.
 */
export interface ClassifierDecision {
  classification: string;
  confidence: number;
  reasoning: string;
  metBehindThreshold: boolean;
  effectiveThreshold: number;
  corpusEntryId: string | null;
  /**
   * The model that produced this decision (for audit + future-proofing
   * against model drift). Resolved from `opts.model > config > default`.
   */
  model: string;
}

// ── LLM invoker abstraction ──────────────────────────────────────────────────

/**
 * Inputs to the LLM invoker. The substrate has already resolved the
 * prompt template + the per-call overrides into this shape; the invoker's
 * only job is to call the LLM and return a structured response.
 */
export interface LlmInvocationRequest {
  /** Model identifier (e.g. `'claude-haiku-4-5'`). */
  model: string;
  /** Fully-resolved prompt text (system + user concatenated by caller). */
  prompt: string;
  /** Task type tag (for invoker-side logging / per-task model overrides). */
  taskType: ClassifierTaskType;
  /** Optional max output tokens — invokers may clamp. */
  maxOutputTokens?: number;
}

/**
 * Structured response from the LLM. The invoker is responsible for
 * coaxing the model into emitting valid JSON; the substrate parses that
 * JSON into this shape.
 *
 * `classification` is the LLM's choice (free-form string — the substrate
 * does not constrain). `confidence` is in [0, 1]. `reasoning` is one or
 * two sentences explaining the choice. `inputTokens` / `outputTokens`
 * drive SubscriptionLedger accounting; invokers SHOULD populate them but
 * MAY leave them as 0 when the harness doesn't surface counts.
 */
export interface LlmInvocationResponse {
  classification: string;
  confidence: number;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Interface for invoking a Haiku-class LLM. Production wires this to the
 * Anthropic SDK; tests inject `FakeLlmInvoker` (in `fake-invoker.ts`).
 *
 * The invoker may throw — the substrate catches and converts to a
 * fall-open low-confidence decision (`{classification:'pending',
 * confidence:0,...}` per task type's pending sentinel) so the caller can
 * decide whether to surface the error or fall back to a manual prompt.
 */
export interface LlmInvoker {
  invoke(req: LlmInvocationRequest): Promise<LlmInvocationResponse>;
}

// ── Corpus + override capture ────────────────────────────────────────────────

/**
 * One calibration-corpus entry. Written to
 * `<repoRoot>/.ai-sdlc/classifier-corpus/<task-type>.yaml` (YAML list)
 * per AC-4. Per-task-type segmentation so the calibration loop can train
 * per-domain (a capture-triage exemplar doesn't help a
 * decision-recommendation classifier).
 *
 * `polarity: 'positive'` — the LLM's classification was confirmed (silence
 * within the override window means "positive exemplar" per AC-7).
 * `polarity: 'negative'` — the operator overrode the LLM's classification
 * within the override window (per AC-6).
 * `polarity: 'pending'` — the override window has not yet expired; the
 * entry is shadow until the window resolves.
 *
 * The aggregator (`cli-classifier corpus aggregate`) reads these entries
 * + computes per-task-type accuracy + emits the training corpus.
 */
export interface CalibrationCorpusEntry {
  /** Stable id — UUIDv4 string. Used as the corpus-entry id callers reference. */
  id: string;
  /** ISO-8601 timestamp the entry was written. */
  timestamp: string;
  /** Task type — selects which corpus file the entry lands in. */
  taskType: ClassifierTaskType;
  /** Input text + context the LLM saw (pre-prompt-stitching). */
  input: ClassifierInput;
  /** The model that produced the classification. */
  model: string;
  /** The LLM's classification choice. */
  classification: string;
  /** The LLM's self-reported confidence. */
  confidence: number;
  /** The LLM's reasoning. */
  reasoning: string;
  /** Effective threshold at decision time (per-org / per-call). */
  threshold: number;
  /** Did the confidence meet/exceed the threshold? */
  metBehindThreshold: boolean;
  /**
   * Resolution polarity per AC-6 / AC-7.
   * - `pending`  — within the override window; outcome not yet known.
   * - `positive` — silence within the window → classification confirmed.
   * - `negative` — operator overrode within the window → wrong answer.
   */
  polarity: 'pending' | 'positive' | 'negative';
  /**
   * When `polarity === 'negative'`, the classification the operator
   * picked instead. Recorded so the corpus has both the wrong answer +
   * the right answer for supervised retraining.
   */
  operatorOverrideClassification?: string;
  /** Optional override reason supplied by the operator. */
  operatorOverrideReason?: string;
  /** ISO-8601 timestamp the override was recorded (`negative` only). */
  operatorOverrideTimestamp?: string;
}

// ── Subscription cost tracking ───────────────────────────────────────────────

/**
 * SubscriptionLedger writer signature (per AC-9 + RFC-0010 §14.6).
 * Production wires this to the orchestrator's `SubscriptionLedger.append()`
 * (or the equivalent pipeline-cli adapter); tests inject a no-op or
 * counter.
 *
 * The substrate calls this ONCE per `classify()` invocation, after the
 * LLM has responded. The harness id is the LLM provider's plan/account
 * tag (e.g. `'anthropic-haiku-prod'`) — left as a free-form string so
 * the same substrate can serve multiple harnesses without coupling to
 * the orchestrator's enum.
 */
export type SubscriptionLedgerWriter = (entry: SubscriptionLedgerEntry) => Promise<void> | void;

/** One ledger entry — what `classify()` reports per invocation. */
export interface SubscriptionLedgerEntry {
  /** ISO-8601 timestamp of the LLM call. */
  timestamp: string;
  /** Task type tag — for per-task budget tracking. */
  taskType: ClassifierTaskType;
  /** Model identifier — for per-model budget tracking. */
  model: string;
  /** Tokens consumed (input + output) — what the LLM reported. */
  inputTokens: number;
  outputTokens: number;
}
