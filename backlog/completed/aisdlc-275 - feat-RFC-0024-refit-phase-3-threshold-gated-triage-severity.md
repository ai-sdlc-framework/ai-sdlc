---
id: AISDLC-275
title: 'feat: RFC-0024 Refit Phase 3 — Threshold-gated triage + severity (OQ-2 + OQ-5)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-15'
updated_date: '2026-05-24'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-3
  - critical-path-rfc-0035
dependencies:
  - AISDLC-321
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: high
blocked:
  reason: "RFC-0024 lifecycle is intentionally rolled back to `Ready for Review` per its §15 status note — all 12 OQs carry 2026-05-15 `Resolution:` markers; the rollback is explicitly so the AISDLC-320/321 + 275-278 Refit work can flip it back to `Implemented` after Phase 6 (AISDLC-278). Operator-acknowledged."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 3. Wires the Phase 2 classifier substrate into the capture triage and severity-inference paths (OQ-2 + OQ-5).

## Scope (OQ-2 threshold-gated triage)

- AI-agent-filed captures get auto-triaged via classifier with confidence score.
- High-confidence (≥ threshold): triage auto-applied; auto-submitted to team-shared per OQ-1.
- Low-confidence (< threshold): `triage: pending`, draft state, surfaces in operator review queue.
- Per-agent threshold override allowed (e.g., security-reviewer stricter, code-reviewer looser).
- TUI "AI auto-triaged this; confirm?" badge for high-confidence cases (Phase 8 surfaces this).

## Scope (OQ-5 threshold-gated severity)

- Capture writer auto-infers severity via classifier with same shared threshold.
- High-confidence: severity auto-set with "AI suggested" badge.
- Low-confidence: severity stays `unknown` until operator sets at triage time.
- Per §15.1 lifecycle defaults: `severity: unknown` auto-classifies via classifier after 14d (per-org configurable; Phase 6 implements the timebox).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 AI-agent captures auto-triaged via Phase 2 classifier
- [x] #2 High-confidence triage auto-applied; auto-submit per OQ-1
- [x] #3 Low-confidence stays `triage: pending` in draft state
- [x] #4 Per-agent threshold override read from agent role config
- [x] #5 Severity auto-inferred when confidence ≥ threshold; `unknown` otherwise
- [x] #6 Operator override of auto-triage / auto-severity emits negative exemplar
- [x] #7 Integration test: confidence > threshold path + confidence < threshold path
<!-- AC:END -->

## Final Summary

### Summary
Shipped RFC-0024 Refit Phase 3 — the capture-side wiring of the AISDLC-321 shared classifier substrate. AI-agent captures filed via `cli-capture file --json '{"autoClassify":true,...}'` now run the finding through the substrate's `capture-triage` + `capture-severity` task types, gated on the per-org / per-task / per-agent confidence threshold (default 0.7). High-confidence results auto-apply the recommendation and auto-submit the capture to team-shared (`backlog/captures/`); low-confidence results keep the pending-sentinel triage value and `severity: unknown` in draft state (`.ai-sdlc/captures-drafts/`) for operator review. The substrate's calibration-corpus entry IDs are stashed in the `captured` audit entry so a later operator override flips the corpus row's polarity to `negative` (AC-6's negative-exemplar signal feeds the calibration loop).

### Changes
- `pipeline-cli/src/classifier/substrate/config.ts` (modified): added `perAgentRole` to `ClassifierConfigBlock`; new `agentRole` parameter on `loadSubstrateConfig()` with resolution order `per-agent > per-task > global > default`. (AC-4 substrate plumbing.)
- `pipeline-cli/src/classifier/substrate/types.ts` (modified): added `agentRole` to `ClassifyOpts` so callers can request per-agent threshold lookup.
- `pipeline-cli/src/classifier/substrate/classify.ts` (modified): threads `opts.agentRole` through to `loadSubstrateConfig` so the resolved threshold honors the per-agent override.
- `pipeline-cli/src/capture/auto-triage.ts` (new): public `autoTriageCapture()` + `autoInferSeverity()` (AC-1 / AC-5); substrate↔capture taxonomy bridges (`mapTriageClassification` / `mapSeverityClassification` + reverse mappings); audit-trail decoration helpers (`decorateCapturedAuditEntry` / `extractCorpusEntryIds`); `recordTriageOverride` / `recordSeverityOverride` thin wrappers around the substrate's `recordOperatorOverride` (AC-6); `previewEffectiveThreshold` for TUI badge rendering.
- `pipeline-cli/src/capture/auto-triage.test.ts` (new): 28 tests covering taxonomy mapping (pure), confidence > threshold (AC-1/AC-2/AC-7), confidence < threshold + fall-open (AC-3/AC-7), per-agent threshold (AC-4), severity auto-infer (AC-5), audit-trail decoration, operator override → negative exemplar (AC-6).
- `pipeline-cli/src/capture/invoker-loader.ts` (new): `loadConfiguredInvoker()` — dynamic-import + duck-type-check helper that resolves an `LlmInvoker` from the operator-supplied `AI_SDLC_CLASSIFIER_INVOKER_MODULE` path. Per-process cached; falls open silently on every failure mode so the CLI keeps working without a configured invoker.
- `pipeline-cli/src/capture/invoker-loader.test.ts` (new): 7 tests covering env-var unset, missing module, default export, named `invoker` export, bad shape, caching, relative-path resolution.
- `pipeline-cli/src/capture/index.ts` (modified): re-exports auto-triage + invoker-loader from the capture barrel.
- `pipeline-cli/src/classifier/substrate/config.test.ts` (modified): 4 new tests for per-agent threshold (precedence, fallback to global, clamping, no perAgentRole block).
- `pipeline-cli/src/cli/capture.ts` (modified): the `file --json` AI-agent path now honors `autoClassify: true` — when set AND `AI_SDLC_CLASSIFIER_INVOKER_MODULE` resolves an invoker, runs auto-triage + auto-severity for unset/`unknown` fields, applies the recommendation when `metBehindThreshold`, stashes corpus IDs + confidence + `triageAutoApplied`/`severityAutoApplied` flags in the captured audit entry, and routes to submitted vs draft based on EITHER the legacy `confidence` field OR a successful auto-classification (AC-1, AC-2, AC-3, AC-5).

