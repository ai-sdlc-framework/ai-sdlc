---
id: AISDLC-321
title: 'feat: RFC-0024 Refit Phase 2 — Shared classifier substrate (Haiku + 0.7 threshold + calibration corpus)'
status: Done
assignee: []
created_date: '2026-05-15'
updated_date: '2026-05-24'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-2
  - critical-path-rfc-0035
  - classifier-keystone
dependencies:
  - AISDLC-320
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
blocked:
  reason: "RFC-0024 lifecycle is intentionally rolled back to `Ready for Review` per its §15 status note — all 12 OQs carry 2026-05-15 `Resolution:` markers; the rollback is explicitly so the AISDLC-320/321 + 275-278 Refit work can flip it back to `Implemented` after Phase 6 (AISDLC-278). Operator-acknowledged."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 2 — the keystone task. Ships the shared classifier substrate that OQ-2 (auto-triage), OQ-3 (PR-comment auto-classify), OQ-5 (severity inference), OQ-11 (DoR-clarification classifier), and RFC-0035 Phase 5 (Stage C LLM classifier) all compose on.

## Why a shared substrate

The 2026-05-15 OQ revisions converged on a single architectural pattern: Haiku-class LLM classifier + 0.7 confidence threshold + shared calibration corpus + auto-apply-with-override-window. Implementing this once at the framework level prevents 4-5 duplicate classifier pipelines and gives the calibration loop a single corpus to learn from.

## Scope

- `pipeline-cli/src/classifier/` package with public API: `classify(input, taskType, opts) → { classification, confidence, reasoning }`
- Haiku-class model invocation (configurable per-org: which model, which provider)
- 0.7 confidence threshold default; per-call override allowed; per-org default configurable via `capture-config.yaml` and `decisions-config.yaml`
- Calibration corpus aggregator: `cli-classifier corpus aggregate` emits the aggregated training corpus.
- Operator-override capture: when operator overrides an auto-classification within the override window, that becomes a negative exemplar in the corpus.
- Silence-as-positive-exemplar: no override within window → positive exemplar promoted to corpus.
- Multi-task-type support: same substrate serves capture-triage / capture-severity / pr-comment-is-capture / dor-answer-is-new-concern / decision-recommendation (RFC-0035) — each with its own task-type prompt template.
- Subscription cost tracking via SubscriptionLedger (RFC-0010).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `pipeline-cli/src/classifier/` package ships with `classify()` public API
- [x] #2 Haiku-class model invocation (configurable per-org)
- [x] #3 0.7 confidence threshold default; per-call override + per-org config respected
- [x] #4 Calibration corpus written to `.ai-sdlc/classifier-corpus/<task-type>.yaml` (per-task-type)
- [x] #5 `cli-classifier corpus aggregate` emits the aggregated training corpus
- [x] #6 Operator-override capture writes negative exemplar to corpus
- [x] #7 Silence-as-positive-exemplar: no override within window → positive exemplar
- [x] #8 Multi-task-type support documented (capture-triage / capture-severity / pr-comment-is-capture / dor-answer-is-new-concern / decision-recommendation)
- [x] #9 Subscription cost tracked via SubscriptionLedger; default cap per-org configurable
- [x] #10 Public API documented for downstream consumers (OQ-2/3/5/11 + RFC-0035 P5)
<!-- AC:END -->

## Final Summary

### Summary
Shipped the framework-level shared classifier substrate that the 2026-05-15 OQ revisions converged on. One Haiku-class invoker, one 0.7 threshold, one per-task-type calibration corpus, one operator-override capture path, one CLI — serving OQ-2 (capture-triage), OQ-3 (PR-comment-is-capture), OQ-5 (capture-severity), OQ-11 (dor-answer-is-new-concern), and RFC-0035 Stage C (decision-recommendation). Substrate is harness-agnostic via the `LlmInvoker` interface (mirrors RFC-0012 `SubagentSpawner`); production wires an Anthropic Haiku adapter; tests inject `FakeLlmInvoker`.

