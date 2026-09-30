---
id: RFC-0049
title: System One Judgment Layer (Typed-Question Provider Adapter, Jev First)
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-09-30
updated: 2026-09-30
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0004, RFC-0010, RFC-0011, RFC-0016, RFC-0019, RFC-0024, RFC-0035, RFC-0042, RFC-0043, RFC-0046, RFC-0048]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: '2026-11-30'
---

# RFC-0049: System One Judgment Layer (Typed-Question Provider Adapter, Jev First)

**Status:** Signed Off (2026-09-30, Engineering + Operator) — **all 7 Open Questions
resolved via operator rubric walkthrough.** Resolutions: **(OQ-1)** judgments may relax review on
trusted-`sourceKind` work only, limited in v1 to selecting the merged two-reviewer set
(AISDLC-617) per PR, with `security-reviewer` always run and the path regex as a veto;
untrusted work is tighten-only; **(OQ-2)** naming a provider enables `work-item-text`
egress only, `code-diff` and `agent-output` are listed explicitly; **(OQ-3)** interface
plus a thin `fetch` Jev adapter in `reference/src/judgment/`, no vendor SDK dependency;
**(OQ-4)** promotion is tiered by risk: seam and tighten-class judgments promote by
corpus or documented operator override, relax-class judgments are corpus-only (n ≥ 50
from the AISDLC-616 ledger, act-band precision ≥ 95%); **(OQ-5)** v1 also ships a
generic OpenAI-compatible adapter, shadow-only (operator selected this over the
Jev-only recommendation). **Amended 2026-09-30 (capability liveness, section 9):**
**(OQ-6)** the four `Implemented` RFCs whose model-backed parts never ran keep their
lifecycle and gain a machine-checked `runtimeEvidence` block per capability;
**(OQ-7)** a required capability that reports degraded fails doctor and files a
Decision, and blocks nothing. Phase tasks AISDLC-629 to AISDLC-647.

> No live Jev call has been made yet (the API key is pending), so every performance
> and accuracy figure quoted from the vendor documentation is a hypothesis to be
> measured in AISDLC-641, not a result.

## Summary