### Design decisions
- **Substrate↔capture taxonomy bridge lives in `capture/`, not in the substrate.** The substrate is task-type-agnostic by contract (AISDLC-321 design); coupling it to one particular task's enum domain would break the harness-portability story. The bridge is a capture-specific concern, so `auto-triage.ts` lives next to `capture-writer.ts`. `won't-fix` maps to `not-actionable` per RFC-0024 §7. `framework-bug` is intentionally NOT producible from auto-classification — that label needs judgement-quality the operator/orchestrator owns, not Haiku.
- **Per-agent threshold lives in `capture-config.yaml` (`classifier.perAgentRole[<role>].threshold`), not in `agent-role.yaml`.** Two reasons: (1) `agent-role.yaml` is the framework-wide agent contract (tools, blocked paths, constraints) — adding a classifier-tuning sub-schema there couples two concerns. (2) The threshold is a capture-pipeline tuning knob, so it belongs in the capture-config block where operators already tune `autoSubmitThreshold` and where the substrate's `loadSubstrateConfig` already reads. The resolution order — per-call > per-agent > per-task > global > default — is documented in the substrate's config docstring and tested explicitly.
- **`AI_SDLC_CLASSIFIER_INVOKER_MODULE` env shim instead of a static dependency.** Pipeline-cli MUST NOT depend on `@anthropic-ai/sdk` (same constraint AISDLC-321 imposed on the substrate). The env-var shim lets operators wire whatever invoker fits their harness (Anthropic SDK, Vertex, mock) without amending pipeline-cli — direct mirror of how the substrate's `LlmInvoker` interface decouples the call surface from any specific provider. When the env is unset or the module doesn't load, every code path silently falls back to the existing pre-auto-classify behavior (capture filed with the pending-sentinel triage and `severity: unknown` in draft) — zero regression risk on operators who don't opt in.
- **Audit-trail decoration (`triageCorpusEntryId`, `severityCorpusEntryId`, `triageConfidence`, `severityConfidence`, `triageAutoApplied`, `severityAutoApplied`) instead of new persistent schema fields.** `AuditEntry` already has an open `[key: string]: unknown` extension surface for exactly this kind of derived/audit metadata. Adding top-level capture-record fields would require a schema-version bump (`v1` → `v2`) and migration of every existing capture — heavyweight for what's effectively per-event signal. The decoration is observable to downstream consumers (`extractCorpusEntryIds()` is the canonical reader) and rendered visible in the JSON output for operator debugging.
- **`recordTriageOverride` is library-only in Phase 3.** Wiring it into the legacy `cli-capture triage` subcommand was out of scope — that subcommand operates on legacy JSONL captures in `_captures/`, while the auto-classify flow stores captures as `.md` files. The TUI triage flow (Phase 5 / RFC-0023 Blockers pane) is the natural consumer for the override capture, matching the §15 implementation-status note that "TUI triage keystrokes depend on RFC-0023 Blockers pane interactive layer".
- **No new RFC `**Resolution:**` markers.** Per `feedback_no_agent_scope_creep.md` + CLAUDE.md "OQ-resolution prohibition" — all 12 OQs in RFC-0024 are already operator-resolved (2026-05-15 walkthrough). This task implements the resolutions; it does not change them.

### Verification
- `pnpm build` — clean across the workspace
- `pnpm test` — pipeline-cli 266 test files / 5035 tests / 1 skipped (48 new tests for AISDLC-275); whole workspace green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Manual smoke: `AI_SDLC_EMERGENT_CAPTURE=1 AI_SDLC_CLASSIFIER_INVOKER_MODULE=<fake.mjs> cli-capture file _ --json '{"finding":"x","agentRole":"code-reviewer","autoClassify":true}'` correctly applies `triage:quick-fix` + `severity:suggestion`, writes to `backlog/captures/`, stashes corpus IDs in audit entry, appends pending corpus row.

### Follow-up
- AISDLC-276: RFC-0024 Refit Phase 4 — the `pr-comment-is-capture` (OQ-3) + `dor-answer-is-new-concern` (OQ-11) wiring. Will reuse the same `loadConfiguredInvoker` shim.
- AISDLC-277/278: subsequent Refit phases (TUI surfaces + lifecycle timeboxes per §15.1).
- The legacy `cli-capture triage` subcommand could be extended to invoke `recordTriageOverride` when overriding an auto-classified capture — currently it only handles legacy JSONL captures. Out of scope here; would compose naturally with the TUI flow in Phase 5.