### Changes
- `pipeline-cli/src/classifier/substrate/types.ts` (new): public type surface — `ClassifierInput` / `ClassifierDecision` / `ClassifierTaskType` / `ClassifyOpts` / `LlmInvoker` / `CalibrationCorpusEntry` / `SubscriptionLedgerEntry`.
- `pipeline-cli/src/classifier/substrate/task-prompts.ts` (new): per-task-type prompt templates + allowed-classification validator.
- `pipeline-cli/src/classifier/substrate/config.ts` (new): per-org config loader; reads `.ai-sdlc/capture-config.yaml` (capture/PR/DoR task types) and `.ai-sdlc/decisions-config.yaml` (decision-recommendation). Defaults: 0.7 threshold, `claude-haiku-4-5` model, 1M daily token cap.
- `pipeline-cli/src/classifier/substrate/corpus.ts` (new): per-task-type YAML corpus storage; atomic rename-after-write.
- `pipeline-cli/src/classifier/substrate/override.ts` (new): `recordOperatorOverride()` (AC-6) + `resolveSilenceAsPositive()` (AC-7) + window helper.
- `pipeline-cli/src/classifier/substrate/classify.ts` (new): public `classify()` API; fall-open semantics on every failure mode.
- `pipeline-cli/src/classifier/substrate/fake-invoker.ts` (new): test-only scripted invoker.
- `pipeline-cli/src/classifier/substrate/index.ts` (new): substrate barrel.
- `pipeline-cli/src/cli/classifier.ts` (new): `cli-classifier corpus {aggregate, stats, resolve-silence}`.
- `pipeline-cli/bin/cli-classifier.mjs` (new): bin shim.
- `pipeline-cli/docs/classifier-substrate.md` (new): public-API reference + downstream-wiring guide.
- `pipeline-cli/src/classifier/index.ts` (modified): re-export substrate as `substrate` namespace (avoids name clash with the conditional-review classifier's `ClassifierDecision` / `ClassifierOutput`).
- `pipeline-cli/package.json` (modified): added `cli-classifier` bin entry.
- 5 new test suites covering 70 tests (types/prompts/config/corpus/override/classify + CLI).

### Design decisions
- **Namespaced substrate** under `pipeline-cli/src/classifier/substrate/`, re-exported as `substrate` from `@ai-sdlc/pipeline-cli/classifier`. The existing conditional-review classifier (RFC-0010 §12) and budget classifier export distinct types that share names with substrate types (`ClassifierDecision`, `ClassifierOutput`); a flat re-export would conflict. The namespace makes the discoverability boundary obvious: "everything classifier-shaped lives under `@ai-sdlc/pipeline-cli/classifier`; the framework-level shared classifier is `.substrate.*`".
- **Harness-agnostic via `LlmInvoker`** (one-method interface; mirrors `SubagentSpawner`). Pipeline-cli has no `@anthropic-ai/sdk` dependency; production callers wire the real adapter; tests inject `FakeLlmInvoker`. This keeps the substrate hermetic, easily portable across harnesses (Codex / Claude SDK / Anthropic API / mock), and the SubagentSpawner pattern is already familiar to operators.
- **Fall-open semantics on every failure mode**. Invoker throws → `pending` sentinel + confidence 0. LLM returns invalid JSON → same. Disallowed classification → same. Substrate `classify()` never throws. The fall-open default routes the work to the human (the safe failure mode for a classifier whose customers gate auto-apply on confidence ≥ threshold).
- **Per-task-type corpus segmentation** (one YAML per task type). A capture-triage exemplar doesn't help a decision-recommendation classifier; segmenting avoids cross-contamination + lets per-task calibration loops run independently. YAML over JSONL because operators read these files during calibration walkthroughs, and at the target volumes (~thousands per task type) full-file rewrites are cheap.
- **Operator-override window default = 24h** (matches RFC-0035's `overrideWindowHours` to keep one timeout in operators' heads). Configurable per-org via `classifier.overrideWindowHours` in capture-config.yaml. Per-task-type overrides intentionally NOT supported in v1 — adds config surface for marginal payoff; we'll add it if corpus data shows a per-task need.
- **`dailyTokenCap` is audit-only** (surfaces via ledger writer; substrate does NOT enforce). Hard caps would silently drop classifications and contaminate the corpus; enforcement belongs in the harness adapter layer where retry/throttle policies live.
- **No prompt YAML asset**: prompts live in TypeScript next to the parser they feed. A YAML asset would let operators drift prompts away from the substrate's parser expectations. Per-org tuning is via threshold + model overrides, not raw prompt edits.

### Verification
- `pnpm build` — clean across the workspace
- `pnpm test` — pipeline-cli: 252 test files, all green; substrate adds 6 test files / 70 tests; whole workspace green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `node pipeline-cli/bin/cli-classifier.mjs corpus aggregate --format table` — smoke-tested manually against an empty corpus

### Follow-up
- AISDLC-275/276/277: per-surface wiring of OQ-2/3/5/11 into the substrate (RFC-0024 Refit Phases 3-5).
- AISDLC-289: RFC-0035 Stage C wiring of the `decision-recommendation` task type.
- An Anthropic Haiku adapter implementing `LlmInvoker` — ships in a downstream consumer module so pipeline-cli stays SDK-free.
- Once the OQ-3 PR-comment surface lands (AISDLC-276), the substrate's per-task ALLOWED_CLASSIFICATIONS for `pr-comment-is-capture` may grow a tertiary value if the corpus shows operators want "needs-discussion" as a distinct outcome from "is-capture | not-capture".