Add one new rung to the framework's evaluation ladder: a **judgment layer** that
answers closed-set questions (pick one of N, rate on an ordered rubric, yes/no) with a
probability distribution, in one fast HTTP call, without generating text. The layer is
provider-neutral (`JudgmentProvider`, modelled on RFC-0019's `EmbeddingAdapter`). The
primary adapter is **Jev**, typesafe.ai's "System One" model; a generic
OpenAI-compatible adapter ships alongside it in `shadow` for adopters who cannot use a
new vendor.

The layer does three jobs. It is the production backend for judgment seams the
framework already specified and typed but never wired (the classifier substrate, the
Decision Catalog's placeholder dimensions, estimation class assignment). It sits in
front of the expensive generative agents as a cheap gate (readiness, acceptance-criteria
coverage, finding grounding) so fewer agent runs are wasted. And it replaces the
keyword and regex heuristics that currently stand in for semantic judgment. Code keeps
the control flow, generative agents keep generation, reviewers keep the attested
verdict, and the operator keeps decisions. Every judgment ships in `shadow` mode and is
promoted to `enforce` one at a time on measured evidence.

The RFC also closes the process gap that let those seams sit unwired for months without
anyone noticing (section 9, **capability liveness**): every optional capability reports
whether it ran live, in shadow or degraded; doctor and the RFC lifecycle gate read that
record; task follow-ups must be filed, not written as prose; and stub implementations
reachable from production code are flagged.

## Motivation

### The work, decomposed

Everything the pipeline does falls into one of four kinds:

| Kind | Examples | Right tool |
| --- | --- | --- |
| Mechanics | git, CI, signing, arithmetic, sort order, merge eligibility | Code |
| Generation | writing code, review prose, clarification questions | Generative LLM agent |
| Closed-set judgment | classify, score, detect, route, match, verify | **Nothing fits well today** |
| Stakes-bearing decision | OQ resolution, merge policy, budget approval | Human, via the Decision Catalog |

The third row is the gap. A generative LLM can make these judgments, but it is the
wrong shape: it writes prose that code must parse back into an enum, it costs a full
agent invocation, and its self-reported confidence is not a probability. So the
framework has handled closed-set judgment in three unsatisfying ways.

### What the code does today

An inventory of the current tree (file references in [References](#references)):

1. **Typed seams with no production backend.** The design anticipated an LLM here and
   built the socket, but nothing is plugged in.
   - The classifier substrate (`pipeline-cli/src/classifier/substrate/`) serves five
     task types from RFC-0024 and RFC-0035 (`capture-triage`, `capture-severity`,
     `pr-comment-is-capture`, `dor-answer-is-new-concern`, `decision-recommendation`).
     Its only `LlmInvoker` implementations are a test fake and an env-var module
     loader. With no invoker, every call returns the `pending` sentinel at confidence 0.
   - Decision Catalog Stage B hard-codes `novelty = 0.5` and
     `exemplarSimilarity = 0.5` as placeholders for LLM calls that were never added
     (`pipeline-cli/src/decisions/stage-b.ts`).
   - `createPipelineLLMEvaluator()` returns a stub (`orchestrator/src/policy-evaluators.ts`).
   - SA Layer 3's `LLMClient`, estimation Stage B's `StageBInvoker`, and
     `metaReview`'s `callLLM` have no production implementation.
2. **Keyword and regex heuristics standing in for meaning.** Estimation class
   assignment is a title-prefix regex whose own comment calls it a "Phase 1 stand-in
   for the §6.1 LLM classifier". Decision pillar tagging matches substrings such as
   `'ci'`, `'ui'` and `'api'` inside longer words. Reversibility is a list of 14
   phrases. Admission scoring reduces soul alignment to a label lookup. The review
   classifier picks reviewers with a path regex.
3. **Generative agents doing yes/no work.** DoR Stage B is designed to spend a
   subagent run (RFC-0011 estimates about 30 s and $0.001 to $0.005) to answer one
   binary question per gate; in practice it is not run (see the evidence below), so the
   two semantic gates are skipped on every task. Review and triage runners ask for JSON, strip code fences with a regex,
   `JSON.parse` the remainder and fail closed when that breaks.

**Runtime evidence (operator machine, inspected 2026-09-30).** The seams in (1) are
reachable code with real callers, so the dark-code gate passes them, but they have
never produced a model-backed answer in this repository:

| Surface | Evidence |
| --- | --- |
| Classifier substrate | The only corpus file (`pr-comment-is-capture.yaml`) holds 5 entries; all 5 are `classification: pending` with `reasoning: (invoker error: no invoker supplied)`. `AI_SDLC_CLASSIFIER_INVOKER_MODULE` is set nowhere. |
| DoR Stage B | 158 logged evaluations (2026-05-06 to 2026-06-12), 1,106 gate verdicts, all `stage: A`; gates 4 and 6 are `skip` in 158 of 158. No production caller passes a spawner to `evaluateIssueE2E`. |
| Decision Catalog Stage C | 20 decision events: 11 opened, 9 operator-answered, none from a recommendation. |

**Why they stayed empty.** The documented cause is a deliberate constraint plus an
unfiled follow-up. AISDLC-321 and AISDLC-275 ruled that `pipeline-cli` must not depend
on the Anthropic SDK, so the model call sits behind an interface and an env-var module
loader that "falls open silently on every failure mode". AISDLC-289 recorded under
Follow-up that Stage C "runs without a real invoker today" and that the orchestrator
"should inject the Anthropic Haiku adapter"; no task was filed for it. Every gate
passed honestly: tests use the fake invoker, reviewers approved code that did what its
task said, and fail-open means nothing visibly breaks.

A contributing factor, which is this RFC's inference and not a documented decision, is
that wiring a generative model there was never attractive: a `claude -p` call from
deterministic code draws the Agent SDK credit pool rather than interactive
subscription quota (RFC-0041 §4.1), and a 30-second agent spawn is too slow for an
orchestrator tick.

**Process lesson carried into this RFC.** "Done" for these seams was defined as tests
and reviews, not an observed effect at runtime. The judgment log (section 7) and the
live validation task (AISDLC-641) exist so that each judgment's first real answer is a
recorded, checkable event.

### What changes the calculation

Jev's documented profile (docs.typesafe.ai, `jev-1.13.0`, read 2026-09-30) is different
in the four ways that matter here:

| Property | Documented | Why it matters to this framework |
| --- | --- | --- |
| Output | Typed answer plus a probability per option; never text | No prompt-and-parse, no fence stripping, no malformed-JSON branch |
| Batching | Many questions against one state in one request, evaluated independently | All seven DoR gates, or every classification an admission needs, in one round trip |
| Latency | "Most queries complete in about 100 ms" | Fits inside an orchestrator tick and a pre-push hook |
| Price | $0.042 per million input tokens; output tokens free | About 19x below the Haiku input rate and 71x below the Sonnet input rate in `DEFAULT_MODEL_COSTS` |

It also documents its own limits, which shape the design as much as its strengths:
32k tokens of state per request (64k including all questions); text only; English
primary; unreliable at counting, arithmetic and date comparison; literal reading of
instructions; accuracy drops as irrelevant state grows; and state content written to
steer the model can move its answer. Calibration is a property of groups of
predictions, not a guarantee about any single answer.

### Where the cost saving actually comes from

Classification calls are a small share of pipeline spend. RFC-0015 §12 puts a task at
about four LLM calls and 200k tokens, nearly all of it the developer and the three
reviewers. Moving a classifier from Haiku to Jev saves fractions of a cent. The
leverage is second-order: a cheap, fast gate placed in front of an expensive agent
avoids whole agent runs.

- A task that is not ready is stopped before the developer run, in milliseconds.
- A developer return that does not cover its acceptance criteria is caught before
  three reviewers are spawned on it.
- A reviewer finding that cites code which does not say what the finding claims is
  flagged before it triggers an iterate loop.
- Capture triage and Decision Catalog recommendations that today fall to `pending`
  stop queuing for the operator, which is the scarcest resource in the system.

Those four are the RFC's value hypothesis. The live evaluation (AISDLC-641) measures them.

## Goals

1. Define a provider-neutral `JudgmentProvider` interface with three question types
   (choice, score, noul), a Jev adapter behind it, and a generic OpenAI-compatible
   adapter for adopters without a typesafe.ai account.
2. Put every question, threshold and composition rule in one reviewable place (the
   **Judgment Catalog**), versioned and content-hashed.
3. Give every judgment the same three-outcome contract: **act**, **escalate** to the
   next rung, or **abstain** to the existing default.
4. Wire the dormant seams (classifier substrate, Decision Catalog Stage B, estimation
   class assignment) to the layer without changing their fail-open behaviour.
5. Add cheap gates in front of the expensive agents: DoR Stage B, acceptance-criteria
   coverage, reviewer-finding grounding.
6. Ship a shadow-mode evaluation harness so each judgment is promoted on measured
   agreement with labelled outcomes, never on vendor claims.
7. Keep the framework fully functional with no provider configured. The layer is
   opt-in for adopters.
8. Make silent degradation impossible to miss: an optional capability that falls back
   is counted and reported, and an RFC cannot be marked `Implemented` while one of its
   capabilities has never run live.

## Non-Goals

- **Replacing generative agents.** Jev cannot write code, review prose or a
  clarification question. Developer and reviewer subagents are unchanged.
- **Attested review.** A judgment answer never becomes a transcript leaf, never
  counts toward `independenceTier`, and never sets `approved`. RFC-0042, RFC-0046 and
  RFC-0047 are untouched. RFC-0042's forgery argument is economic (faking a review
  transcript costs another LLM run); a cheap non-generative call gives that argument
  nothing, and it produces no reviewable transcript.
- **Replacing deterministic policy.** Verdict aggregation, merge eligibility
  (RFC-0048), trust classification (RFC-0043 Stage 0), the failure playbook
  (RFC-0015 §5.1), model-selection tables (RFC-0004 §3), language detection
  (RFC-0030 §13.2) and docs-only path detection stay as code.
- **Arithmetic, counting, dates.** Anything code can compute exactly stays in code.
- **Similarity as a metric.** RFC-0019 §14.3 rejected an LLM as a distance oracle.
  Clustering stays on BM25 and embeddings. The layer only confirms or rejects a
  shortlisted pair, which is a classification, not a distance.
- **PPA and soul-alignment scores in `enforce`.** The Product pillar owns those
  scores (RFC-0005, RFC-0008). Judgments may run against them in `shadow` to collect
  evidence; promotion needs a separate Product-signed decision.
- **Calls from inside the RFC-0043 reviewer sandbox.** The inference proxy allowlist
  (`api.anthropic.com`, `api.openai.com`) is not extended.
- **A second scoring vocabulary in the verdict contract.** RFC-0043 deliberately has
  no `confidenceScore`. Judgment output lives in its own log, beside the verdict.

## Proposal

### 1. Placement in the evaluation ladder

RFC-0029 Principle 2 orders every evaluation as deterministic first, structural
second, LLM last, each layer handling only what the one below cannot. This RFC keeps
that order and inserts one rung:

```
deterministic  →  structural  →  SYSTEM ONE JUDGMENT  →  generative LLM  →  human
(regex, links)    (BM25, AST)    (typed, ~100 ms)        (agent run)        (Decision)
```

The new rung is closer to the layers below it than to the one above: its output is
typed by construction, it is documented as stable across repeated calls, and it costs
little enough to run on every item. It handles what the structural layer cannot decide
and passes what it is unsure of upward. It MUST NOT be used where a deterministic or
structural check already decides the question.

### 2. The provider interface

Lives in `reference/src/judgment/`, because both `pipeline-cli` and `orchestrator`
depend on `@ai-sdlc/reference` and on nothing else in common.

```ts
export type Entry = string | JsonObject | JsonValue[] | null;

export type JudgmentQuestion =
  | { type: 'choice'; instructions: Entry; options: Record<string, Entry> }   // ≤ 255 options
  | { type: 'score'; instructions: Entry; levels: Entry[] }                    // 2–10 ordered levels
  | { type: 'noul'; instructions: Entry; criteria?: { true?: Entry; false?: Entry } };

export type JudgmentAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: number[]; confidence: number }
  | { type: 'noul'; probability: number };                                     // P(yes); no separate confidence

export interface JudgmentRequest {
  state: JsonValue;                                   // string, object or array of text
  questions: Record<string, JudgmentQuestion>;        // ids are for code; not sent to the model
  consumerLabel: string;                              // cost-attribution tag, e.g. 'dor.stage-b'
}

export interface JudgmentResponse {
  answers: Record<string, JudgmentAnswer>;
  modelVersion: string;                               // versioned id the provider reports, e.g. 'jev-1.13.0'
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface JudgmentProvider {
  readonly name: string;                              // 'jev'
  readonly modelId: string;
  readonly capabilities: JudgmentCapabilities;        // limits, billingModel, inputCostPer1MTokens,
                                                      // calibratedProbabilities: boolean
  readonly requires: { envVar: string };              // 'TYPESAFE_API_KEY'
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  getAccountId(): Promise<string | null>;             // one-way hash, as in RFC-0019
  evaluate(req: JudgmentRequest): Promise<JudgmentResponse>;
}
```

The Jev adapter posts to `POST https://api.typesafe.ai/v1/systemone` with a bearer key
and an injectable `fetch`, following the in-repo `HttpDepparseClient` pattern: typed
error kinds, a per-attempt timeout (default 10 s), and retry with backoff on `429` and
`529` honouring `retry-after`. It uses no vendor SDK (OQ-3). A `FakeJudgmentProvider`
replays recorded fixtures for hermetic tests. A registry mirrors
`registerEmbeddingAdapter`.

**The OpenAI-compatible adapter (OQ-5).** A second adapter, `openai-compatible`, posts
the same state and questions to any chat-completions endpoint (`baseUrl`, `model` and
an optional key env var in config; this covers Ollama, OpenAI and compatible gateways).
It asks for a JSON object with one entry per question, validates every answer against
the question's option set, and maps the result to `JudgmentAnswer`. A missing,
malformed or out-of-set answer fails the whole call, which the runtime turns into
`abstain`. Its probabilities are derived from the model's self-report, or from token
log-probabilities where the endpoint returns them, so it declares
`calibratedProbabilities: false`. In v1 every judgment on this adapter runs in
`shadow` only; promoting any of them is a separate operator decision outside this RFC.
A local endpoint (Ollama) involves no third-party egress.

### 3. The Judgment Catalog

Every judgment is one definition in one directory (`reference/src/judgment/catalog/`),
so a reviewer can read every question and threshold the framework asks without
searching call sites.

```ts
export interface JudgmentDefinition<I, D> {
  id: string;                       // 'dor.stage-b', 'capture.triage', 'review.finding-grounding'
  version: number;                  // bump on any change to questions or composition
  egressClass: 'work-item-text' | 'code-diff' | 'agent-output';
  direction: 'tighten-only' | 'bidirectional';
  riskClass: 'seam' | 'tighten' | 'relax';               // selects the promotion bar (section 8)
  buildState(input: I): JsonValue;                        // pure; selects only what the questions need
  questions(input: I): Record<string, JudgmentQuestion>;
  compose(
    answers: Record<string, JudgmentAnswer>,
    input: I,
    thresholds: Thresholds,
    ctx: { permissiveAllowed: boolean },                  // false ⇒ never decide in the permissive direction
  ): JudgmentOutcome<D>;
  agrees?(decision: D, label: unknown): boolean;          // used by `cli-judgment eval`
}

export type JudgmentOutcome<D> =
  | { kind: 'act'; decision: D }
  | { kind: 'escalate'; to: 'llm' | 'operator'; reason: string; partial?: Partial<D> }
  | { kind: 'abstain'; reason: string };
```

Authoring rules, taken from the provider's guidance and its documented failure modes:

- One narrow judgment per question. A broad question is split and recombined in
  `compose` with weights held in code.
- Every question that shares a state goes in one request, including speculative ones
  the code may ignore.
- `buildState` sends only the fields the questions reference. It MUST keep the
  request inside the provider's state budget, by selection or by splitting the input
  into several requests in code; it MUST NOT truncate silently.
- A Choice includes an explicit none-of-these option whenever the option list may not
  cover the input.
- No question asks for a count, a sum, a date comparison or a number to be
  interpolated between score levels.
- A threshold tuned on one question type is never reused on another.
- `compose` is a pure function. The same answers and thresholds always yield the same
  outcome.

`questionSetHash` is the SHA-256 of the canonical JSON of a definition's questions for
a fixed probe input plus its `version`. It is logged with every evaluation.

### 4. Runtime contract

`evaluateJudgment(definition, input, opts)` never throws and resolves as follows:

| Condition | Result |
| --- | --- |
| No provider configured, or the judgment's mode is `off` | `abstain('disabled')`, no call made |
| The judgment's `egressClass` is not allowed by config | `abstain('egress-not-permitted')`, no call made |
| Provider error, timeout, or an answer missing from the response | `abstain('provider-error')` |
| The input exceeds the provider's state budget | `abstain('state-too-large')`, no call made |
| Mode `shadow` | Call is made and logged; caller receives `abstain('shadow')` and uses its existing path |
| Mode `enforce` | Caller receives the outcome from `compose` |

A judgment configured as `enforce` runs as `shadow` instead, with the reason logged,
when any of these holds: the model is an alias rather than an exact version; the
provider declares `calibratedProbabilities: false`; no thresholds exist for the active
`(provider, model)`; or the config carries no promotion record that satisfies the
judgment's `riskClass` bar (section 8). The bar is therefore enforced by code, not by
convention.

`abstain` always means "do what you did before this RFC". Every integration in this
RFC keeps its current default on abstain: the substrate's `pending` sentinel, DoR's
existing Stage A result or subagent path, all three reviewers, the regex class.

**Asymmetric authority.** Each definition declares a `direction`:

- `tighten-only` judgments may add scrutiny (add a reviewer, raise a flag, send an
  item to the operator, request an extra check). They may never remove a reviewer,
  lower a severity, drop a finding, mark a gate passed that a deterministic stage
  failed, or approve anything.
- `bidirectional` judgments may also decide in the permissive direction. For work
  whose `sourceKind` is not the trusted internal-backlog kind (`'backlog'`; RFC-0048
  OQ-2), every judgment is treated as `tighten-only` regardless of its declaration.

The runtime passes `permissiveAllowed` to `compose`, true only for a `bidirectional`
definition on trusted work. Each definition names which of its outcomes are permissive
(for example a `won't-fix` triage class, a `not-capture` answer, a `reversible`
classification, a passed gate). With `permissiveAllowed` false, `compose` returns
`escalate` in place of any permissive outcome, so a steered answer cannot dismiss,
downgrade or wave through anything on untrusted input.

Each definition also declares a `riskClass`, which selects its promotion bar:
`seam` (the only alternative is a `pending` sentinel and every action is reversible),
`tighten` (a wrong answer costs extra scrutiny) or `relax` (a wrong answer reduces
review of code that merges). Exactly one `relax` judgment exists in v1,
`review.reviewer-set` (OQ-1).

The reason is the provider's own disclosure that adversarial content in the state can
move an answer. Tighten-only bounds what a steered answer can do to "more review than
necessary".

**Reproducibility.** `enforce` mode requires an exact model version in config
(`jev-1.13.0`); the aliases `jev-latest` and `jev-preview` are accepted only in
`shadow`. Thresholds and promotion records are keyed by `(provider, model)`, so they
never carry from one provider or version to another. Each evaluation logs the provider-reported `modelVersion`, the
`questionSetHash`, a hash of the state, every probability, the thresholds in force and
the outcome. An optional content-addressed cache keyed on
`(modelVersion, questionSetHash, stateHash)` returns the stored answers on a repeat
evaluation, which makes re-runs of the same input free and byte-stable. Changing the
pinned version resets every judgment to `shadow` until it is re-evaluated.

### 5. Integration surfaces

Grouped by what they replace. Primitive mapping is a starting point; the questions
themselves are written and tuned in the phase that ships each group.

**Group A: dormant seams (no incumbent to regress).**

All Group A judgments are `riskClass: seam`. Every judgment in Groups B and C is
`riskClass: tighten` except `review.reviewer-set`, which is `relax`. (`dor.stage-b` can
pass a gate, but a wrong pass costs a wasted developer run, not reduced review, so it
is `tighten`.)

| Judgment id | Seam today | Shape | Escalates to |
| --- | --- | --- | --- |
| `capture.triage` | substrate `capture-triage` | Choice over the substrate's triage enum | operator (`pending`) |
| `capture.severity` | substrate `capture-severity` | Choice over `low/medium/high/critical` | operator |
| `capture.pr-comment` | substrate `pr-comment-is-capture` | Noul | operator |
| `dor.answer-segment` | substrate `dor-answer-is-new-concern` | Choice over `clarification/new-concern/ambiguous` | operator |
| `decision.recommendation` | substrate `decision-recommendation` | Choice over the decision's option ids | operator |
| `decision.reversibility` | 14-phrase substring list | Choice over `reversible/one-way/unknown` | operator |
| `decision.pillars` | keyword `includes()` | One Noul per pillar (several may apply) | operator |
| `decision.duplicate` | Levenshtein shortlist | One Noul per shortlisted pair | operator |
| `decision.stage-b-signals` | `novelty` and `exemplarSimilarity` hard-coded to 0.5 | Two Scores against the exemplar set | the 0.5 constants |
| `estimate.class` | title-prefix regex | Choice over `bug/feature/chore/uncategorized` | regex result |

The substrate's `LlmInvoker` receives only a rendered prompt string and returns one
label and one confidence. The bridge adds a structured variant that receives the
`ClassifierInput` and returns the full distribution, and keeps the existing interface
working. The existing 0.7 thresholds were chosen for LLM self-reported confidence and
are not carried over; each judgment's thresholds are set from its evaluation run.

**Group B: gates in front of expensive agents.**

| Judgment id | Replaces or precedes | Shape | Direction |
| --- | --- | --- | --- |
| `dor.stage-b` | `refinement-reviewer` subagent for the yes/no part of each gate | One Noul per gate, one request | bidirectional on trusted work |
| `dev.ac-coverage` | nothing today; runs after Step 6, before reviewer fan-out | One Noul per acceptance criterion against the diff | tighten-only |
| `review.finding-grounding` | the unwired `metaReview` hook | Per finding: Choice over `supports/contradicts/unrelated` for the cited code | tighten-only |

`dor.stage-b` makes the semantic gates (4, scope; 6, done-state) run for the first
time in production. The judgment decides pass, fail or unsure per gate. When a caller
supplies a spawner, a fail or unsure escalates to the `refinement-reviewer`, because
writing a tailored clarification question is generation. When no spawner is supplied,
which is every production path today, a fail yields `needs-clarification` for that gate
with a templated question built from the gate's own wording (a tightening action, so
allowed on any `sourceKind`), and an unsure leaves the gate at `skip` exactly as now. `dev.ac-coverage` and
`review.finding-grounding` are advisory in v1: they annotate the judgment log, the PR
body and the operator surface, and do not change a verdict.

**Group C: heuristics with a working incumbent (shadow first, promotion optional).**

| Judgment id | Incumbent | Shape | Direction |
| --- | --- | --- | --- |
| `review.routing` | path regex in `classifier.ts` | Nouls such as "touches authentication or secrets handling" | tighten-only: may add a reviewer the regex missed |
| `review.reviewer-set` | global opt-in in `reviewer-set.ts` (AISDLC-617) | Nouls for each risk signal that argues for separate code and test review | relax, trusted work only (see below) |
| `complexity.factors` | factors "assumed supplied" to `complexity.ts` | Nouls and Scores for `securitySensitive`, `apiChange` and similar; the existing formula combines them | tighten-only: may raise a factor the incumbent missed, never lower one |
| `failure.class` | binary heuristic (RFC-0025) | Choice over the four RFC-0025 classes, applied only to failures the RFC-0015 playbook left as `UnknownFailureMode` | tighten-only: labels for the operator |
| `triage.injection-screen` | none before `SecurityTriageRunner` | Nouls per hazard on untrusted issue and comment text | tighten-only |

**`review.reviewer-set` (OQ-1).** Today the merged two-reviewer set
(`correctness-reviewer` + `security-reviewer`) is a repo-wide opt-in. This judgment
makes the choice per PR. It selects the merged set only when all of the following
hold; otherwise `resolveReviewerSetMode()` decides exactly as it does today:

1. The judgment is in `enforce` (corpus-only promotion, section 8).
2. The work item's `sourceKind` is the trusted internal-backlog kind.
3. The deterministic path classifier raises no objection (no auth, lockfile or CI
   path match). A regex match is a veto the judgment cannot override.
4. Every risk-signal Noul is below its threshold.

`security-reviewer` runs in every case, and no judgment selects fewer reviewers than
the merged set. The selection and its inputs are recorded in the judgment log; the
attestation pipeline is unchanged because the merged set is already a supported
reviewer set.

### 6. Configuration

`.ai-sdlc/judgment-config.yaml`, schema `spec/schemas/judgment-config.v1.schema.json`,
read from the trusted base branch only (the RFC-0048 OQ-2 rule: a PR cannot relax the
configuration it is governed by).

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: JudgmentConfig
metadata:
  name: ai-sdlc-judgment
spec:
  provider: jev                 # omit the file or this key ⇒ the layer is disabled
  model: jev-1.13.0             # exact version required for any judgment in enforce
  egress:
    allow: [work-item-text]     # the default when a provider is named (OQ-2);
                                # add code-diff / agent-output explicitly
  defaults:
    mode: shadow                # off | shadow | enforce
    timeoutMs: 10000
    cache: true
  judgments:
    dor.stage-b:
      mode: shadow
      thresholds:               # keyed by provider@model; placeholders until the live evaluation sets them
        jev@jev-1.13.0: { pass: 0.85, fail: 0.15 }
      # promotion:              # required before `mode: enforce` takes effect (section 8)
      #   jev@jev-1.13.0:
      #     path: corpus        # corpus | override
      #     n: 75
      #     actBandPrecision: 0.97
      #     evalReport: .ai-sdlc/judgment-evals/dor.stage-b-jev-1.13.0-2026-10-14.json
      #     evidence: ''        # required free text when path is override
```

The API key is read from `TYPESAFE_API_KEY` at call time, never from the file. In CI
it follows the existing job split (available to read-scope evaluation jobs, withheld
from write-scope jobs and from fork PRs) and is added to the sandbox sensitive-variable
list. `ai-sdlc init` ships a commented template under `.ai-sdlc/templates/`, and
`/ai-sdlc doctor` reports provider availability, the pinned version and any judgment
in `enforce` without an evaluation record.

### 7. Observability and cost

- **Judgment log:** `$ARTIFACTS_DIR/_judgment/log-YYYY-MM-DD.jsonl`, one record per
  evaluation: `{ts, judgmentId, version, questionSetHash, stateHash, modelVersion,
  mode, answers, thresholds, outcome, incumbent?, latencyMs, inputTokens, cacheHit,
  taskId?}`. `incumbent` is what the existing path decided, recorded in `shadow` so
  agreement can be computed. This is the first per-call latency record in the
  framework.
- **Cost:** every log record carries `costUsd`, computed from the provider's declared
  input rate. When the runtime is invoked from `orchestrator`, a sink also writes one
  `cost_ledger` row per uncached call using the RFC-0019 column-reuse convention
  (`pipelineType='judgmentTokens'`, `agentName=consumerLabel`,
  `model='jev@<version>'`). `DEFAULT_MODEL_COSTS` gains a Jev row, because
  `CostTracker.computeCost` currently prices any unknown model at Sonnet rates.
- **Events:** `JudgmentEscalated` and `JudgmentProviderUnavailable` are added to the
  orchestrator event types for the operator TUI.

### 8. Evaluation and promotion

`cli-judgment` provides:

- `doctor`: provider reachable, key valid, pinned version accepted.
- `ask <judgment-id> --input <file>`: one evaluation, printed with probabilities.
- `eval <judgment-id> --corpus <path>`: runs the judgment over a labelled corpus and
  reports agreement, the confusion matrix, precision of the `act` band at candidate
  thresholds, the share of items that land in each band, latency percentiles and cost.
- `replay --since <date>`: recomputes outcomes from logged answers under different
  thresholds without calling the provider.

Labelled corpora already exist for several judgments: the 75-fixture `spec/dor-corpus/`
and `_dor/calibration.jsonl` (DoR), `.ai-sdlc/classifier-corpus/<task-type>.yaml` with
operator overrides (substrate), `_classifier/calibration.jsonl` (review routing),
`_estimates/log.jsonl` (estimation), and `.ai-sdlc/_decisions/events.jsonl` with
`overridden` events (decisions). Shadow logging fills the rest.

Promotion of a judgment from `shadow` to `enforce` is operator-only: a config change in
a PR that cites the `eval` report. The bar depends on the judgment's `riskClass`
(OQ-4), following the two-path model of the existing DoR, estimation and Decision
Catalog promotion runbooks:

| `riskClass` | Corpus path | Operator-override path |
| --- | --- | --- |
| `seam` | n ≥ 50 labelled items, act-band precision ≥ 90% | Allowed, with the evidence the operator looked at recorded in the PR |
| `tighten` | n ≥ 50 labelled items, act-band precision ≥ 90% | Allowed, same condition |
| `relax` | n ≥ 50 rows from the AISDLC-616 findings ledger, act-band precision ≥ 95% | **Not allowed** |

"Act-band precision" is the share of items the judgment would have acted on, at the
proposed thresholds, where the labelled outcome agrees. For `review.reviewer-set` the
label is deliberately conservative: a ledger row disagrees with a merged-set selection
whenever the separate code reviewer or test reviewer recorded a critical or major
first-pass finding on that PR. The promotion record is written into the config next to
the thresholds, and the runtime refuses `enforce` without one (section 4). A change to
the pinned model version returns every `enforce` judgment to `shadow` until it is
re-evaluated against the new version.

### 9. Capability liveness

The failure this section prevents is recorded in Motivation: capabilities were built,
tested, reviewed and marked `Implemented`, and then ran their fallback path on every
invocation for months. The fail-open design was right (AISDLC-628: degrade, do not
block an adopter's core loop). What was missing is the other half of that principle:
**fail soft, never silently, and never count a fallback as done.**

**9.1 Capability registry.** A capability is an optional, usually model-backed,
function of the framework that has a defined fallback. Each one is declared once in
code (`reference/src/capabilities/`) with an `id`, a title, the RFC that specified it,
what its fallback does, and how to enable it. The initial registry covers the seams
verified in Motivation:

| Capability id | Specified by | Fallback today | Wired by |
| --- | --- | --- | --- |
| `classifier.capture-triage` | RFC-0024 | `pending` sentinel | AISDLC-634 |
| `classifier.capture-severity` | RFC-0024 | `pending` sentinel | AISDLC-634 |
| `classifier.pr-comment-is-capture` | RFC-0024 | `pending` sentinel | AISDLC-634 |
| `classifier.dor-answer-is-new-concern` | RFC-0024 | `pending` sentinel | AISDLC-634 |
| `decisions.stage-c-recommendation` | RFC-0035 | `pending` sentinel | AISDLC-634 |
| `decisions.stage-b-signals` | RFC-0035 | constants at 0.5 | AISDLC-635 |
| `dor.stage-b` | RFC-0011 | gates 4 and 6 `skip` | AISDLC-636 |
| `estimation.class-assignment` | RFC-0016 | title-prefix regex | AISDLC-635 |
| `estimation.stage-b` | RFC-0016 | Stage A verdict | none in this RFC |
| `sa.layer3` | RFC-0008 | no production client | none in this RFC |
| `review.meta-review` | `orchestrator/src/review-meta.ts` | hook not wired | none in this RFC |
| `policy.llm-evaluator` | reference policy | stub evaluator | none in this RFC |

The last four stay degraded after this RFC ships. Listing them is the point: they
become visible and owned instead of assumed. Every Judgment Catalog definition names
the capability it serves (`capabilityId`), so wiring a judgment is what moves a
capability out of `degraded`.

**9.2 Outcome reporting.** Each time a capability runs it reports one of three
outcomes:

- `live`: it produced its real result and the caller used it.
- `shadow`: it produced its real result and the caller did not use it.
- `degraded`: it took the fallback path. The reason is recorded (no backend
  configured, provider error, disabled by config, and so on).

Reports are counted in `$ARTIFACTS_DIR/_capabilities/state.json`: per capability, the
count of each outcome, first and last `live` timestamps, and the last `degraded`
timestamp and reason. A failed write is swallowed; reporting never changes the result
of the call it describes. A capability with no record at all is reported as
`never-observed`, which is treated as `degraded`.

**9.3 Repo declaration and enforcement (OQ-7).** A repo lists the capabilities it
expects to be live in `.ai-sdlc/capabilities.yaml` (`spec.required`), read from the
base branch only. The default is an empty list, so adopters see no change.

- `/ai-sdlc doctor` gains a `capability-liveness` check: a table of every registered
  capability with its last outcome and counts; `fail` for a required capability that
  is `degraded` or `never-observed`, `warn` for a required capability in `shadow`.
- The orchestrator tick files one Decision (RFC-0035) per required capability that is
  degraded, at most once per capability per day, never duplicating an open one, and
  emits a `CapabilityDegraded` event for the TUI.
- Nothing is blocked. No tick refuses to dispatch and no PR check fails because a
  capability is degraded (RFC-0035 G0; AISDLC-628).

**9.4 Lifecycle evidence (OQ-6).** RFC frontmatter gains `runtimeEvidence`, a list with
one entry per capability the RFC specifies:

```yaml
runtimeEvidence:
  - capability: dor.stage-b
    status: degraded            # live | shadow | degraded | not-applicable
    evidence: artifacts/_dor/calibration.jsonl (158 evaluations, all stage A)
    date: '2026-09-30'
    owner: AISDLC-636
```

- The lifecycle gate (`scripts/check-rfc-lifecycle-transitions.mjs`) refuses
  `Signed Off → Implemented` unless `runtimeEvidence` is present and every entry is
  `live` or `not-applicable`. An RFC with no optional capability declares an empty
  list. The existing audited operator override applies to this rule as to the others.
- The RFC linter prints a warning for every `Implemented` RFC that carries a
  `degraded` or `shadow` entry.
- The four RFCs already marked `Implemented` (RFC-0011, RFC-0016, RFC-0024, RFC-0035)
  keep their lifecycle and gain `runtimeEvidence` blocks recording their degraded
  capabilities and owning tasks. They are corrected to `live` by the live validation
  task as each capability is proven.

**9.5 Follow-ups are filed, not written.** The escape that caused this was a sentence
in a task's Final Summary ("the orchestrator should inject the adapter") that never
became a task. In a completed task's `### Follow-up` section, every item must cite a
tracked-work id, or the section must read `(none)`, or the item must start with
`declined:` and give a reason. The check runs in the pre-push chain on completed task
files in the push range and in the plugin's `task_complete` tool. It blocks, with the
`declined:` form as the explicit way to say no. Tasks completed before the gate lands
are not re-checked.

**9.6 Stub-in-production rule.** The dark-code gate (AISDLC-552) finds modules nobody
imports. It cannot see a module that is imported and receives a stub. A second rule in
the same script flags non-test source that imports a test double (a module or export
named as a fake, stub or mock) and requires an allowlist entry naming the capability
and the reason. Existing hits enter a baseline that may only shrink, as with dark
modules. This is a heuristic with a known blind spot: an interface with no
implementation at all (the classifier substrate's invoker) has nothing to import, so
it is caught by the registry and outcome reporting in 9.1 and 9.2, not by this rule.

## Design Details

### Schema Changes

- New: `spec/schemas/judgment-config.v1.schema.json` (`JudgmentConfig`), registered in
  the AJV loader and regenerated into `reference/src/core/generated-schemas.ts`.
- `spec/schemas/orchestrator-events.v1.schema.json`: three additive event types
  (the third is `CapabilityDegraded`).
- New: `spec/schemas/capabilities-config.v1.schema.json` (`CapabilitiesConfig`).
- `spec/schemas/rfc.schema.json`: optional `runtimeEvidence` list.
- No change to `pipeline.schema.json`, the verdict schema, the attestation envelope or
  any transcript leaf.

### Behavioral Changes

With no provider configured, no judgment behaviour changes. With a provider configured
and every judgment in `shadow`, the only changes are outbound calls for permitted
egress classes and new log records. Behaviour changes only for a judgment an operator
promotes to `enforce`.

Capability liveness (section 9) adds a state file, a doctor check and, for repos that
declare required capabilities, Decisions. It adds two gates that block: the follow-up
check on newly completed tasks, and the evidence requirement on promoting an RFC to
`Implemented`. Neither affects an adopter's pipeline run.

### Data Egress

Enabling the layer sends the `state` of each permitted judgment to a third-party API.
The provider documents that it does not train on customer requests; zero data retention
is an enterprise-plan feature. Accordingly:

- The layer is off unless `judgment-config.yaml` names a provider.
- `egress.allow` defaults to `work-item-text` (task and issue text, decision
  summaries, capture findings). `code-diff` and `agent-output` must be added
  explicitly.
- `buildState` output passes through `redactSecrets` (`SECRET_PATTERNS`, today in
  `pipeline-cli/src/dor/secret-redact.ts`) before it leaves the process. AISDLC-630 moves
  that module into `@ai-sdlc/reference` and re-exports it from its current path, since
  `reference` cannot import `pipeline-cli`.
- A declared compliance posture (RFC-0022) MAY forbid the layer or restrict its egress
  classes; the resolver honours the stricter setting.

### Migration Path

Additive. `AI_SDLC_CLASSIFIER_INVOKER_MODULE` keeps working and takes precedence over
the judgment bridge when set, so an adopter who wired their own invoker is unaffected.

## Backward Compatibility

Not a breaking change. No existing resource needs modification. Adopters who never
create `judgment-config.yaml` see no difference in behaviour, network traffic or cost.

## Alternatives Considered

### Alternative 1: Wire the dormant seams to a Haiku-class generative model

This is what RFC-0024 and RFC-0035 originally specified. It keeps one vendor. It was
not done in the months since those RFCs shipped, for the reasons in Motivation:
Agent-SDK-pool billing for calls made from deterministic code, prompt-and-parse
fragility, seconds of latency, and a confidence number that is a self-report. A
generative model is still reachable through the OpenAI-compatible adapter (OQ-5), in
`shadow`, and remains the escalation rung.

### Alternative 2: Make Jev an `AgentRunner` or `HarnessAdapter`

Rejected as the wrong shape. Both contracts are built around a worktree, a prompt and
free-text output; `HarnessAdapter` additionally requires a CLI binary and version
probe. The vendor states plainly that Jev is not a drop-in model for a coding agent.
`SecurityTriageRunner` and `ReviewAgentRunner` already show the cost of forcing a
judgment through the runner contract (a diff stuffed into `issueBody`, JSON returned in
`summary`).

### Alternative 3: Call Jev directly at each call site

Rejected. It scatters questions and thresholds across the tree, which is the one thing
the vendor guidance and this repo's own review practice both warn against, and it
binds the framework to one vendor in violation of the "adapters all the way down"
principle (RFC-0019 §14.4).

### Alternative 4: Let judgments reduce review from day one

RFC-0010 §12 already specifies a classifier that may skip reviewers, with a claimed
40 to 60 percent review-cost saving on small PRs. It is the largest direct saving
available. It is not adopted as written, because a wrong answer in the permissive
direction ships unreviewed code and the state (a diff) is attacker-influenced on
external work. OQ-1 adopts a bounded form instead: per-PR selection of the merged
reviewer set, on trusted work only, with security review always run and a corpus-only
promotion bar.

### Alternative 5: Do nothing until the provider matures

The vendor's JavaScript SDK had a breaking change four days after its first public
release and rate limits are documented as changing without notice. Waiting is
defensible. The design answers that risk structurally instead: a provider-neutral
interface, a thin HTTP adapter with no SDK dependency, abstain-to-incumbent on every
failure, and shadow mode as the default, so the framework never depends on the
provider being up or stable.

## Implementation Plan

Nineteen phase tasks. AISDLC-629 to AISDLC-640 are fully testable with recorded
fixtures and need no API key (AISDLC-632 ships a live contract test that is skipped
without one). AISDLC-641 is the first step that must run against the live API.

- **AISDLC-629 — provider interface and Jev adapter.** `reference/src/judgment/`
  types, registry, `FakeJudgmentProvider`, thin-`fetch` Jev adapter with typed errors,
  retry and timeout (OQ-3).
- **AISDLC-630 — runtime, catalog and config.** `JudgmentDefinition`,
  `evaluateJudgment` with the mode, egress, direction, `sourceKind` and
  promotion-record rules, `questionSetHash`, `JudgmentConfig` schema and
  base-branch-only loader with per-`(provider, model)` thresholds, `redactSecrets`
  moved into `reference`, init template (OQ-2, OQ-4). Depends on 629.
- **AISDLC-631 — observability.** Judgment log with latency and `costUsd`,
  content-addressed cache, cost-ledger sink and Jev pricing row, two event types, the
  `pipeline-cli` context builder, doctor check. Depends on 630.
- **AISDLC-632 — evaluation harness.** `cli-judgment doctor | ask | eval | replay`,
  promotion-record output (OQ-4), and the key-gated live contract test. Depends on 631.
- **AISDLC-633 — OpenAI-compatible adapter.** Shadow-only generative adapter (OQ-5).
  Depends on 630.
- **AISDLC-634 — substrate bridge.** Classifier-substrate bridge and the five
  substrate definitions. Depends on 631.
- **AISDLC-635 — decisions and estimation.** `decision.reversibility`,
  `decision.pillars`, `decision.duplicate`, `decision.stage-b-signals`,
  `estimate.class`. Depends on 631.
- **AISDLC-636 — `dor.stage-b`.** Judgment-first Stage B with subagent escalation.
  Depends on 631.
- **AISDLC-637 — agent-output gates.** `dev.ac-coverage` and
  `review.finding-grounding`, advisory. Depends on 631.
- **AISDLC-638 — review routing.** `review.routing` (tighten) and
  `review.reviewer-set` (relax, OQ-1). Depends on 631.
- **AISDLC-639 — remaining Group C.** `complexity.factors`, `failure.class`,
  `triage.injection-screen`. Depends on 631.
- **AISDLC-640 — docs.** Operator runbook, adopter opt-in guide, promotion runbook.
  Depends on 632.
- **AISDLC-641 — live validation and promotion soak.** Operator-only,
  non-dispatchable: run the contract test and evaluations with the live key, set
  thresholds, promote judgments one at a time. Depends on 632 to 639.

Capability liveness (section 9), added by the 2026-09-30 amendment. AISDLC-642,
AISDLC-645 and AISDLC-646 have no dependency on the judgment layer and can start
immediately.

- **AISDLC-642 — capability registry and outcome reporting.** Registry, the three
  outcomes, the state file. No dependencies.
- **AISDLC-643 — instrument the seams.** Report outcomes from every registered
  capability's call site and from the judgment runtime. Depends on 631 and 642.
- **AISDLC-644 — doctor check, repo declaration and Decisions.** `capability-liveness`
  doctor check, `.ai-sdlc/capabilities.yaml`, Decision filing, runbook (OQ-7).
  Depends on 643.
- **AISDLC-645 — follow-up gate.** Pre-push check and `task_complete` validation.
  No dependencies.
- **AISDLC-646 — stub-in-production rule.** Second rule in the dark-code gate with a
  shrink-only baseline. No dependencies.
- **AISDLC-647 — lifecycle evidence.** `runtimeEvidence` in the RFC schema, the
  `Signed Off → Implemented` rule, the linter warning, and the retroactive blocks on
  RFC-0011, RFC-0016, RFC-0024 and RFC-0035 (OQ-6). Depends on 642.

## Open Questions

**OQ-1 — May a judgment ever reduce scrutiny?** The draft made every judgment whose
state includes a diff or agent output `tighten-only`. The largest direct cost saving,
reducing reviewers on low-risk PRs per RFC-0010 §12, was therefore out of v1. Should v1
stay tighten-only for anything touching review, or define now the conditions under
which a promoted judgment may reduce review?

**Resolution (2026-09-30, full rubric): relaxation is allowed on trusted-`sourceKind`
work only, and in v1 is limited to per-PR selection of the merged two-reviewer set.**
Industry research: RFC-0010 §12 already specifies a reviewer-skipping classifier with
fail-open below 0.7 and a claimed 40 to 60 percent saving on small PRs; the provider
documents that content in the state can move an answer, and a diff is
attacker-influenced on external work; the provider's own confidence-routing pattern
scales thresholds with the risk of the action; RFC-0048 OQ-2 gates relaxation on
provenance, never on content. **Substrate surveyed:** AISDLC-617 shipped the opt-in
merged set (`correctness-reviewer` + `security-reviewer`, `reviewer-set.ts`), resolved
from the base branch and always preserving `security-reviewer`; AISDLC-616 shipped the
first-pass findings ledger that measures each reviewer's marginal value. **Refinement
over the draft:** a new `relax` risk class with one member, `review.reviewer-set`,
which turns 617's repo-wide opt-in into a per-PR choice. Floors: `security-reviewer`
always runs; nothing selects fewer reviewers than the merged set; a path-regex match
(auth, lockfile, CI) vetoes relaxation; untrusted work is tighten-only; finding
suppression stays out of scope (grounding is advisory). Promotion evidence is the 616
ledger (OQ-4). **Counter-argument:** "The operator's standing rule is three reviewers
on every PR; a classifier choosing two erodes it on the strength of a model nobody has
tested." Rebuttal: the merged set is already a sanctioned configuration being A/B'd
against the ledger; the judgment cannot go below it, cannot touch security review,
cannot act on untrusted work, and cannot be enabled without 50 ledger rows at 95
percent precision. **Selected over tighten-only (the author recommendation)** by
operator decision, to bring the review-cost saving into v1, **and over RFC-0010 §12 as
written** because that form is permissive on attacker-influenced diffs at an untested
threshold.

**OQ-2 — Data egress default.** When an adopter enables the layer, which content
classes leave the machine by default: work-item text only, work-item text plus code
diffs, or nothing until each class is listed?

**Resolution (2026-09-30, full rubric): naming a provider enables `work-item-text`
only; `code-diff` and `agent-output` must be listed in `egress.allow`.** Industry
research: the provider states it does not train on customer requests and offers zero
data retention on enterprise plans only; RFC-0045 set this repo's precedent of
consent-gated outbound data; diffs already reach Anthropic, and OpenAI when Codex
reviewers run, so code egress is not new in kind but this is a new processor.
**Refinement:** the init template ships the `egress.allow` line visibly with each class
commented; `redactSecrets` runs on all outbound state; a declared RFC-0022 compliance
posture may force the stricter nothing-until-listed behaviour; a local
OpenAI-compatible endpoint is not egress. This repo will list `code-diff`, because
`review.routing` and `review.reviewer-set` read diffs. **Counter-argument:** "Issue
text can hold customer names and incident detail, which can be more sensitive than
code; nothing-until-listed is the honest consent model." Rebuttal: true for some
adopters, and the compliance-posture hook covers them with one declared setting; for
the rest, a provider that is configured and silently inert is a support problem.
**Selected over nothing-until-listed** for that reason, **and over all-classes-on**
because sending source code to a new processor should be a deliberate act.

**OQ-3 — Packaging and the vendor SDK.** Thin `fetch` adapter inside
`@ai-sdlc/reference` with no new dependency, the vendor's `@typesafe-ai/sdk` as a
dependency, a new `@ai-sdlc/judgment` workspace package, or an adapter loaded from
`contrib/`?

**Resolution (2026-09-30, full rubric): interface, runtime and a thin `fetch` Jev
adapter in `reference/src/judgment/`; no vendor SDK dependency.** Industry research:
no package in this monorepo has an LLM SDK as a runtime dependency and providers are
called with global `fetch` (`HttpDepparseClient` is the pattern); `@typesafe-ai/sdk`
first shipped 2026-09-11 and had a breaking change on 2026-09-15; the API is one
endpoint with a small JSON body; `reference` is the only package both `pipeline-cli`
and `orchestrator` import. **Substrate surveyed:** the classifier substrate's existing
extension point is an env-var-loaded module, which is the mechanism that left it with
no production backend. **Refinement:** modules are re-exported from the `reference`
barrel so the dark-code gate sees them as reachable; the key-gated live contract test
(AISDLC-632) is the drift detector that replaces SDK-tracked types.
**Counter-argument:** "A hand-rolled client breaks silently when the vendor changes
the API; the SDK exists to absorb that." Rebuttal: the SDK is where the only breaking
change so far occurred; the contract test detects drift on our schedule; and any
client failure resolves to `abstain`, so breakage degrades to pre-RFC behaviour.
**Selected over the SDK dependency** because a pre-1.0 package in the governance trust
path is a worse bet than about 150 lines behind a contract test, **over a new
package** because its release plumbing buys nothing here, **and over a `contrib/`
module** because optional wiring is the failure this RFC exists to fix.

**OQ-4 — Promotion evidence bar.** What must an `eval` report show before a judgment
moves from `shadow` to `enforce`, does the bar differ by what a wrong answer costs, and
who may promote?

**Resolution (2026-09-30, full rubric): operator-only promotion by PR, with a bar
tiered by `riskClass`.** `seam` and `tighten` judgments promote by the corpus path
(n ≥ 50, act-band precision ≥ 90 percent) or by a documented operator-override path.
`relax` judgments are corpus-only: n ≥ 50 rows from the AISDLC-616 ledger and act-band
precision ≥ 95 percent, with no override path. Industry research: `dor-promotion.md`,
`estimation-promotion.md` and `decision-catalog-promotion.md` all use a corpus path
(n ≥ 50, n ≥ 50 at 95 percent, and n ≥ 30 at 80 percent respectively) plus an
operator-override path, and in practice DoR, deps composition, the orchestrator and
the Decision Catalog were promoted through the override path; the provider's guidance
is to set thresholds by plotting confidence against accuracy on your own data.
**Refinement over the draft:** the draft's "no bar for Group A" becomes the override
path for `seam`; a pinned-model change returns every `enforce` judgment to `shadow`;
thresholds and promotion records are keyed by `(provider, model)`.
**Counter-argument:** "Every earlier feature needed the override path because corpora
fill slowly; corpus-only for relaxation means it never ships." Rebuttal: the ledger
gains a row per reviewed PR and shadow mode labels each at no risk, so 50 rows is weeks
at this repo's merge rate; and relaxation is the one class where the misses are, by
definition, the ones nobody saw, which is where operator eyeballing is weakest.
**Selected over a uniform hybrid** because the override path is the default in practice
and must not be able to reduce review, **and over corpus-only for everything** because
rigor on reversible actions that currently return `pending` buys no safety.

**OQ-5 — A second provider in v1?** Should v1 also ship a generative-model adapter
behind the same interface so adopters without a typesafe.ai account get the same
judgments, or ship Jev only and leave the interface open?

**Resolution (2026-09-30, operator decision): v1 also ships a generic
OpenAI-compatible adapter, shadow-only.** The operator selected this over the rubric's
Jev-only recommendation: adoption is the current strategic focus, an adopter under a
no-new-processor policy otherwise gets nothing from this RFC, and local-model demand
already exists (AISDLC-622, Ollama). Industry research: RFC-0019 shipped its interface
with a single adapter; the repo already has OpenAI-compatible plumbing
(`GenericLLMRunner` presets); a generative model's confidence is a self-report, so
thresholds tuned on Jev do not transfer. **Semantics (load-bearing):** the adapter
declares `calibratedProbabilities: false`; every answer is validated against the
question's option set and any violation fails the call to `abstain`; all judgments on
this adapter run in `shadow` in v1 and promoting any of them is a separate operator
decision; thresholds are keyed by `(provider, model)` so nothing tuned on Jev is ever
applied to it. An Anthropic-specific adapter is not shipped, because calls from
deterministic code draw the Agent SDK credit pool. **Counter-argument (the rubric's):**
"A second adapter doubles the evaluation surface before the first provider is proven."
Mitigation: shadow-only means it adds log volume, not behaviour, and it shares every
definition, fixture and harness with the Jev path. **Selected over Jev-only** per
operator call.

**OQ-6 — Correcting the record for RFCs already marked `Implemented`.** RFC-0011,
RFC-0016, RFC-0024 and RFC-0035 are `lifecycle: Implemented`, and each specifies a
model-backed capability that has never run in this repository. Section 9.4 requires
evidence for future promotions. How should these four be corrected: annotate, roll
back, leave alone, or add a lifecycle state?

**Resolution (2026-09-30, full rubric): keep the lifecycle and annotate per
capability.** Each of the four gains a machine-checked `runtimeEvidence` block marking
every capability `live`, `shadow`, `degraded` or `not-applicable`, with the evidence
and the owning wiring task. Industry research: Kubernetes enhancement proposals
separate merged code from graduation and attach written graduation criteria that
include evidence of real use; this repo has rollback precedent (RFC-0024 was returned
to `Ready for Review` once); the DoR upstream gate accepts both `Signed Off` and
`Implemented`, so a rollback would block nothing. **Substrate surveyed:** in each of
the four the deterministic half is live and enforced (DoR Stage A alone stopped 68 of
158 logged evaluations); the lifecycle gate checks ladder order and has an audited
override, and asks for no runtime evidence; `rfc.schema.json` is
`additionalProperties: false`, so the new field needs a schema change before any RFC
can carry it. **Refinement:** the linter prints every `Implemented` RFC with a
non-live entry, doctor reports the same capabilities, and the live validation task
flips entries to `live` as each is proven. **Counter-argument:** "An annotation nobody
reads is how this happened; the lifecycle field is what people and tools look at, so
that is the field that must not lie." Rebuttal: this annotation is read by code on
every lint and every doctor run, and a rollback would label DoR as not implemented
when its deterministic half is the most-used gate in the pipeline. **Selected over
rollback** because per-capability status is more accurate than one flag, **over
forward-only** because a known-wrong record should be corrected, **and over a new
lifecycle state** because that changes four tools to express what one frontmatter
block can.

**OQ-7 — Enforcement when a required capability is degraded.** A repo declares the
capabilities it expects to be live. When one reports `degraded`, what happens: a
warning, a Decision, a hard block, or holding only the dependent step?

**Resolution (2026-09-30, full rubric): doctor reports `fail` and the orchestrator
tick files a Decision; nothing is blocked.** One Decision per degraded required
capability, at most daily, never duplicating an open one, plus a `CapabilityDegraded`
event. Industry research: RFC-0035 G0 forbids pipeline-halting events and routes
everything through Decisions with a timebox and a default on silence; the 0.21.0
adopter-brick post-mortem (AISDLC-628) recorded that a gate protecting an artifact
must not block the core loop; Kubernetes separates readiness from liveness, reporting
a not-ready component without killing it; CI cannot prove liveness because that needs
the provider key and a real call. **Refinement:** the hard stop lives where it is
cheap, in section 9.4: an RFC cannot be promoted to `Implemented` with a degraded
capability. `spec.required` defaults to empty, so adopters are unaffected.
**Counter-argument:** "A Decision that can be ignored recreates the silence; only a
block guarantees someone looks." Rebuttal: the Decision is filed automatically,
carries a timebox and sits beside a failing doctor check, so ignoring it is a visible
act; a block would make this repo's throughput depend on a third party's uptime,
which is the adopter-brick failure in a new place. **Selected over fail-closed per
step** because with DoR in the path that halts admission on every provider outage,
**over a hard block** for the same reason at larger scale, **and over a warning
only** because that is today's behaviour.

## References

- Provider documentation, read 2026-09-30: <https://docs.typesafe.ai/introduction>,
  `/api`, `/models`, `/confidence`, `/concepts/how-to-build-with-system-one`,
  `/model-jaggedness/jev-1.13`, `/patterns/*`, `/cookbooks/{citation_check,
  llm_guardrails, sde_cascade, parallel_questions, consistency_noul_cookbook}`.
- Dormant seams: `pipeline-cli/src/classifier/substrate/{types,classify,config}.ts`,
  `pipeline-cli/src/capture/invoker-loader.ts`, `pipeline-cli/src/decisions/stage-b.ts`,
  `orchestrator/src/policy-evaluators.ts`, `reference/src/policy/llm-evaluator.ts`,
  `orchestrator/src/sa-scoring/layer3-llm.ts`, `pipeline-cli/src/estimation/stage-b.ts`,
  `orchestrator/src/review-meta.ts`.
- Heuristics: `pipeline-cli/src/estimation/class-assignment.ts`,
  `pipeline-cli/src/decisions/stage-a.ts`, `orchestrator/src/admission-score.ts`,
  `pipeline-cli/src/classifier/classifier.ts`, `reference/src/policy/complexity.ts`.
- Patterns reused: `orchestrator/src/embedding/{types,registry}.ts` (adapter and
  registry), `orchestrator/src/sa-scoring/depparse-client.ts` (HTTP client),
  `orchestrator/src/cost-tracker.ts` and `orchestrator/src/defaults.ts` (cost).
- [[RFC-0029]] Principle 2 (deterministic-first); [[RFC-0011]] §4.4 (Stage A / Stage B);
  [[RFC-0024]] and [[RFC-0035]] (classifier substrate, decision ladder);
  [[RFC-0019]] (adapter pattern, §14.3); [[RFC-0010]] §12 (review classifier);
  [[RFC-0042]], [[RFC-0046]], [[RFC-0047]] (attestation, unchanged);
  [[RFC-0043]] (untrusted input, verdict contract); [[RFC-0048]] (`sourceKind`,
  base-branch-only config); [[RFC-0004]] (cost attribution).
- Capability liveness: `scripts/check-dark-code.mjs` (AISDLC-552),
  `scripts/check-rfc-lifecycle-transitions.mjs`,
  `docs/operations/fail-soft-at-the-adopter-boundary.md` (AISDLC-628),
  `orchestrator/src/cli/commands/doctor-checks.ts`,
  `ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts`; [[RFC-0025]] (framework
  quality monitoring); AISDLC-289 (the follow-up that was never filed).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (provider-neutral layer behind one runtime contract; abstain always means pre-RFC behaviour; promotion bars enforced in code; attestation untouched; 2026-09-30) |
| Operator | Dominique Legault | ✅ Signed (gives the unwired judgment seams a backend and measures each one before it acts; review relaxation bounded to trusted work with security review always run; 2026-09-30) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-30 | Initial Draft. Problem decomposition, provider interface, Judgment Catalog, runtime contract, integration surfaces, 5 Open Questions. Trigger: typesafe.ai platform access; API key pending. |
| 2026-09-30 | **Draft → Ready for Review.** All 5 OQs resolved via operator rubric walkthrough: (1) relaxation on trusted work, bounded to per-PR selection of the AISDLC-617 merged reviewer set with security always run (operator override of the tighten-only recommendation); (2) `work-item-text` egress by default, other classes explicit; (3) thin `fetch` adapter in `reference`, no vendor SDK; (4) promotion tiered by `riskClass`, relax-class corpus-only against the AISDLC-616 ledger; (5) generic OpenAI-compatible adapter added, shadow-only (operator override of the Jev-only recommendation). Added `riskClass`, `calibratedProbabilities`, `(provider, model)`-keyed thresholds, the `review.reviewer-set` judgment; `complexity.factors` narrowed to tighten-only. Phase plan reconciled to AISDLC-629 to AISDLC-641. |
| 2026-09-30 | **Ready for Review → Signed Off** (Engineering + Operator). Added runtime evidence that the classifier substrate, DoR Stage B and Decision Catalog Stage C have never produced a model-backed answer in this repository, with the documented cause (AISDLC-321/275 dependency constraint; AISDLC-289 follow-up never filed); `dor.stage-b` specified for the no-spawner path. Phase tasks AISDLC-629 to AISDLC-641 dispatchable (641 operator-only). |
| 2026-09-30 | **Amendment (lifecycle unchanged, sign-off confirmed by operator for the extension).** Added section 9, capability liveness: registry and `live` / `shadow` / `degraded` outcome reporting, doctor check and Decisions for required capabilities, `runtimeEvidence` and the `Signed Off → Implemented` evidence rule, the follow-up gate, and the stub-in-production rule. OQ-6 (annotate the four `Implemented` RFCs per capability) and OQ-7 (doctor fail plus Decision, nothing blocked) resolved via operator rubric. Phase tasks AISDLC-642 to AISDLC-647 added; RFC-0049 had merged as #1094 before this amendment. |
